#!/usr/bin/env bash
#
# Criterion 4 (§و م4-4, §د coalescing) — ≥3 tasks for ONE conversation ⇒ ONE merged
# turn covering them all, exactly-once EVEN when the injector is kill -9'd mid-batch
# (inside the commit→ledger window, via the widen hook). On restart the committed
# refs are ledger-repaired (NO re-run) ⇒ zero double, zero lost. Fresh session so
# the batch is isolated.
CRIT_NAME=criterion4
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion4] 3 tasks/conv ⇒ one coalesced turn; kill -9 mid-batch ⇒ exactly-once"

READ="$(make_session 'قل فقط: جلسة الدمج')" || { bad "could not create a fresh session"; finish; exit 1; }
CONV="${READ% *}"; TR="${READ#* }"
note "fresh conversation $CONV"

T1="tb1-$(date +%s%N)"; T2="tb2-$(date +%s%N)"; T3="tb3-$(date +%s%N)"
seed_task "$T1" "$CONV" "auto-turn" "المهمة الأولى: بنيتُ الوحدة."
seed_task "$T2" "$CONV" "auto-turn" "المهمة الثانية: أضفتُ الاختبارات."
seed_task "$T3" "$CONV" "auto-turn" "المهمة الثالثة: حدّثتُ الوثيقة."

R1="$(ref_for "$T1")"; R2="$(ref_for "$T2")"; R3="$(ref_for "$T3")"

# Inject all three with a WIDE commit→ledger gap, in the background.
env $(shadow_env_common) WORKFLOW_SUPERVISOR_INJECT_WIDEN_MS=4000 \
  $TSX "$DRIVER" inject --conv "$CONV" --project "$PROJECT_PATH" --jsonl "$TR" --tasks "$T1,$T2,$T3" \
  > "$SHADOW_LOGS/c4-inj1.json" 2>>"$SHADOW_LOGS/c4-inj.err" &
INJ=$!; echo "$INJ" > "$SHADOW_RUN/c4inj.pid"

# Wait until the coalesced turn COMMITS (all three refs appear) — we are now inside
# the widen (commit done, ledger not yet).
committed=""
for _ in $(seq 1 400); do
  c1="$(count_valid_needle "$TR" "$R1")"; c3="$(count_valid_needle "$TR" "$R3")"
  if [ "$c1" -ge 1 ] && [ "$c3" -ge 1 ]; then committed=1; break; fi
  sleep 0.1
done
[ -n "$committed" ] && ok "one coalesced turn committed all 3 refs into the transcript" || { bad "refs never committed"; kill -9 "$INJ" 2>/dev/null || true; finish; exit 1; }

LEDGER_AT_KILL="$(ledger_entries "$CONV")"
# Kill -9 INSIDE the commit→ledger gap.
kill -9 "$INJ" 2>/dev/null || true; wait "$INJ" 2>/dev/null || true; rm -f "$SHADOW_RUN/c4inj.pid"
[ "$LEDGER_AT_KILL" = "0" ] && ok "killed inside the commit→ledger window (ledger absent at kill)" || note "ledger already had $LEDGER_AT_KILL at kill (widen too short)"

# Count the coalesced turns present: exactly ONE user line carrying ALL three refs.
COAL="$("$NODE_BIN" -e '
  const fs=require("fs");const [tr,a,b,c]=process.argv.slice(1);
  const ls=fs.readFileSync(tr,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  let n=0;for(const o of ls){if(o.type!=="user")continue;const s=JSON.stringify(o.message&&o.message.content||"");if(s.includes(a)&&s.includes(b)&&s.includes(c))n++}
  console.log(n);' "$TR" "$R1" "$R2" "$R3")"
[ "$COAL" = "1" ] && ok "exactly ONE coalesced turn carries all three results (no per-task turns)" || bad "expected 1 coalesced turn, found $COAL"

# Restart the injector pass ⇒ refs already committed ⇒ REPAIR only, NO re-run.
R2ND="$(run_driver $TSX "$DRIVER" inject --conv "$CONV" --project "$PROJECT_PATH" --jsonl "$TR" --tasks "$T1,$T2,$T3" 2>/dev/null)"
EV="$("$NODE_BIN" -e 'try{const o=JSON.parse(process.argv[1]);console.log(o.event+" rep="+o.repaired.length+" inj="+o.injected.length)}catch{console.log("x")}' "$R2ND")"
note "restart pass: $EV"
echo "$R2ND" | grep -q '"event":"repaired-only"' && ok "restart REPAIRED the ledger without a second turn (no double-charge)" || bad "restart did not repair-only: $R2ND"

# exactly-once: ledger has all 3; still exactly ONE coalesced turn (no re-run).
[ "$(ledger_entries "$CONV")" = "3" ] && ok "ledger records all 3 taskIds exactly once (zero lost)" || bad "ledger != 3 (got $(ledger_entries "$CONV"))"
COAL2="$("$NODE_BIN" -e '
  const fs=require("fs");const [tr,a,b,c]=process.argv.slice(1);
  const ls=fs.readFileSync(tr,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  let n=0;for(const o of ls){if(o.type!=="user")continue;const s=JSON.stringify(o.message&&o.message.content||"");if(s.includes(a)&&s.includes(b)&&s.includes(c))n++}
  console.log(n);' "$TR" "$R1" "$R2" "$R3")"
[ "$COAL2" = "1" ] && ok "still exactly ONE coalesced turn after restart (zero double)" || bad "a second turn was injected ($COAL2)"

read -r LINES BAD <<<"$(jsonl_health "$TR")"
[ "$BAD" = "0" ] && ok "transcript fully parseable ($LINES lines, 0 torn)" || bad "$BAD torn lines"

finish
