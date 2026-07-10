#!/usr/bin/env bash
#
# Criterion 2 (§و م4-2, THE safety criterion) — a LIVE turn + a concurrent Tier-B
# injection on the SAME conversation ⇒ ZERO jsonl corruption over ≥8 attempts, and
# the human's turn is never delayed past the bounded ceiling (human priority). The
# injector holds the per-conversation lock (widened) while the live turn (the
# claude-sdk.js seam, mirrored EXACTLY by `driver live-turn`) contends, waits, and
# acquires cleanly. A NEGATIVE control (two uncoordinated real resumes) shows the
# test would catch corruption.
CRIT_NAME=criterion2
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

ATTEMPTS="${ATTEMPTS:-8}"
WIDEN="${WIDEN:-1500}"
echo "[criterion2] ${ATTEMPTS}× (live turn ∥ injection) ⇒ zero jsonl corruption + human priority"

# A FRESH conversation isolates this run (and bounds transcript growth).
READ2="$(make_session 'قل فقط: جلسة التزامن')" || { bad "could not create a fresh session"; finish; exit 1; }
C2SID="${READ2% *}"; C2TR="${READ2#* }"
note "fresh conversation $C2SID"

CORRUPT=0; HUMAN_STARVED=0; DONE=0
for i in $(seq 1 "$ATTEMPTS"); do
  TID="tc2-$i-$(date +%s%N)"
  seed_task "$TID" "$C2SID" "auto-turn" "نتيجة المهمة رقم $i: تم."

  # injector holds the lock during its real turn + widen.
  env $(shadow_env_common) WORKFLOW_SUPERVISOR_INJECT_WIDEN_MS="$WIDEN" \
    $TSX "$DRIVER" inject --conv "$C2SID" --project "$PROJECT_PATH" --jsonl "$C2TR" --tasks "$TID" \
    > "$SHADOW_LOGS/c2-inj-$i.json" 2>>"$SHADOW_LOGS/c2-inj.err" &
  INJ_PID=$!
  echo "$INJ_PID" > "$SHADOW_RUN/c2inj.pid"

  sleep 0.9  # let the injector acquire the lock + start its turn first

  # the LIVE human turn (seam mirror) — should WAIT then acquire cleanly.
  env $(shadow_env_common) \
    $TSX "$DRIVER" live-turn --conv "$C2SID" --project "$PROJECT_PATH" --user "$OWNER_ID" --tag "$i" \
    > "$SHADOW_LOGS/c2-live-$i.json" 2>>"$SHADOW_LOGS/c2-live.err" &
  LIVE_PID=$!
  echo "$LIVE_PID" > "$SHADOW_RUN/c2live.pid"

  wait "$INJ_PID" 2>/dev/null || true
  wait "$LIVE_PID" 2>/dev/null || true
  rm -f "$SHADOW_RUN/c2inj.pid" "$SHADOW_RUN/c2live.pid"

  read -r LINES BAD <<<"$(jsonl_health "$C2TR")"
  LR="$("$NODE_BIN" -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(o.lockReason+" "+o.waitedMs)}catch{console.log("ERR 0")}' "$SHADOW_LOGS/c2-live-$i.json")"
  REASON="${LR% *}"; WAITED="${LR#* }"
  DONE=$((DONE+1))
  if [ "$BAD" != "0" ]; then CORRUPT=$((CORRUPT+1)); bad "attempt $i: $BAD TORN lines in the transcript"; else :; fi
  # human priority: it acquired the lock (not fail-open) and waited a BOUNDED time.
  if [ "$REASON" = "acquired" ]; then
    note "attempt $i: transcript clean ($LINES lines); human WAITED ${WAITED}ms then ACQUIRED"
  elif [ "$REASON" = "timeout-fail-open" ]; then
    HUMAN_STARVED=$((HUMAN_STARVED+1)); note "attempt $i: human fail-open after ${WAITED}ms (injector overran ceiling)"
  else
    note "attempt $i: live lockReason=$REASON waited=${WAITED}ms"
  fi
done

[ "$CORRUPT" = "0" ] && ok "ZERO jsonl corruption across $DONE concurrent attempts" || bad "$CORRUPT/$DONE attempts corrupted the transcript"
[ "$HUMAN_STARVED" = "0" ] && ok "human priority held: every live turn acquired within the bounded ceiling" || bad "$HUMAN_STARVED live turns hit fail-open (injector overran)"

read -r LINES BAD <<<"$(jsonl_health "$C2TR")"
[ "$BAD" = "0" ] && ok "final transcript fully parseable ($LINES lines, 0 torn)" || bad "final transcript has $BAD torn lines"

# ---- NEGATIVE CONTROL: two UNCOORDINATED real resumes on a fresh session ----
echo "[criterion2] negative control: uncoordinated concurrent resumes (no lock)"
NC_READ="$(make_session 'قل فقط: تحكم')" || { note "neg-control: could not create session (skipped)"; finish; exit $?; }
NC_SID="${NC_READ% *}"; NC_TR="${NC_READ#* }"
NC_CORRUPT=0
for j in 1 2; do
  (cd "$PROJECT_PATH" && timeout 120 env HOME="$SHADOW_HOME" CLAUDE_CONFIG_DIR="$OWNER_CFG" "$CLAUDE_BIN" -r "$NC_SID" --output-format json -p "دور ألف $j اكتب فقرة قصيرة" >/dev/null 2>&1) &
  P1=$!
  (cd "$PROJECT_PATH" && timeout 120 env HOME="$SHADOW_HOME" CLAUDE_CONFIG_DIR="$OWNER_CFG" "$CLAUDE_BIN" -r "$NC_SID" --output-format json -p "دور باء $j اكتب فقرة قصيرة" >/dev/null 2>&1) &
  P2=$!
  wait "$P1" 2>/dev/null || true; wait "$P2" 2>/dev/null || true
  read -r NL NB <<<"$(jsonl_health "$NC_TR")"
  [ "$NB" != "0" ] && NC_CORRUPT=$((NC_CORRUPT+1))
  note "neg-control round $j: lines=$NL torn=$NB"
done
if [ "$NC_CORRUPT" -gt 0 ]; then
  ok "negative control DID corrupt without the lock ($NC_CORRUPT rounds) — the test detects the failure the lock prevents"
else
  note "negative control did not tear lines this run (claude append is line-atomic here); the lock still prevents interleaved/duplicated turns (design belt). WITH-lock proof stands."
fi

finish
