#!/usr/bin/env bash
#
# Criterion 3 (hole 2-أ): kill -9 in the window BETWEEN rename and DONE on REAL runs must
# yield a DECISIVE verdict (CRASHED or PARTIAL-untrusted) after the grace — never a hang,
# never a false SUCCEEDED. The rename→DONE window is widened by a documented test hook
# (--widen-window-ms) so the kill reliably lands inside it.
#
# Also runs a few --skip-done real runs (clean exit, result.json present, DONE suppressed)
# to exercise the OTHER reconciliation branch → PARTIAL-untrusted.
#
# Counts: N_WINDOW (10)  N_SKIPDONE (3).  WIDEN_MS (4000)  GRACE (2000).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

N_WINDOW="${N_WINDOW:-10}"; N_SKIPDONE="${N_SKIPDONE:-3}"
WIDEN_MS="${WIDEN_MS:-4000}"; GRACE="${GRACE:-2000}"
RECORDS="$STATE_ROOT/criterion3.records.jsonl"; : > "$RECORDS"
FIX_SRC="${FIX_SRC:-$STATE_ROOT/fixtures}"; mkdir -p "$FIX_SRC"
echo "[criterion3] window=$N_WINDOW skipdone=$N_SKIPDONE widen=${WIDEN_MS}ms grace=${GRACE}ms"

window_run () {
  local tid out unit attempt hit=no; tid=$(gen_task_id win); out="$STATE_ROOT/tasks/$tid"
  for attempt in 1 2 3; do
    rm -rf "$out"; mkdir -p "$out"
    unit=$(launch "$tid" --widen-window-ms "$WIDEN_MS")
    if wait_result_json "$out" 800; then
      # result.json exists, DONE not yet written → we are INSIDE the rename→DONE window.
      systemctl --user kill --kill-whom=all -s KILL "$unit" 2>/dev/null
      # window is a hit iff DONE never got written (kill beat the DONE step)
      sleep 0.3
      if [ ! -f "$out/DONE" ]; then hit=yes; break; fi
    fi
    cleanup_unit "$unit"; sleep 0.2
  done
  # harvest the (complete) result.json produced before the kill as an extra fixture
  [ -f "$out/result.json" ] && cp "$out/result.json" "$FIX_SRC/${tid}.json" 2>/dev/null || true
  wait_settle "$unit" "$out" 30 || true
  local t0 t1; t0=$(date +%s%3N)
  classify_to "$out" "$unit" "$GRACE" "$out/classify.json"
  t1=$(date +%s%3N)
  REC_KILL_INFO="SIGKILL-in-rename→DONE-window" REC_WINDOW_HIT="$hit" REC_CLASSIFY_MS="$((t1 - t0))" \
    emit "$RECORDS" "$tid" "CRASHED|PARTIAL-untrusted" "$out/classify.json"
  cleanup_unit "$unit"
  printf '  win %s hit=%s -> %s (%sms)\n' "$tid" "$hit" \
    "$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).classification' "$out/classify.json")" "$((t1 - t0))"
}

skipdone_run () {
  local tid out unit; tid=$(gen_task_id skipdone); out="$STATE_ROOT/tasks/$tid"
  unit=$(launch "$tid" --skip-done)
  wait_settle "$unit" "$out" 120 || true
  local t0 t1; t0=$(date +%s%3N)
  classify_to "$out" "$unit" "$GRACE" "$out/classify.json"
  t1=$(date +%s%3N)
  REC_KILL_INFO="skip-done(clean-exit,no-DONE)" REC_WINDOW_HIT="n/a" REC_CLASSIFY_MS="$((t1 - t0))" \
    emit "$RECORDS" "$tid" "PARTIAL-untrusted" "$out/classify.json"
  cleanup_unit "$unit"
  printf '  skipdone %s -> %s (%sms)\n' "$tid" \
    "$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).classification' "$out/classify.json")" "$((t1 - t0))"
}

for _ in $(seq 1 "$N_WINDOW"); do window_run; done
for _ in $(seq 1 "$N_SKIPDONE"); do skipdone_run; done

node - "$RECORDS" "$STATE_ROOT/criterion3.json" <<'NODE'
const fs = require('fs');
const [recs, outFile] = process.argv.slice(2);
const rows = fs.readFileSync(recs,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const win = rows.filter(r=>r.killInfo && r.killInfo.includes('window'));
const skd = rows.filter(r=>r.killInfo && r.killInfo.includes('skip-done'));
const windowHits = win.filter(r=>r.windowHit==='yes').length;
const decisive = rows.filter(r=>r.classification==='CRASHED'||r.classification==='PARTIAL-untrusted').length;
const falseSucceeded = rows.filter(r=>r.classification==='SUCCEEDED').length;
const hung = rows.filter(r=>r.classification==='RUNNING').length;
const maxClassifyMs = Math.max(...rows.map(r=>r.classifyMs||0));
const summary = { criterion: 3,
  windowRuns: win.length, windowHits, windowVerdictsDecisive: win.filter(r=>r.correct).length,
  skipDoneRuns: skd.length, skipDonePartialUntrusted: skd.filter(r=>r.classification==='PARTIAL-untrusted').length,
  totalDecisive: decisive, total: rows.length, falseSucceeded, hung, maxClassifyMs,
  records: rows };
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`[criterion3] windowHits=${windowHits}/${win.length} decisive=${decisive}/${rows.length} falseSucceeded=${falseSucceeded} hung=${hung} maxClassifyMs=${maxClassifyMs}`);
NODE
