#!/usr/bin/env bash
# T-820 shadow harness — single source of truth for every path/knob.
# Sourced by shadow-up/down and each criterion. Nothing here touches the LIVE
# process, the live DB, or the real ~/.nassaj-users: every path is under
# $SHADOW_ROOT (a temp tree deleted on teardown), and the server/supervisor run
# under HOME=$SHADOW_HOME so os.homedir()-derived paths (state root, per-user
# credential trees) all land in temp.

set -u

# Repo root (built dist-server lives here).
export REPO="${REPO:-/home/nassaj/Project/nassaj-dev}"

# The whole isolated world. Override SHADOW_ROOT to run two harnesses at once.
export SHADOW_ROOT="${SHADOW_ROOT:-/tmp/b103-t820-shadow}"
export SHADOW_HOME="$SHADOW_ROOT/home"
export SHADOW_DB="$SHADOW_ROOT/db.sqlite"
export SHADOW_STATE="$SHADOW_ROOT/state"
export SHADOW_LOGS="$SHADOW_ROOT/logs"
export SHADOW_RUN="$SHADOW_ROOT/run"

# Ports: main (flag ON) + a throwaway flag-OFF instance for criterion 4.
export SHADOW_PORT="${SHADOW_PORT:-3005}"
export SHADOW_PORT_OFF="${SHADOW_PORT_OFF:-3006}"
export BASE_URL="http://127.0.0.1:${SHADOW_PORT}"

# A fixed test JWT secret (>=32 chars) so we can mint tokens the shadow verifies.
export SHADOW_JWT_SECRET="${SHADOW_JWT_SECRET:-t820-shadow-jwt-secret-do-not-use-in-prod-0001}"

# Concurrency caps for the shadow supervisor. Global=2 lets criterion 3 saturate
# the HOST-WIDE gate with two dummy units and prove the (N+1)th is QUEUED.
export SHADOW_MAX_GLOBAL="${SHADOW_MAX_GLOBAL:-2}"
export SHADOW_MAX_PER_USER="${SHADOW_MAX_PER_USER:-3}"

# Real binaries (absolute — no PATH dependence for the launcher).
export CLAUDE_BIN="${CLAUDE_BIN:-/home/nassaj/.local/bin/claude}"
export NODE_BIN="${NODE_BIN:-/usr/bin/node}"

# Built entrypoints.
export SERVER_ENTRY="$REPO/dist-server/server/index.js"
export SUPERVISOR_ENTRY="$REPO/dist-server/server/modules/workflow-supervisor/supervisor.js"
export DB_INDEX="$REPO/dist-server/server/modules/database/index.js"

# The real artifacts a zero-touch assertion must find UNCHANGED after a run.
export REAL_CLAUDE_CREDS="$HOME/.claude/.credentials.json"
export REAL_CLAUDE_JSON="$HOME/.claude.json"
export REAL_NASSAJ_USERS="$HOME/.nassaj-users"
export REAL_LIVE_DB="$HOME/.local/share/nassaj-dev/db.sqlite"

# The env a shadow server/supervisor process runs with. `env VAR=val` OVERRIDES
# anything inherited from this (nassaj-dev-child) shell — especially DATABASE_PATH,
# which the live .env would otherwise trap us into. WORKFLOW_SUPERVISOR_UNIT_HOME
# forces the transient unit's HOME into temp so no claude write escapes to $HOME.
shadow_env_common() {
  printf '%s\n' \
    "HOME=$SHADOW_HOME" \
    "DATABASE_PATH=$SHADOW_DB" \
    "JWT_SECRET=$SHADOW_JWT_SECRET" \
    "WORKFLOW_SUPERVISOR_STATE_DIR=$SHADOW_STATE" \
    "WORKFLOW_SUPERVISOR_CLAUDE_BIN=$CLAUDE_BIN" \
    "WORKFLOW_SUPERVISOR_UNIT_HOME=$SHADOW_HOME" \
    "WORKFLOW_SUPERVISOR_POLL_MS=500" \
    "WORKFLOW_SUPERVISOR_MAX_GLOBAL=$SHADOW_MAX_GLOBAL" \
    "WORKFLOW_SUPERVISOR_MAX_PER_USER=$SHADOW_MAX_PER_USER" \
    "PATH=/home/nassaj/.local/bin:/usr/bin:/bin" \
    "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
}

# Human-readable available memory in MB (for the no-OOM watch in criterion 3).
mem_available_mb() {
  awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo
}

# Stop + reset a transient unit so it leaves NOTHING behind in the --user session.
kill_wf_unit() {
  local unit="$1"
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
}
