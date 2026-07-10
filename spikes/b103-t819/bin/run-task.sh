#!/usr/bin/env bash
#
# B-103 / T-819 producer spike — launch one task as a transient user service.
#
# Uses `systemd-run --user --unit=wf-<taskId>.service` (a transient SERVICE, exactly as
# the approved server code chose in config.ts:91-102 — NOT literal `--scope`, which would
# BLOCK the launcher and force result-capture onto completion instead of launch time).
# The service returns immediately, is owned by the user systemd manager, and OUTLIVES
# this launcher — the B-103 survival property.
#
# Flags:
#   --task-id ID          unique, charset [A-Za-z0-9_-]{1,128} (design §أ-1)
#   --outdir DIR          artifact dir
#   --cwd DIR             WorkingDirectory (a /tmp dir, never a real project)
#   --prompt STR          claude -p prompt
#   --model M             claude model (haiku)
#   --libdir DIR          spikes/b103-t819/lib
#   --inner PATH          path to task-inner.sh
#   --widen-window-ms N   (optional) criterion 3 hook
#   --claude-kill-after-sec N (optional) PARTIAL class
#   --skip-done           (optional) PARTIAL-untrusted branch
#   --runtime-max-sec N   (optional) systemd RuntimeMaxSec
set -euo pipefail

TASK_ID="" OUTDIR="" CWD="" PROMPT="" MODEL="haiku" LIBDIR="" INNER=""
WIDEN="" KILL_AFTER="" SKIP_DONE="" RUNTIME_MAX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --task-id) TASK_ID="$2"; shift 2;;
    --outdir) OUTDIR="$2"; shift 2;;
    --cwd) CWD="$2"; shift 2;;
    --prompt) PROMPT="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --libdir) LIBDIR="$2"; shift 2;;
    --inner) INNER="$2"; shift 2;;
    --widen-window-ms) WIDEN="$2"; shift 2;;
    --claude-kill-after-sec) KILL_AFTER="$2"; shift 2;;
    --skip-done) SKIP_DONE="1"; shift;;
    --runtime-max-sec) RUNTIME_MAX="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[ -n "$TASK_ID" ] && [ -n "$OUTDIR" ] && [ -n "$CWD" ] && [ -n "$PROMPT" ] \
  && [ -n "$LIBDIR" ] && [ -n "$INNER" ] || { echo "missing required flag" >&2; exit 2; }

# strict charset gate (design §أ-1: no path/unit injection)
[[ "$TASK_ID" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || { echo "bad task-id charset" >&2; exit 2; }

mkdir -p "$OUTDIR" "$CWD"
UNIT="wf-${TASK_ID}.service"

# Minimal, explicit environment for the unit (systemd-run does NOT inherit this shell).
UNIT_PATH="/home/nassaj/.local/bin:/usr/bin:/bin"

args=( --user --unit="$UNIT"
  --property=Description="B-103 T-819 producer spike ${TASK_ID}"
  --property=WorkingDirectory="$CWD"
  --setenv=PATH="$UNIT_PATH"
  --setenv=HOME="$HOME"
  --setenv=XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  --setenv=CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  --setenv=OUTDIR="$OUTDIR"
  --setenv=PROMPT="$PROMPT"
  --setenv=MODEL="$MODEL"
  --setenv=LIBDIR="$LIBDIR"
)
[ -n "$WIDEN" ]       && args+=( --setenv=WIDEN_WINDOW_MS="$WIDEN" )
[ -n "$KILL_AFTER" ]  && args+=( --setenv=CLAUDE_KILL_AFTER_SEC="$KILL_AFTER" )
[ -n "$SKIP_DONE" ]   && args+=( --setenv=SKIP_DONE="1" )
[ -n "$RUNTIME_MAX" ] && args+=( --property=RuntimeMaxSec="$RUNTIME_MAX" )

systemd-run "${args[@]}" -- "$INNER" >/dev/null
echo "$UNIT"
