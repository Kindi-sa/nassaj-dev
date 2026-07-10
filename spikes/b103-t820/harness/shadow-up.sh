#!/usr/bin/env bash
#
# T-820 shadow harness — bring up an ISOLATED copy of the real built server +
# the standalone supervisor on a temp port/DB/config, flag ON. Verifies at boot
# (from the process itself, not by trusting inheritance) that the effective DB is
# the temp one. Seeds an owner + stranger + owned project, seeds a COPY of the
# owner's claude credential into the temp trees, mints tokens, and writes
# session.env for the criteria to source.
#
# NOTHING here touches the live process, the live DB, or the real ~/.nassaj-users.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/_env.sh"

log() { printf '[shadow-up] %s\n' "$*"; }
die() { printf '[shadow-up][FATAL] %s\n' "$*" >&2; exit 1; }

# --- clean slate ------------------------------------------------------------
"$HERE/shadow-down.sh" --quiet || true
rm -rf "$SHADOW_ROOT"
mkdir -p "$SHADOW_HOME/.claude" "$SHADOW_STATE" "$SHADOW_LOGS" "$SHADOW_RUN"

# --- preflight: ports free --------------------------------------------------
for p in "$SHADOW_PORT" "$SHADOW_PORT_OFF"; do
  if curl -s -o /dev/null -m 1 "http://127.0.0.1:$p/" 2>/dev/null; then
    die "port $p is already in use — pick another SHADOW_PORT/SHADOW_PORT_OFF"
  fi
done

# --- snapshot real-state fingerprints (zero-touch assertion baseline) -------
{
  echo "creds_sha=$(sha256sum "$REAL_CLAUDE_CREDS" 2>/dev/null | awk '{print $1}')"
  echo "creds_mtime=$(stat -c %Y "$REAL_CLAUDE_CREDS" 2>/dev/null || echo NA)"
  echo "claudejson_mtime=$(stat -c %Y "$REAL_CLAUDE_JSON" 2>/dev/null || echo NA)"
  echo "nassaj_users_list=$(ls -1 "$REAL_NASSAJ_USERS" 2>/dev/null | sort | tr '\n' ',' )"
  echo "live_db_mtime=$(stat -c %Y "$REAL_LIVE_DB" 2>/dev/null || echo NA)"
  echo "live_db_sha=$(sha256sum "$REAL_LIVE_DB" 2>/dev/null | awk '{print $1}')"
} > "$SHADOW_RUN/pre-fingerprint.env"
log "recorded real-state fingerprint → $SHADOW_RUN/pre-fingerprint.env"

# --- seed a COPY of the owner claude credential/config into the temp home ----
[ -f "$REAL_CLAUDE_CREDS" ] || die "owner credential not found at $REAL_CLAUDE_CREDS"
cp "$REAL_CLAUDE_CREDS" "$SHADOW_HOME/.claude/.credentials.json"; chmod 600 "$SHADOW_HOME/.claude/.credentials.json"
[ -f "$REAL_CLAUDE_JSON" ] && cp "$REAL_CLAUDE_JSON" "$SHADOW_HOME/.claude.json"

# --- seed the temp DB (owner + stranger + owned project) --------------------
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

# --- pre-seed the per-user OWNER config dir so provision skips the symlink and
#     claude authenticates from a real copy (transcripts land here, in temp) ----
OWNER_CFG="$SHADOW_HOME/.nassaj-users/$OWNER_ID/.claude"
mkdir -p "$OWNER_CFG"
chmod 700 "$SHADOW_HOME/.nassaj-users/$OWNER_ID" "$OWNER_CFG"
cp "$REAL_CLAUDE_CREDS" "$OWNER_CFG/.credentials.json"; chmod 600 "$OWNER_CFG/.credentials.json"
[ -f "$REAL_CLAUDE_JSON" ] && { cp "$REAL_CLAUDE_JSON" "$OWNER_CFG/.claude.json"; chmod 600 "$OWNER_CFG/.claude.json"; }

# --- start the shadow SERVER (flag ON) --------------------------------------
# SERVER_PORT (NOT PORT) is the var the server reads; it is inherited as 3004
# from the live PM2 env, so we MUST override it. nohup + </dev/null detaches the
# process so it survives this launcher shell's exit (pidfile drives teardown).
nohup env $(shadow_env_common) SERVER_PORT="$SHADOW_PORT" WORKFLOW_SUPERVISOR=1 \
  "$NODE_BIN" "$SERVER_ENTRY" > "$SHADOW_LOGS/server.log" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$SHADOW_RUN/server.pid"
log "server pid=$SERVER_PID (log: $SHADOW_LOGS/server.log)"

# readiness (any HTTP code means it is listening).
ready=""
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE_URL/api/auth/status" 2>/dev/null || echo 000)"
  if [ "$code" != "000" ]; then ready=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -n 30 "$SHADOW_LOGS/server.log" >&2; die "server exited during boot"; }
  sleep 0.5
done
[ -n "$ready" ] || { tail -n 30 "$SHADOW_LOGS/server.log" >&2; die "server did not become ready"; }
log "server ready on $BASE_URL"

# --- VERIFY DB ISOLATION from the process itself (do not trust inheritance) --
PROC_DB="$(tr '\0' '\n' < "/proc/$SERVER_PID/environ" 2>/dev/null | sed -n 's/^DATABASE_PATH=//p')"
log "server /proc environ DATABASE_PATH = $PROC_DB"
[ "$PROC_DB" = "$SHADOW_DB" ] || die "server DATABASE_PATH is NOT the temp DB (got: $PROC_DB) — .env trap!"
log "DB isolation confirmed: effective DB = $SHADOW_DB (seed + /proc agree)"

# --- start the standalone SUPERVISOR (flag ON) ------------------------------
nohup env $(shadow_env_common) WORKFLOW_SUPERVISOR=1 \
  "$NODE_BIN" "$SUPERVISOR_ENTRY" > "$SHADOW_LOGS/supervisor.log" 2>&1 < /dev/null &
SUPERVISOR_PID=$!
echo "$SUPERVISOR_PID" > "$SHADOW_RUN/supervisor.pid"
sleep 0.5
kill -0 "$SUPERVISOR_PID" 2>/dev/null || { tail -n 20 "$SHADOW_LOGS/supervisor.log" >&2; die "supervisor exited"; }
log "supervisor pid=$SUPERVISOR_PID (log: $SHADOW_LOGS/supervisor.log)"

# --- mint tokens ------------------------------------------------------------
mint() { ( cd "$REPO" && "$NODE_BIN" -e '
  const jwt=require("jsonwebtoken");
  const [uid,uname,role,secret]=process.argv.slice(1);
  process.stdout.write(jwt.sign({userId:+uid,username:uname,role,pwd_iat:Date.now()},secret,{expiresIn:"2h"}));
' "$1" "$2" "$3" "$SHADOW_JWT_SECRET" ); }
OWNER_TOKEN="$(mint "$OWNER_ID" owner owner)"
STRANGER_TOKEN="$(mint "$STRANGER_ID" stranger user)"

# --- write session.env for the criteria -------------------------------------
cat > "$SHADOW_RUN/session.env" <<EOF
export REPO="$REPO"
export SHADOW_ROOT="$SHADOW_ROOT"
export SHADOW_HOME="$SHADOW_HOME"
export SHADOW_DB="$SHADOW_DB"
export SHADOW_STATE="$SHADOW_STATE"
export SHADOW_LOGS="$SHADOW_LOGS"
export SHADOW_RUN="$SHADOW_RUN"
export SHADOW_PORT="$SHADOW_PORT"
export SHADOW_PORT_OFF="$SHADOW_PORT_OFF"
export BASE_URL="$BASE_URL"
export SHADOW_JWT_SECRET="$SHADOW_JWT_SECRET"
export SHADOW_MAX_GLOBAL="$SHADOW_MAX_GLOBAL"
export CLAUDE_BIN="$CLAUDE_BIN"
export NODE_BIN="$NODE_BIN"
export SERVER_ENTRY="$SERVER_ENTRY"
export OWNER_ID="$OWNER_ID"
export STRANGER_ID="$STRANGER_ID"
export PROJECT_PATH="$PROJECT_PATH"
export OWNER_TOKEN="$OWNER_TOKEN"
export STRANGER_TOKEN="$STRANGER_TOKEN"
export OWNER_CFG="$OWNER_CFG"
export SERVER_PID="$SERVER_PID"
export SUPERVISOR_PID="$SUPERVISOR_PID"
EOF

log "session.env written → $SHADOW_RUN/session.env"
log "READY. ownerId=$OWNER_ID strangerId=$STRANGER_ID project=$PROJECT_PATH"
log "re-run a criterion with: source $SHADOW_RUN/session.env; bash <criterion>.sh"
