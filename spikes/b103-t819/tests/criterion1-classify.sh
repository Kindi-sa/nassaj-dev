#!/usr/bin/env bash
#
# Criterion 1 (+ feeds criterion 2): >=20 REAL `claude -p --output-format json` runs under
# transient user services, covering the three producer classes, each classified per §أ-3.
# The classifier must be 100% correct. SUCCEEDED runs' real stdout is harvested as fixtures
# for the local tearing test (criterion 2) — never a synthetic fixture.
#
# Counts overridable: N_SUCC (8) N_PART (7) N_CRASH (7)  → default 22 total (>=20).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

N_SUCC="${N_SUCC:-8}"; N_PART="${N_PART:-7}"; N_CRASH="${N_CRASH:-7}"
RECORDS="$STATE_ROOT/criterion1.records.jsonl"; : > "$RECORDS"
FIX_SRC="$STATE_ROOT/fixtures"; mkdir -p "$FIX_SRC"
GRACE=2000

echo "[criterion1] STATE_ROOT=$STATE_ROOT  counts: succ=$N_SUCC part=$N_PART crash=$N_CRASH"

do_success () {
  local tid out unit; tid=$(gen_task_id succ); out="$STATE_ROOT/tasks/$tid"
  unit=$(launch "$tid")
  wait_settle "$unit" "$out" 120 || echo "  [warn] $tid did not settle"
  classify_to "$out" "$unit" "$GRACE" "$out/classify.json"
  REC_CLAUDE_EXIT="$(cat "$out/.claude_exit" 2>/dev/null)" \
    emit "$RECORDS" "$tid" "SUCCEEDED" "$out/classify.json"
  # harvest real stdout as a fixture for criterion 2
  [ -f "$out/result.json" ] && cp "$out/result.json" "$FIX_SRC/${tid}.json"
  cleanup_unit "$unit"
  printf '  succ %s -> %s\n' "$tid" "$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).classification' "$out/classify.json")"
}

do_partial () {
  local tid out unit ka; tid=$(gen_task_id part); out="$STATE_ROOT/tasks/$tid"
  ka="0.$((3 + RANDOM % 4))"   # SIGTERM claude at 0.3-0.6s (mid-flight) → non-zero exit
  unit=$(launch "$tid" --claude-kill-after-sec "$ka")
  wait_settle "$unit" "$out" 120 || echo "  [warn] $tid did not settle"
  classify_to "$out" "$unit" "$GRACE" "$out/classify.json"
  REC_CLAUDE_EXIT="$(cat "$out/.claude_exit" 2>/dev/null)" REC_KILL_INFO="SIGTERM@${ka}s" \
    emit "$RECORDS" "$tid" "PARTIAL" "$out/classify.json"
  cleanup_unit "$unit"
  printf '  part %s -> %s\n' "$tid" "$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).classification' "$out/classify.json")"
}

do_crash () {
  local tid out unit delay; tid=$(gen_task_id crash); out="$STATE_ROOT/tasks/$tid"
  unit=$(launch "$tid")
  delay="0.$((4 + RANDOM % 5))"   # kill -9 whole unit at 0.4-0.8s (mid-run, before DONE)
  sleep "$delay"
  systemctl --user kill --kill-whom=all -s KILL "$unit" 2>/dev/null
  wait_settle "$unit" "$out" 60 || true
  classify_to "$out" "$unit" "$GRACE" "$out/classify.json"
  REC_KILL_INFO="SIGKILL-unit@${delay}s" \
    emit "$RECORDS" "$tid" "CRASHED" "$out/classify.json"
  cleanup_unit "$unit"
  printf '  crash %s -> %s\n' "$tid" "$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).classification' "$out/classify.json")"
}

for _ in $(seq 1 "$N_SUCC"); do do_success; done
for _ in $(seq 1 "$N_PART"); do do_partial; done
for _ in $(seq 1 "$N_CRASH"); do do_crash; done

# Summary JSON for aggregation.
node - "$RECORDS" "$FIX_SRC" "$STATE_ROOT/criterion1.json" <<'NODE'
const fs = require('fs');
const [recs, fixSrc, outFile] = process.argv.slice(2);
const rows = fs.readFileSync(recs,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const byClass = {};
for (const r of rows) {
  const c = r.expected; byClass[c] ??= {total:0, correct:0};
  byClass[c].total++; if (r.correct) byClass[c].correct++;
}
const total = rows.length, correct = rows.filter(r=>r.correct).length;
const fixtures = fs.readdirSync(fixSrc).filter(f=>f.endsWith('.json')).map(f=>`${fixSrc}/${f}`);
const summary = { criterion: 1, total, correct, accuracy: total? correct/total : 0,
  byClass, fixturesHarvested: fixtures.length, fixtures, records: rows };
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`[criterion1] classified ${correct}/${total} correct; classes=${JSON.stringify(byClass)}; fixtures=${fixtures.length}`);
NODE
