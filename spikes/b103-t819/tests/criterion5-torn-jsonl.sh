#!/usr/bin/env bash
#
# Criterion 5 (hole 2-ب, reconcile-6.5% analog, §و/المرحلة 1 بند 5): dedup on a REAL
# <conversationId>.jsonl with a HALF-WRITTEN handoffId line must, via JSON.parse (NOT regex),
# treat the torn line as "not delivered" and idempotently re-deliver ⇒ zero double, zero lost.
#
# The torn line is produced through the REAL injection path SIGKILL-ing itself mid-append at a
# RANDOM byte offset (interrupted resume-append), on a committed REAL transcript — never a
# synthetic string. Offsets are chosen > the handoffId field end (byte 97) so the torn fragment
# CONTAINS the full handoffId text: this is the adversarial case where a text regex WOULD match
# and wrongly skip (LOSS). A regex NEGATIVE CONTROL is run on the same torn state to prove it.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_consumer_common.sh"

ITER="${ITER:-24}"
WORK="$STATE_ROOT/c5"; mkdir -p "$WORK"
REC="$WORK/records.jsonl"; : > "$REC"
echo "[criterion5] iterations=$ITER  torn-append derived from REAL transcripts, random offsets"

for ((n=1; n<=ITER; n++)); do
  tid="t819-c5-$(date +%s)-$n-$RANDOM"
  base=$([ $((RANDOM % 2)) -eq 0 ] && echo "$CONV_B" || echo "$CONV_A")
  off=$(( 110 + RANDOM % 300 ))     # in [110,409]: past handoffId (ends@97), well within line (~1900)
  hid=$(hid_of "$tid")

  # --- JSON matcher path (the correct behavior) ---
  A="$WORK/json-$n"; mkdir -p "$A/tasks/$tid" "$A/handoffs"
  conv="$A/conv.jsonl"; seed_conv "$conv" "$base"; sid=$(sid_of "$conv")
  seed_task_json "$A/tasks/$tid" "$tid" "$sid" "$conv" "wf-$tid.service"
  # 1) interrupted append → torn last line, no ledger (process SIGKILLs itself)
  ( $CLI_HANDOFF --finalize --state-root "$A" --task-json "$A/tasks/$tid/task.json" \
      --jsonl "$conv" --result "$RESULT_FIXTURE" --tear-at-offset "$off" >/dev/null 2>&1 )
  read -r tv tr tt <<<"$(scan_counts "$conv" "$hid")"
  ledger_after_tear=$([ -f "$A/handoffs/$sid.done" ] && echo yes || echo no)
  torn_ok=$([ "$tv" = "0" ] && [ "$tr" -ge 1 ] && [ "$tt" -ge 1 ] && [ "$ledger_after_tear" = "no" ] && echo true || echo false)
  # 2) json retry → must re-deliver exactly once; 3) retry again → idempotent skip
  ev1=$($CLI_HANDOFF --finalize --state-root "$A" --task-json "$A/tasks/$tid/task.json" \
      --jsonl "$conv" --result "$RESULT_FIXTURE" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).event')
  ev2=$($CLI_HANDOFF --finalize --state-root "$A" --task-json "$A/tasks/$tid/task.json" \
      --jsonl "$conv" --result "$RESULT_FIXTURE" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).event')
  read -r jv jr jt <<<"$(scan_counts "$conv" "$hid")"
  json_ok=$([ "$ev1" = "inject+ledger" ] && [ "$ev2" = "skip-ledger-hit" ] && [ "$jv" = "1" ] && echo true || echo false)

  # --- REGEX negative control (same torn state, MUST lose) ---
  B="$WORK/regex-$n"; mkdir -p "$B/tasks/$tid" "$B/handoffs"
  convB="$B/conv.jsonl"; seed_conv "$convB" "$base"
  seed_task_json "$B/tasks/$tid" "$tid" "$sid" "$convB" "wf-$tid.service"
  ( $CLI_HANDOFF --finalize --state-root "$B" --task-json "$B/tasks/$tid/task.json" \
      --jsonl "$convB" --result "$RESULT_FIXTURE" --tear-at-offset "$off" >/dev/null 2>&1 )
  evR=$($CLI_HANDOFF --finalize --state-root "$B" --task-json "$B/tasks/$tid/task.json" \
      --jsonl "$convB" --result "$RESULT_FIXTURE" --matcher regex | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).event')
  read -r rv rr rt <<<"$(scan_counts "$convB" "$hid")"
  regex_lost=$([ "$evR" = "ledger-repair" ] && [ "$rv" = "0" ] && echo true || echo false)

  node -e '
    const fs=require("fs");const a=process.argv;   // node -e: first passed arg is argv[1]
    const rec={it:+a[2],base:require("path").basename(a[3]),offset:+a[4],
      tornOk:a[5]==="true",afterTear:{valid:+a[6],regex:+a[7],torn:+a[8]},
      jsonEvents:[a[9],a[10]],jsonValidAfter:+a[11],jsonOk:a[12]==="true",
      regexEvent:a[13],regexValidAfter:+a[14],regexLost:a[15]==="true"};
    fs.appendFileSync(a[1],JSON.stringify(rec)+"\n");
  ' "$REC" "$n" "$base" "$off" "$torn_ok" "$tv" "$tr" "$tt" "$ev1" "$ev2" "$jv" "$json_ok" "$evR" "$rv" "$regex_lost"
  printf '  it=%02d off=%d torn(v=%s r=%s t=%s)ok=%s | json:%s,%s v=%s ok=%s | regex:%s v=%s lost=%s\n' \
    "$n" "$off" "$tv" "$tr" "$tt" "$torn_ok" "$ev1" "$ev2" "$jv" "$json_ok" "$evR" "$rv" "$regex_lost"
done

node - "$REC" "$STATE_ROOT/criterion5.json" <<'NODE'
const fs = require('fs');
const [rec, out] = process.argv.slice(2);
const rows = fs.readFileSync(rec,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const tornDerivedOk = rows.filter(r=>r.tornOk).length;              // torn line real + unparseable + carries hid text
const jsonExactlyOnce = rows.filter(r=>r.jsonOk && r.jsonValidAfter===1).length;
const jsonDoubles = rows.filter(r=>r.jsonValidAfter>1).length;
const jsonLost = rows.filter(r=>r.jsonValidAfter<1).length;
const regexLost = rows.filter(r=>r.regexLost).length;              // proves regex fails on torn
const summary = { criterion: 5, iterations: rows.length,
  tornDerivedFromRealTranscripts: true, tornStatesValid: tornDerivedOk,
  jsonRecoveredExactlyOnce: jsonExactlyOnce, jsonDoubles, jsonLost,
  regexLostCount: regexLost, offsetSpread: { min: Math.min(...rows.map(r=>r.offset)), max: Math.max(...rows.map(r=>r.offset)) },
  records: rows };
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`[criterion5] json exactlyOnce=${jsonExactlyOnce}/${rows.length} doubles=${jsonDoubles} lost=${jsonLost} | regexLost=${regexLost}/${rows.length} (control: regex must lose) | tornStatesValid=${tornDerivedOk}/${rows.length}`);
NODE
