#!/usr/bin/env bash
# T-822 shadow harness — single source of truth for paths/knobs. Sourced by
# shadow-up/down and each criterion. Nothing here touches the LIVE process, the
# live DB, or dist-server: every driver runs the SOURCE via tsx with a temp
# HOME/DATABASE_PATH/state dir, and the ONLY real-tree read is the owner's
# .credentials.json (symlinked into a TEMP CLAUDE_CONFIG_DIR — its projects/ live
# in temp, so real ~/.claude/projects is never written; verified at bringup).
set -u

export REPO="${REPO:-/home/nassaj/Project/nassaj-dev}"

export SHADOW_ROOT="${SHADOW_ROOT:-/tmp/b103-t822-shadow}"
export SHADOW_HOME="$SHADOW_ROOT/home"
export SHADOW_DB="$SHADOW_ROOT/db.sqlite"
export SHADOW_STATE="$SHADOW_ROOT/state"
export SHADOW_LOGS="$SHADOW_ROOT/logs"
export SHADOW_RUN="$SHADOW_ROOT/run"
export PROJECT_PATH="$SHADOW_ROOT/proj"

export CLAUDE_BIN="${CLAUDE_BIN:-/home/nassaj/.local/bin/claude}"
export NODE_BIN="${NODE_BIN:-/usr/bin/node}"
export TSX="$REPO/node_modules/.bin/tsx --tsconfig $REPO/server/tsconfig.json"
export DRIVER="$REPO/spikes/b103-t822/harness/drivers/driver.ts"
export DB_DRIVER="$REPO/spikes/b103-t822/harness/drivers/db.ts"

# The real OWNER credential the shadow symlinks (READ-only; id 1 = the owner).
export REAL_OWNER_CLAUDE="${REAL_OWNER_CLAUDE:-/home/nassaj/.nassaj-users/1/.claude}"
export REAL_CLAUDE_CREDS="$REAL_OWNER_CLAUDE/.credentials.json"
export REAL_OWNER_SETTINGS="$REAL_OWNER_CLAUDE/settings.json"
export REAL_LIVE_DB="$HOME/.local/share/nassaj-dev/db.sqlite"
export REAL_NASSAJ_USERS="$HOME/.nassaj-users"

# Short grace so the DONE-absent reconciliation resolves fast in tests.
export SHADOW_GRACE_MS="${SHADOW_GRACE_MS:-1500}"
# The leaf handoff turn uses haiku (cheap/fast) in the harness.
export SHADOW_HANDOFF_MODEL="${SHADOW_HANDOFF_MODEL:-haiku}"

# The env every shadow driver/claude runs with. `env VAR=val` OVERRIDES anything
# inherited from this (nassaj-dev-child) shell — especially DATABASE_PATH/HOME.
shadow_env_common() {
  printf '%s\n' \
    "HOME=$SHADOW_HOME" \
    "DATABASE_PATH=$SHADOW_DB" \
    "WORKFLOW_SUPERVISOR=1" \
    "WORKFLOW_SUPERVISOR_CHAT_LOCK=1" \
    "WORKFLOW_SUPERVISOR_STATE_DIR=$SHADOW_STATE" \
    "WORKFLOW_SUPERVISOR_CLAUDE_BIN=$CLAUDE_BIN" \
    "WORKFLOW_SUPERVISOR_HANDOFF_MODEL=$SHADOW_HANDOFF_MODEL" \
    "WORKFLOW_SUPERVISOR_RECONCILE_GRACE_MS=$SHADOW_GRACE_MS" \
    "PATH=/home/nassaj/.local/bin:/usr/bin:/bin" \
    "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
}

# The per-user config dir resolveProviderEnv('claude', ownerId) resolves to under
# HOME=$SHADOW_HOME. Set after OWNER_ID is known (shadow-up writes it to session.env).
owner_cfg() { printf '%s' "$SHADOW_HOME/.nassaj-users/$1/.claude"; }
