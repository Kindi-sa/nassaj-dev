#!/usr/bin/env bash
#
# Criterion 7 (single-owner flock, §ب-2 / §ز الشرط 5): two concurrent supervisor instances ⇒
# exactly one runs, the other exits quietly. flock(2) on supervisor.lock via bin/supervisor-run.sh
# (fd 9 inherited across `exec node`, kernel-released on ANY death). Offline (no LLM).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_consumer_common.sh"

WORK="$STATE_ROOT/c7"; mkdir -p "$WORK/tasks" "$WORK/handoffs"
LOCK="$WORK/supervisor.lock"
echo "[criterion7] two concurrent instances on $LOCK"

# instance 1: loop mode, no tasks → holds the lock and keeps running. setsid → own group.
setsid bash "$SUP_RUN" "$LOCK" -- --state-root "$WORK" --mode loop --poll-ms 200 \
  --log "$WORK/sup1.log" > "$WORK/out1.txt" 2>&1 &
PG1=$!
sleep 0.8
first=$(grep -c 'flock acquired' "$WORK/out1.txt" || true)
alive1=$(kill -0 "$PG1" 2>/dev/null && echo yes || echo no)

# instance 2: must fail flock and exit quietly (exit 0), WITHOUT running the loop.
bash "$SUP_RUN" "$LOCK" -- --state-root "$WORK" --mode loop --poll-ms 200 \
  --log "$WORK/sup2.log" > "$WORK/out2.txt" 2>&1
rc2=$?
second_quiet=$(grep -c 'exiting quietly' "$WORK/out2.txt" || true)
second_ran=$([ -f "$WORK/sup2.log" ] && echo yes || echo no)   # sup2.log only exists if the loop booted

# kill instance 1; the lock must free so a THIRD instance can acquire (kernel release on death)
kill -9 -"$PG1" 2>/dev/null || kill -9 "$PG1" 2>/dev/null || true
sleep 0.4
setsid bash "$SUP_RUN" "$LOCK" -- --state-root "$WORK" --mode loop --poll-ms 200 \
  --log "$WORK/sup3.log" > "$WORK/out3.txt" 2>&1 &
PG3=$!
sleep 0.7
third=$(grep -c 'flock acquired' "$WORK/out3.txt" || true)
kill -9 -"$PG3" 2>/dev/null || kill -9 "$PG3" 2>/dev/null || true

echo "  inst1 acquired=$first alive=$alive1 | inst2 rc=$rc2 quietExit=$second_quiet ranLoop=$second_ran | inst3 reacquired=$third"

node - "$STATE_ROOT/criterion7.json" "$first" "$alive1" "$rc2" "$second_quiet" "$second_ran" "$third" <<'NODE'
const fs = require('fs');
const [out, first, alive1, rc2, quiet, ran, third] = process.argv.slice(2);
const firstAcquired = +first >= 1 && alive1 === 'yes';
const secondQuietExit = +quiet >= 1 && rc2 === '0' && ran === 'no';
const reacquireAfterDeath = +third >= 1;
const pass = firstAcquired && secondQuietExit && reacquireAfterDeath;
const summary = { criterion: 7, firstAcquired, secondQuietExit, secondExitCode: +rc2,
  secondRanLoop: ran === 'yes', reacquireAfterDeath, pass };
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`[criterion7] firstAcquired=${firstAcquired} secondQuietExit=${secondQuietExit} reacquireAfterDeath=${reacquireAfterDeath} pass=${pass}`);
NODE
