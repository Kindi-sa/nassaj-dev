#!/usr/bin/env bash
#
# Criterion 3 (§و م3 core) — reproduces the T-819 crash-safety bar ON SERVER CODE:
# kill -9 the monitor mid-DELIVERY (precisely inside the append→ledger gap, via the
# documented WIDEN hook), restart it, and prove reconcile-on-boot re-binds and
# delivers EXACTLY ONCE — zero double, zero lost — over ≥5 attempts at VARIED kill
# offsets. Each task's result.json is REAL captured claude output (T-819 fixtures),
# never synthetic.
CRIT_NAME=criterion3
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion3] kill -9 monitor inside the append→ledger gap ⇒ restart ⇒ exactly-once (≥5 offsets)"

# Free the single-owner lock: stop the main supervisor so this criterion owns the
# monitor lifecycle.
stop_supervisor supervisor.pid
sleep 0.3

FIX_DIR="$REPO/spikes/b103-t819/fixtures"
FIX="$(ls "$FIX_DIR"/t819-succ-*.json 2>/dev/null | head -1)"
[ -n "$FIX" ] && ok "using REAL claude fixture: $(basename "$FIX")" || { bad "no T-819 success fixture found"; finish; exit 1; }

OFFSETS=(100 250 500 800 1200)
WIDEN=2000
GLOBAL_DOUBLE=0; GLOBAL_LOST=0; ATTEMPTS=0

for OFF in "${OFFSETS[@]}"; do
  ATTEMPTS=$((ATTEMPTS+1))
  TID="tid3-${ATTEMPTS}-$(date +%s%N)"
  CONV="convc3${ATTEMPTS}$(date +%s)"
  JSONL="$(seed_session "$CONV")"
  TD="$SHADOW_STATE/tasks/$TID"; mkdir -p "$TD"
  cp "$FIX" "$TD/result.json"
  "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({exit_code:0,signal:null,finalizedAt:new Date().toISOString(),schema:"t820-producer-1"})+"\n")' "$TD/DONE"
  "$NODE_BIN" -e '
    const fs=require("fs");const [td,tid,uid,pp,conv,i]=process.argv.slice(1);
    fs.writeFileSync(td+"/task.json",JSON.stringify({schema_version:"2",taskId:tid,userId:+uid,projectPath:pp,conversationId:conv,originMessageId:"m"+i,spec:{scriptOrPrompt:"x",model:null,effort:null,handoffPolicy:"card-only",leafOnly:true},requestedAt:new Date(0).toISOString()}));
  ' "$TD" "$TID" "$OWNER_ID" "$PROJECT_PATH" "$CONV" "$ATTEMPTS"

  # Start a monitor with a WIDE append→ledger gap.
  nohup env $(shadow_env_common) WORKFLOW_SUPERVISOR_HANDOFF_WIDEN_MS="$WIDEN" \
    "$NODE_BIN" "$SUPERVISOR_ENTRY" >> "$SHADOW_LOGS/c3-mon.log" 2>&1 < /dev/null &
  MON=$!; echo "$MON" > "$SHADOW_RUN/c3mon.pid"

  # Wait until the card is APPENDED (we are now inside the gap).
  appeared=""
  for _ in $(seq 1 200); do [ "$(count_cards "$JSONL")" -ge 1 ] && { appeared=1; break; }; sleep 0.05; done
  if [ -z "$appeared" ]; then bad "attempt $ATTEMPTS: card never appended within window"; kill -9 "$MON" 2>/dev/null || true; rm -f "$SHADOW_RUN/c3mon.pid"; continue; fi

  # Kill -9 at the VARIED offset INTO the gap (before the ledger write).
  "$NODE_BIN" -e 'const b=new Int32Array(new SharedArrayBuffer(4));Atomics.wait(b,0,0,+process.argv[1])' "$OFF"
  kill -9 "$MON" 2>/dev/null || true
  wait "$MON" 2>/dev/null || true
  rm -f "$SHADOW_RUN/c3mon.pid"

  LEDGER="$SHADOW_STATE/handoffs/$CONV.done"
  gap_ledger_absent="no"; [ ! -f "$LEDGER" ] && gap_ledger_absent="yes"
  note "attempt $ATTEMPTS (offset ${OFF}ms): card appended, ledger-absent-at-kill=$gap_ledger_absent"

  # Restart WITHOUT widen ⇒ reconcile-on-boot re-binds + finalizes exactly once.
  nohup env $(shadow_env_common) \
    "$NODE_BIN" "$SUPERVISOR_ENTRY" >> "$SHADOW_LOGS/c3-mon.log" 2>&1 < /dev/null &
  MON2=$!; echo "$MON2" > "$SHADOW_RUN/c3mon.pid"
  for _ in $(seq 1 120); do [ -f "$LEDGER" ] && break; sleep 0.1; done
  # settle
  sleep 0.6
  stop_supervisor c3mon.pid

  CARDN="$(count_cards "$JSONL")"
  LEDN=0; [ -f "$LEDGER" ] && LEDN="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.length)}catch{console.log(-1)}' "$LEDGER")"
  if [ "$CARDN" = "1" ] && [ "$LEDN" = "1" ]; then
    ok "attempt $ATTEMPTS: exactly-once (cards=1, ledger=1) after kill-at-${OFF}ms + restart"
  else
    bad "attempt $ATTEMPTS: cards=$CARDN ledger=$LEDN (expected 1/1)"
    [ "$CARDN" -gt 1 ] 2>/dev/null && GLOBAL_DOUBLE=$((GLOBAL_DOUBLE+1))
    [ "$CARDN" -lt 1 ] 2>/dev/null && GLOBAL_LOST=$((GLOBAL_LOST+1))
  fi
done

note "summary: attempts=$ATTEMPTS doubles=$GLOBAL_DOUBLE losses=$GLOBAL_LOST"
[ "$GLOBAL_DOUBLE" = "0" ] && ok "ZERO double deliveries across $ATTEMPTS crash/restart cycles" || bad "$GLOBAL_DOUBLE double deliveries"
[ "$GLOBAL_LOST" = "0" ] && ok "ZERO lost deliveries across $ATTEMPTS crash/restart cycles" || bad "$GLOBAL_LOST lost deliveries"

# Restore the main supervisor for any later criterion.
start_supervisor supervisor.pid >/dev/null
sleep 0.5
finish
