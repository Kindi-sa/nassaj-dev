#!/usr/bin/env bash
#
# T-821 shadow harness — bring up an ISOLATED copy of the real built server + the
# standalone supervisor on a temp port/DB/state, flag ON. Links the OWNER's
# per-user config dir (under the temp home) by SYMLINK to the REAL owner tree so
# claude authenticates from the live token (the T-820 stale-copy limitation lifted
# — see _env.sh). Verifies at boot, FROM THE PROCESS, that the effective DB is the
# temp one. Nothing here touches the live process, the live DB, or another user.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/_env.sh"

log() { printf '[shadow-up] %s\n' "$*"; }
die() { printf '[shadow-up][FATAL] %s\n' "$*" >&2; exit 1; }

"$HERE/shadow-down.sh" --quiet || true
rm -rf "$SHADOW_ROOT"
mkdir -p "$SHADOW_HOME" "$SHADOW_STATE" "$SHADOW_LOGS" "$SHADOW_RUN" "$SHADOW_TRANSCRIPTS"

# preflight: port free
if curl -s -o /dev/null -m 1 "http://127.0.0.1:$SHADOW_PORT/" 2>/dev/null; then
  die "port $SHADOW_PORT already in use — pick another SHADOW_PORT"
fi

# real owner credential must exist (we symlink to it, never copy).
[ -e "$REAL_CLAUDE_CREDS" ] || die "owner credential not found at $REAL_CLAUDE_CREDS"

# snapshot real-state fingerprints (zero-touch assertion baseline).
{
  echo "creds_sha=$(sha256sum "$REAL_CLAUDE_CREDS" 2>/dev/null | awk '{print $1}')"
  echo "creds_mtime=$(stat -c %Y "$REAL_CLAUDE_CREDS" 2>/dev/null || echo NA)"
  echo "live_db_sha=$(sha256sum "$REAL_LIVE_DB" 2>/dev/null | awk '{print $1}')"
  echo "live_db_mtime=$(stat -c %Y "$REAL_LIVE_DB" 2>/dev/null || echo NA)"
  echo "nassaj_users_list=$(ls -1 "$REAL_NASSAJ_USERS" 2>/dev/null | sort | tr '\n' ',')"
  echo "shared_projects_mtime=$(stat -c %Y "$REAL_SHARED_PROJECTS" 2>/dev/null || echo NA)"
} > "$SHADOW_RUN/pre-fingerprint.env"
log "recorded real-state fingerprint → $SHADOW_RUN/pre-fingerprint.env"

# base-home .claude symlink (fallback for any base-env resolve; the app resolves
# per-user, so this is only belt-and-suspenders).
ln -sfn "$REAL_OWNER_CLAUDE" "$SHADOW_HOME/.claude"

# seed the temp DB (owner + stranger + owned project).
PROJECT_PATH="$SHADOW_ROOT/proj"
mkdir -p "$PROJECT_PATH"
SEED_JSON="$(env $(shadow_env_common) DB_INDEX="$DB_INDEX" "$NODE_BIN" "$HERE/seed-db.mjs" "$PROJECT_PATH")" \
  || die "seed-db failed: $SEED_JSON"
log "seed: $SEED_JSON"
OWNER_ID="$(printf '%s' "$SEED_JSON"   | sed -n 's/.*"ownerId":\([0-9]*\).*/\1/p')"
STRANGER_ID="$(printf '%s' "$SEED_JSON" | sed -n 's/.*"strangerId":\([0-9]*\).*/\1/p')"
SEED_DB_PATH="$(printf '%s' "$SEED_JSON" | sed -n 's/.*"effectiveDbPath":"\([^"]*\)".*/\1/p')"
[ -n "$OWNER_ID" ] && [ -n "$STRANGER_ID" ] || die "could not parse seeded ids"
[ "$SEED_DB_PATH" = "$SHADOW_DB" ] || die "seed resolved DB=$SEED_DB_PATH, expected $SHADOW_DB"

# LINK the owner per-user config dir to the REAL owner tree (the OAuth fix).
mkdir -p "$SHADOW_HOME/.nassaj-users/$OWNER_ID"
chmod 700 "$SHADOW_HOME/.nassaj-users/$OWNER_ID"
ln -sfn "$REAL_OWNER_CLAUDE" "$SHADOW_HOME/.nassaj-users/$OWNER_ID/.claude"
log "linked owner cfg: $SHADOW_HOME/.nassaj-users/$OWNER_ID/.claude → $REAL_OWNER_CLAUDE"

# start the shadow SERVER (flag ON). SERVER_PORT (not PORT) is what it reads.
nohup env $(shadow_env_common) SERVER_PORT="$SHADOW_PORT" \
  "$NODE_BIN" "$SERVER_ENTRY" > "$SHADOW_LOGS/server.log" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$SHADOW_RUN/server.pid"
log "server pid=$SERVER_PID (log: $SHADOW_LOGS/server.log)"

ready=""
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE_URL/api/auth/status" 2>/dev/null || echo 000)"
  if [ "$code" != "000" ]; then ready=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -n 30 "$SHADOW_LOGS/server.log" >&2; die "server exited during boot"; }
  sleep 0.5
done
[ -n "$ready" ] || { tail -n 30 "$SHADOW_LOGS/server.log" >&2; die "server did not become ready"; }
log "server ready on $BASE_URL"

# VERIFY DB ISOLATION from the process itself (do not trust inheritance).
PROC_DB="$(tr '\0' '\n' < "/proc/$SERVER_PID/environ" 2>/dev/null | sed -n 's/^DATABASE_PATH=//p')"
[ "$PROC_DB" = "$SHADOW_DB" ] || die "server DATABASE_PATH is NOT the temp DB (got: $PROC_DB) — .env trap!"
log "DB isolation confirmed: effective DB = $SHADOW_DB"

# start the standalone SUPERVISOR (flag ON).
nohup env $(shadow_env_common) \
  "$NODE_BIN" "$SUPERVISOR_ENTRY" > "$SHADOW_LOGS/supervisor.log" 2>&1 < /dev/null &
SUPERVISOR_PID=$!
echo "$SUPERVISOR_PID" > "$SHADOW_RUN/supervisor.pid"
sleep 0.6
kill -0 "$SUPERVISOR_PID" 2>/dev/null || { tail -n 20 "$SHADOW_LOGS/supervisor.log" >&2; die "supervisor exited"; }
log "supervisor pid=$SUPERVISOR_PID (log: $SHADOW_LOGS/supervisor.log)"

# mint tokens.
mint() { ( cd "$REPO" && "$NODE_BIN" -e '
  const jwt=require("jsonwebtoken");
  const [uid,uname,role,secret]=process.argv.slice(1);
  process.stdout.write(jwt.sign({userId:+uid,username:uname,role,pwd_iat:Date.now()},secret,{expiresIn:"3h"}));
' "$1" "$2" "$3" "$SHADOW_JWT_SECRET" ); }
OWNER_TOKEN="$(mint "$OWNER_ID" owner owner)"
STRANGER_TOKEN="$(mint "$STRANGER_ID" stranger user)"

cat > "$SHADOW_RUN/session.env" <<EOF
export REPO="$REPO"
export SHADOW_ROOT="$SHADOW_ROOT"
export SHADOW_HOME="$SHADOW_HOME"
export SHADOW_DB="$SHADOW_DB"
export SHADOW_STATE="$SHADOW_STATE"
export SHADOW_LOGS="$SHADOW_LOGS"
export SHADOW_RUN="$SHADOW_RUN"
export SHADOW_TRANSCRIPTS="$SHADOW_TRANSCRIPTS"
export SHADOW_PORT="$SHADOW_PORT"
export BASE_URL="$BASE_URL"
export SHADOW_JWT_SECRET="$SHADOW_JWT_SECRET"
export SHADOW_GRACE_MS="$SHADOW_GRACE_MS"
export CLAUDE_BIN="$CLAUDE_BIN"
export NODE_BIN="$NODE_BIN"
export DB_INDEX="$DB_INDEX"
export SUPERVISOR_ENTRY="$SUPERVISOR_ENTRY"
export OWNER_ID="$OWNER_ID"
export STRANGER_ID="$STRANGER_ID"
export PROJECT_PATH="$PROJECT_PATH"
export OWNER_TOKEN="$OWNER_TOKEN"
export STRANGER_TOKEN="$STRANGER_TOKEN"
export OWNER_CFG="$SHADOW_HOME/.nassaj-users/$OWNER_ID/.claude"
export SERVER_PID="$SERVER_PID"
export SUPERVISOR_PID="$SUPERVISOR_PID"
EOF

log "session.env written. ownerId=$OWNER_ID project=$PROJECT_PATH READY."
