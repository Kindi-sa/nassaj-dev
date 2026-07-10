#!/usr/bin/env bash
#
# Criterion 4 (§و م3, الشرط 5) — two monitor instances started concurrently: the
# single-owner flock lets exactly ONE run; the second fails to acquire and exits
# QUIETLY. Proven on the shipped supervisor entrypoint (not the spike wrapper).
CRIT_NAME=criterion4
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion4] two monitors ⇒ one runs, one exits quietly (single-owner flock)"

# Own the lifecycle: stop the main supervisor first.
stop_supervisor supervisor.pid
sleep 0.3
: > "$SHADOW_LOGS/c4-a.log"; : > "$SHADOW_LOGS/c4-b.log"

# Monitor A acquires the lock and keeps running.
nohup env $(shadow_env_common) "$NODE_BIN" "$SUPERVISOR_ENTRY" > "$SHADOW_LOGS/c4-a.log" 2>&1 < /dev/null &
A=$!; echo "$A" > "$SHADOW_RUN/c4a.pid"
sleep 1.0
# Monitor B should find the lock held and exit quietly.
nohup env $(shadow_env_common) "$NODE_BIN" "$SUPERVISOR_ENTRY" > "$SHADOW_LOGS/c4-b.log" 2>&1 < /dev/null &
B=$!; echo "$B" > "$SHADOW_RUN/c4b.pid"

# Give B a moment to try, fail, and exit.
sleep 1.5

A_ALIVE="no"; kill -0 "$A" 2>/dev/null && A_ALIVE="yes"
B_ALIVE="no"; kill -0 "$B" 2>/dev/null && B_ALIVE="yes"
note "A alive=$A_ALIVE  B alive=$B_ALIVE"

[ "$A_ALIVE" = "yes" ] && ok "monitor A (lock holder) keeps running" || bad "monitor A died unexpectedly"
[ "$B_ALIVE" = "no" ]  && ok "monitor B exited (did not run a second monitor)" || bad "monitor B is still running (double monitor!)"
grep -q 'another instance holds the lock' "$SHADOW_LOGS/c4-b.log" \
  && ok "monitor B logged the quiet lock-held exit" \
  || note "B log tail: $(tail -n 2 "$SHADOW_LOGS/c4-b.log" 2>/dev/null)"

# Teardown A and B; restore the main supervisor.
stop_supervisor c4b.pid
stop_supervisor c4a.pid
start_supervisor supervisor.pid >/dev/null
sleep 0.4
finish
