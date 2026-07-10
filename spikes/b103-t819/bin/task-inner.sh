#!/usr/bin/env bash
#
# B-103 / T-819 producer spike — the command that runs INSIDE wf-<taskId>.service.
# It runs `claude -p --output-format json` into result.json.partial, then seals the
# result via the shared atomic write path (lib/capture-writer.mjs --finalize).
#
# Consumed environment (all injected via `systemd-run --user --setenv`, NOT inherited):
#   OUTDIR                 task artifact dir (result.json[.partial], DONE, stderr.log)
#   PROMPT                 the claude -p prompt (tiny, per T-819 quota rule)
#   MODEL                  claude model (haiku, per T-819 quota rule)
#   LIBDIR                 path to spikes/b103-t819/lib
#   CLAUDE_CONFIG_DIR      owner auth config (isolation seam; here = current user)
#   WIDEN_WINDOW_MS        (optional) widen rename→DONE window — criterion 3 hook
#   CLAUDE_KILL_AFTER_SEC  (optional) SIGTERM the claude child after N s → PARTIAL class
#   SKIP_DONE              (optional) rename but skip DONE → PARTIAL-untrusted branch
#
# Deliberately never `cd`s into any real project: WorkingDirectory is a /tmp cwd set by
# the launcher (orphan-session-pollution rule).
set -u

: "${OUTDIR:?}" "${PROMPT:?}" "${MODEL:?}" "${LIBDIR:?}"
mkdir -p "$OUTDIR"
: > "$OUTDIR/result.json.partial"

if [ -n "${CLAUDE_KILL_AFTER_SEC:-}" ]; then
  # PARTIAL mechanism: interrupt claude mid-flight but keep THIS wrapper alive so it
  # still seals a DONE carrying the non-zero exit — a real interrupted (timeout) run.
  claude -p "$PROMPT" --output-format json --model "$MODEL" \
    > "$OUTDIR/result.json.partial" 2> "$OUTDIR/stderr.log" &
  cpid=$!
  ( sleep "$CLAUDE_KILL_AFTER_SEC"; kill -TERM "$cpid" 2>/dev/null ) &
  killer=$!
  wait "$cpid"; ec=$?
  kill "$killer" 2>/dev/null
else
  claude -p "$PROMPT" --output-format json --model "$MODEL" \
    > "$OUTDIR/result.json.partial" 2> "$OUTDIR/stderr.log"
  ec=$?
fi

echo "$ec" > "$OUTDIR/.claude_exit"

node "$LIBDIR/capture-writer.mjs" --finalize --outdir "$OUTDIR" --exit-code "$ec" \
  ${WIDEN_WINDOW_MS:+--widen-window-ms "$WIDEN_WINDOW_MS"} \
  ${SKIP_DONE:+--skip-done}

# Always exit 0 on a normal seal so the unit goes `inactive` (sealed), reserving the
# `failed` state to mean "the wrapper itself was killed before sealing" (CRASHED).
exit 0
