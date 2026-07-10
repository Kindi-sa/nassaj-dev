#!/usr/bin/env bash
# Shared helpers for the T-819 producer criterion scripts. Source this.
set -uo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$SPIKE_DIR/lib"
INNER="$SPIKE_DIR/bin/task-inner.sh"
RUNNER="$SPIKE_DIR/bin/run-task.sh"

# STATE_ROOT: all transient artifacts + claude cwd live OUTSIDE the repo (/tmp), so
# claude -p never runs in a real project dir (orphan-session-pollution rule).
: "${STATE_ROOT:=$(mktemp -d /tmp/b103-t819-run-XXXXXX)}"
export STATE_ROOT
mkdir -p "$STATE_ROOT/tasks" "$STATE_ROOT/cwd"

PROMPT_DEFAULT='Write one short line about the sea, then reply ok'

_uid_seq=0
gen_task_id () { # prefix
  _uid_seq=$((_uid_seq + 1))
  printf 't819-%s-%s-%03d-%s' "$1" "$(date +%s)" "$_uid_seq" "$RANDOM"
}

launch () { # taskId [extra run-task.sh args...]
  local tid="$1"; shift
  local out="$STATE_ROOT/tasks/$tid" cwd="$STATE_ROOT/cwd/$tid"
  mkdir -p "$out" "$cwd"
  bash "$RUNNER" --task-id "$tid" --outdir "$out" --cwd "$cwd" \
    --prompt "${PROMPT:-$PROMPT_DEFAULT}" --model haiku \
    --libdir "$LIB" --inner "$INNER" "$@" >/dev/null
  echo "wf-${tid}.service"
}

# wait until DONE appears or the unit reaches a terminal state (bounded).
wait_settle () { # unit outdir maxHalfSeconds
  local unit="$1" out="$2" max="${3:-120}" i st
  for ((i=0; i<max; i++)); do
    [ -f "$out/DONE" ] && return 0
    st=$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null || echo gone)
    { [ "$st" = inactive ] || [ "$st" = failed ] || [ -z "$st" ] || [ "$st" = gone ]; } && return 0
    sleep 0.5
  done
  return 1
}

# poll until result.json appears (rename happened → now inside the rename→DONE window).
wait_result_json () { # outdir maxCentiseconds
  local out="$1" max="${2:-600}" i
  for ((i=0; i<max; i++)); do
    [ -f "$out/result.json" ] && return 0
    [ -f "$out/DONE" ] && return 1   # already sealed → window missed
    sleep 0.02
  done
  return 1
}

classify_to () { # outdir unit graceMs outFile
  local out="$1" unit="$2" grace="$3" dst="$4"
  node "$LIB/classifier.mjs" --outdir "$out" --unit "$unit" --grace-ms "$grace" \
    --poll-timeout-ms 60000 > "$dst"
}

emit () { # recordsFile taskId expected classifyJson  (REC_* env may add fields)
  REC_TASKID="$2" REC_EXPECTED="$3" node "$SPIKE_DIR/tests/_record.mjs" "$1" "$4"
}

cleanup_unit () { # unit
  systemctl --user reset-failed "$1" 2>/dev/null || true
}
