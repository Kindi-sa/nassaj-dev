#!/usr/bin/env bash
#
# Criterion 4 (delivery idempotency, §و/المرحلة 1 بند 4): repeating the finalize step N>=5
# times on the SAME task folder yields EXACTLY ONE delivery trace (one handoffId): one valid
# line in the conversation jsonl, one ledger entry, one real injection event. Offline (no LLM):
# the conversation base is a committed REAL transcript; the payload is a committed REAL result.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_consumer_common.sh"

N_TASKS="${N_TASKS:-6}"; REPEAT="${REPEAT:-8}"
WORK="$STATE_ROOT/c4"; mkdir -p "$WORK"
REC="$WORK/records.jsonl"; : > "$REC"
echo "[criterion4] tasks=$N_TASKS repeatsPerTask=$REPEAT (>=5 required)  result=$(basename "$RESULT_FIXTURE")"

for ((k=1; k<=N_TASKS; k++)); do
  tid="t819-c4-$(date +%s)-$k-$RANDOM"
  A="$WORK/task-$k"; mkdir -p "$A/tasks/$tid" "$A/handoffs"
  base=$([ $((k % 2)) -eq 0 ] && echo "$CONV_B" || echo "$CONV_A")
  conv="$A/conv.jsonl"; seed_conv "$conv" "$base"
  sid=$(sid_of "$conv"); hid=$(hid_of "$tid")
  seed_task_json "$A/tasks/$tid" "$tid" "$sid" "$conv" "wf-$tid.service"

  inject_events=0; events=""
  for ((r=1; r<=REPEAT; r++)); do
    ev=$($CLI_HANDOFF --finalize --state-root "$A" --task-json "$A/tasks/$tid/task.json" \
      --jsonl "$conv" --result "$RESULT_FIXTURE" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).event')
    events="$events $ev"
    [ "$ev" = "inject+ledger" ] && inject_events=$((inject_events + 1))
  done

  read -r valid regex torn <<<"$(scan_counts "$conv" "$hid")"
  led=$(ledger_entries_for "$A" "$sid" "$tid")
  pass=$([ "$valid" = "1" ] && [ "$inject_events" = "1" ] && [ "$led" = "1" ] && echo true || echo false)
  node -e '
    const fs=require("fs");
    const rec={taskId:process.argv[2],repeats:+process.argv[3],injectEvents:+process.argv[4],
      validMatchCount:+process.argv[5],ledgerEntries:+process.argv[6],tornLines:+process.argv[7],
      events:process.argv[8].trim().split(/\s+/),pass:process.argv[9]==="true"};
    fs.appendFileSync(process.argv[1],JSON.stringify(rec)+"\n");
  ' "$REC" "$tid" "$REPEAT" "$inject_events" "$valid" "$led" "$torn" "$events" "$pass"
  printf '  task#%d %s: %d repeats → inject=%d valid=%d ledger=%d pass=%s\n' \
    "$k" "$tid" "$REPEAT" "$inject_events" "$valid" "$led" "$pass"
done

node - "$REC" "$STATE_ROOT/criterion4.json" "$REPEAT" <<'NODE'
const fs = require('fs');
const [rec, out, repeat] = process.argv.slice(2);
const rows = fs.readFileSync(rec,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const oneHandoff = rows.filter(r=>r.validMatchCount===1 && r.injectEvents===1 && r.ledgerEntries===1).length;
const doubles = rows.filter(r=>r.validMatchCount>1 || r.injectEvents>1 || r.ledgerEntries>1).length;
const lost = rows.filter(r=>r.validMatchCount<1).length;
const summary = { criterion: 4, tasks: rows.length, repeatsPerTask: +repeat,
  exactlyOneHandoff: oneHandoff, doubles, lost, records: rows };
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`[criterion4] exactlyOneHandoff=${oneHandoff}/${rows.length} doubles=${doubles} lost=${lost}`);
NODE
