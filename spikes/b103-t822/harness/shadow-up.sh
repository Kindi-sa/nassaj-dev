#!/usr/bin/env bash
#
# T-822 shadow bringup — temp DB + owned project + a TEMP CLAUDE_CONFIG_DIR whose
# .credentials.json is a symlink to the real owner token (so `claude` authenticates
# from the live token) but whose projects/ live under the temp HOME (so real
# ~/.claude/projects is NEVER written). Then create a REAL claude session (haiku)
# so the injector has a real transcript to `--resume`, and seed its DB row. Nothing
# here touches the live process/DB/dist-server.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/_env.sh"

log() { printf '[t822-up] %s\n' "$*"; }
die() { printf '[t822-up][FATAL] %s\n' "$*" >&2; exit 1; }

"$HERE/shadow-down.sh" --quiet || true
rm -rf "$SHADOW_ROOT"
mkdir -p "$SHADOW_HOME/.claude/projects" "$SHADOW_STATE" "$SHADOW_LOGS" "$SHADOW_RUN" "$PROJECT_PATH"

[ -e "$REAL_CLAUDE_CREDS" ] || die "owner credential not found at $REAL_CLAUDE_CREDS"

# zero-touch baseline (creds + live DB + user listing).
{
  echo "creds_sha=$(sha256sum "$REAL_CLAUDE_CREDS" 2>/dev/null | awk '{print $1}')"
  echo "live_db_sha=$(sha256sum "$REAL_LIVE_DB" 2>/dev/null | awk '{print $1}')"
  echo "users_list=$(ls -1 "$REAL_NASSAJ_USERS" 2>/dev/null | sort | tr '\n' ',')"
  echo "real_projects_count=$(find "$REAL_OWNER_CLAUDE/projects" -name '*.jsonl' 2>/dev/null | wc -l)"
} > "$SHADOW_RUN/pre-fingerprint.env"

# 1) seed owner + owned project in the TEMP DB.
SEED="$(env $(shadow_env_common) $TSX "$DB_DRIVER" seed-owner-project "$PROJECT_PATH")" || die "seed-owner-project failed: $SEED"
OWNER_ID="$(printf '%s' "$SEED" | sed -n 's/.*"ownerId":\([0-9]*\).*/\1/p')"
STRANGER_ID="$(printf '%s' "$SEED" | sed -n 's/.*"strangerId":\([0-9]*\).*/\1/p')"
[ -n "$OWNER_ID" ] || die "could not parse ownerId from: $SEED"
log "seeded ownerId=$OWNER_ID strangerId=$STRANGER_ID project=$PROJECT_PATH"

# 2) build the TEMP config dir resolveProviderEnv('claude', ownerId) resolves to.
CFG="$(owner_cfg "$OWNER_ID")"
mkdir -p "$CFG"
chmod 700 "$CFG"
ln -sfn "$REAL_CLAUDE_CREDS" "$CFG/.credentials.json"
[ -f "$REAL_OWNER_SETTINGS" ] && cp "$REAL_OWNER_SETTINGS" "$CFG/settings.json"
ln -sfn "$SHADOW_HOME/.claude/projects" "$CFG/projects"
log "temp CLAUDE_CONFIG_DIR: $CFG (creds symlinked, projects → temp)"

# 3) create a REAL claude session (haiku) so --resume has a transcript to resume.
OUT1="$(cd "$PROJECT_PATH" && timeout 120 env HOME="$SHADOW_HOME" CLAUDE_CONFIG_DIR="$CFG" \
  "$CLAUDE_BIN" -p 'قل فقط: بدأنا' --model "$SHADOW_HANDOFF_MODEL" --output-format json 2>"$SHADOW_LOGS/session-create.err")" \
  || die "claude session create failed (see $SHADOW_LOGS/session-create.err): ${OUT1:0:200}"
SID="$("$NODE_BIN" -e 'try{console.log(JSON.parse(process.argv[1]).session_id||"")}catch{console.log("")}' "$OUT1")"
[ -n "$SID" ] || die "no session_id from claude: ${OUT1:0:200}"

# 4) locate the transcript (under the temp projects tree — assert it is NOT real).
TRANSCRIPT="$(find -L "$CFG/projects" -name "$SID.jsonl" 2>/dev/null | head -1)"
[ -n "$TRANSCRIPT" ] || die "transcript for $SID not found under temp projects"
case "$TRANSCRIPT" in
  "$SHADOW_ROOT"/*) : ;;
  *) die "transcript escaped temp: $TRANSCRIPT" ;;
esac
log "real session SID=$SID transcript=${TRANSCRIPT#$SHADOW_ROOT/}"

# 5) seed the DB session row (C2 resolves conv → this jsonl_path + owned project).
env $(shadow_env_common) $TSX "$DB_DRIVER" seed-session "$SID" "$PROJECT_PATH" "$TRANSCRIPT" >/dev/null || die "seed-session failed"

cat > "$SHADOW_RUN/session.env" <<EOF
export REPO="$REPO"
export SHADOW_ROOT="$SHADOW_ROOT"
export SHADOW_HOME="$SHADOW_HOME"
export SHADOW_DB="$SHADOW_DB"
export SHADOW_STATE="$SHADOW_STATE"
export SHADOW_LOGS="$SHADOW_LOGS"
export SHADOW_RUN="$SHADOW_RUN"
export PROJECT_PATH="$PROJECT_PATH"
export OWNER_ID="$OWNER_ID"
export STRANGER_ID="$STRANGER_ID"
export OWNER_CFG="$CFG"
export SID="$SID"
export TRANSCRIPT="$TRANSCRIPT"
export CLAUDE_BIN="$CLAUDE_BIN"
export NODE_BIN="$NODE_BIN"
EOF
log "session.env written. SID=$SID READY."
