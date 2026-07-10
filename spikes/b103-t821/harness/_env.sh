#!/usr/bin/env bash
# T-821 shadow harness — single source of truth for every path/knob.
# Sourced by shadow-up/down and each criterion. Nothing here touches the LIVE
# process, the live DB, or another user's tree: the app (server + supervisor) runs
# with HOME=$SHADOW_HOME and an explicit temp DATABASE_PATH + state dir, so every
# app-level path lands in temp. The ONLY real-tree link is the OWNER's credential
# dir, reached via a SYMLINK (harness "اربط ... بمسار CLAUDE_CONFIG_DIR الحقيقي"):
# the owner's per-user config dir under the temp home is a symlink to the real
# /home/nassaj/.nassaj-users/1/.claude so claude authenticates from the live,
# in-place-refreshed token (a per-user COPY goes stale — the T-820 limitation this
# lifts). Transcripts a real `claude -p` writes land under that (shared-symlinked)
# projects dir — the documented T-819-style soak leftover under temp cwds.

set -u

export REPO="${REPO:-/home/nassaj/Project/nassaj-dev}"

export SHADOW_ROOT="${SHADOW_ROOT:-/tmp/b103-t821-shadow}"
export SHADOW_HOME="$SHADOW_ROOT/home"
export SHADOW_DB="$SHADOW_ROOT/db.sqlite"
export SHADOW_STATE="$SHADOW_ROOT/state"
export SHADOW_LOGS="$SHADOW_ROOT/logs"
export SHADOW_RUN="$SHADOW_ROOT/run"
export SHADOW_TRANSCRIPTS="$SHADOW_ROOT/transcripts"

export SHADOW_PORT="${SHADOW_PORT:-3015}"
export BASE_URL="http://127.0.0.1:${SHADOW_PORT}"
export SHADOW_JWT_SECRET="${SHADOW_JWT_SECRET:-t821-shadow-jwt-secret-do-not-use-in-prod-0001}"

export SHADOW_MAX_GLOBAL="${SHADOW_MAX_GLOBAL:-8}"
export SHADOW_MAX_PER_USER="${SHADOW_MAX_PER_USER:-3}"
# Short grace so the DONE-absent reconciliation resolves fast in tests.
export SHADOW_GRACE_MS="${SHADOW_GRACE_MS:-2000}"

export CLAUDE_BIN="${CLAUDE_BIN:-/home/nassaj/.local/bin/claude}"
export NODE_BIN="${NODE_BIN:-/usr/bin/node}"

export SERVER_ENTRY="$REPO/dist-server/server/index.js"
export SUPERVISOR_ENTRY="$REPO/dist-server/server/modules/workflow-supervisor/supervisor.js"
export DB_INDEX="$REPO/dist-server/server/modules/database/index.js"

# The real OWNER credential tree the shadow user symlinks to (id 1 = the owner).
export REAL_OWNER_CLAUDE="${REAL_OWNER_CLAUDE:-/home/nassaj/.nassaj-users/1/.claude}"
export REAL_CLAUDE_CREDS="$REAL_OWNER_CLAUDE/.credentials.json"
export REAL_NASSAJ_USERS="$HOME/.nassaj-users"
export REAL_LIVE_DB="$HOME/.local/share/nassaj-dev/db.sqlite"
export REAL_SHARED_PROJECTS="$HOME/.claude/projects"

# The env every shadow server/supervisor process runs with. `env VAR=val`
# OVERRIDES anything inherited from this (nassaj-dev-child) shell — especially
# DATABASE_PATH, which the live .env would otherwise trap us into.
shadow_env_common() {
  printf '%s\n' \
    "HOME=$SHADOW_HOME" \
    "DATABASE_PATH=$SHADOW_DB" \
    "JWT_SECRET=$SHADOW_JWT_SECRET" \
    "WORKFLOW_SUPERVISOR=1" \
    "WORKFLOW_SUPERVISOR_STATE_DIR=$SHADOW_STATE" \
    "WORKFLOW_SUPERVISOR_CLAUDE_BIN=$CLAUDE_BIN" \
    "WORKFLOW_SUPERVISOR_UNIT_HOME=$SHADOW_HOME" \
    "WORKFLOW_SUPERVISOR_POLL_MS=500" \
    "WORKFLOW_SUPERVISOR_MAX_GLOBAL=$SHADOW_MAX_GLOBAL" \
    "WORKFLOW_SUPERVISOR_MAX_PER_USER=$SHADOW_MAX_PER_USER" \
    "WORKFLOW_SUPERVISOR_RECONCILE_GRACE_MS=$SHADOW_GRACE_MS" \
    "PATH=/home/nassaj/.local/bin:/usr/bin:/bin" \
    "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
}

# Stop + reset a transient unit so it leaves NOTHING behind in the --user session.
kill_wf_unit() {
  local unit="$1"
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
}

# Stop EVERY wf-*.service this box has (teardown safety — zero orphan units).
kill_all_wf_units() {
  local u
  for u in $(systemctl --user list-units --all --type=service --no-legend --plain 'wf-*.service' 2>/dev/null | awk '{print $1}'); do
    kill_wf_unit "$u"
  done
}
