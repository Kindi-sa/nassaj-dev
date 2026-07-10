#!/usr/bin/env bash
#
# Criterion 1 (§و م3 success + أ4/C4 + C1-أ) — a task COMPLETES live (real claude
# exit 0 ⇒ result.json) and the monitor delivers a "completed" card into the
# conversation with NO LLM role, and GET /sessions/:id/messages (the path the UI
# reads) returns that card with task-notification semantics (never a user turn).
CRIT_NAME=criterion1
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion1] live success ⇒ result.json ⇒ non-LLM card ⇒ session API (notification semantics)"

CONV="convok$(date +%s)"
JSONL="$(seed_session "$CONV")" || { bad "seed_session failed"; finish; exit 1; }
ok "seeded session $CONV → $JSONL"

BODY="{\"projectPath\":\"$PROJECT_PATH\",\"scriptOrPrompt\":\"قل فقط: تم\",\"conversationId\":\"$CONV\",\"originMessageId\":\"m1\",\"model\":\"haiku\"}"
OUT="$(launch_post "$OWNER_TOKEN" "$BODY")"
CODE="${OUT%%$'\t'*}"; RESP="${OUT#*$'\t'}"
[ "$CODE" = "202" ] && ok "POST /launch → 202" || { bad "POST /launch → $CODE ($RESP)"; finish; exit 1; }
TASK_ID="$(json_field "$RESP" taskId)"
note "taskId=$TASK_ID"

TD="$SHADOW_STATE/tasks/$TASK_ID"
if wait_for_file "$TD/DONE" 150; then
  DONE_EC="$(sed -n 's/.*"exit_code":\([0-9-]*\).*/\1/p' "$TD/DONE")"
  note "task sealed: DONE exit_code=$DONE_EC"
  if [ "$DONE_EC" = "0" ]; then
    ok "real claude exited 0 (SUCCESS path is LIVE, not a fixture)"
    [ -f "$TD/result.json" ] && ok "exit 0 ⇒ result.json present (atomic rename)" || bad "exit 0 but no result.json"
  else
    bad "claude did NOT exit 0 (got $DONE_EC) — success path not exercised; see $TD/stderr.log"
    tail -n 5 "$TD/stderr.log" 2>/dev/null || true
  fi
else
  bad "DONE never appeared within 150s"; tail -n 8 "$SHADOW_LOGS/supervisor.log" 2>/dev/null || true; finish; exit 1
fi

# Wait for the monitor to deliver the card into the conversation jsonl.
CARDS=0
for _ in $(seq 1 100); do CARDS="$(count_cards "$JSONL")"; [ "$CARDS" -ge 1 ] && break; sleep 0.2; done
[ "$CARDS" = "1" ] && ok "exactly ONE card delivered into the conversation jsonl" || bad "card count=$CARDS (expected 1)"

# Inspect the card ON DISK: task-notification semantics, NOT an LLM/user turn.
"$NODE_BIN" -e '
  const fs=require("fs");
  const l=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse)
    .find(o=>o.kind==="task_reconcile");
  if(!l){console.log("NO_CARD");process.exit(0);}
  console.log(JSON.stringify({kind:l.kind,isTaskNotification:l.isTaskNotification,originKind:l.originKind,
    taskStatus:l.taskStatus,outcome:l.backgroundTaskOutcome,hasHandoffId:!!l.handoffId,
    wrapped:/^<background_task_result untrusted="true">/.test(l.message&&l.message.content||"")}));
' "$JSONL" > /tmp/.t821card.$$ 2>/dev/null
CARD="$(cat /tmp/.t821card.$$)"; rm -f /tmp/.t821card.$$
note "card on disk: $CARD"
grep -q '"isTaskNotification":true' <<<"$CARD" && ok "card is a task-notification (not a user/assistant message)" || bad "card not marked isTaskNotification"
grep -q '"originKind":"task-notification"' <<<"$CARD" && ok "originKind=task-notification (never attributed to the user)" || bad "originKind wrong"
grep -q '"taskStatus":"completed"' <<<"$CARD" && ok "taskStatus=completed (SUCCEEDED → completed)" || bad "taskStatus not completed"
grep -q '"wrapped":true' <<<"$CARD" && ok "untrusted wrapper present on the payload (§هـ-3)" || bad "payload not untrusted-wrapped"

# C1-أ: the SESSION API (the path the UI reads) returns the card with notification
# semantics — NOT a user-role message.
MSGS="$(get_messages "$OWNER_TOKEN" "$CONV")"
"$NODE_BIN" -e '
  let body; try{ body=JSON.parse(process.argv[1]); }catch{ console.log("PARSE_FAIL"); process.exit(0); }
  const arr = Array.isArray(body)?body:(body.messages||body.data&&body.data.messages||[]);
  const card = arr.find(m=>m&&(m.isTaskNotification===true||m.kind==="task_reconcile"));
  if(!card){ console.log("NO_CARD_IN_API:"+JSON.stringify(arr.slice(-3))); process.exit(0); }
  const isUserTurn = card.role==="user" && (card.kind==="text");
  console.log(JSON.stringify({found:true, isTaskNotification:card.isTaskNotification===true,
    taskStatus:card.taskStatus, originKind:card.originKind, isUserTurn}));
' "$MSGS" > /tmp/.t821api.$$ 2>/dev/null
API="$(cat /tmp/.t821api.$$)"; rm -f /tmp/.t821api.$$
note "session API view: $API"
grep -q '"found":true' <<<"$API" && ok "GET /sessions/$CONV/messages returns the card" || { bad "card not returned by the session API"; note "raw(last 300): ${MSGS: -300}"; }
grep -q '"isTaskNotification":true' <<<"$API" && ok "API card carries isTaskNotification (notification semantics)" || bad "API card lacks isTaskNotification"
grep -q '"isUserTurn":false' <<<"$API" && ok "API card is NOT a user-role turn (no LLM/user attribution)" || bad "API card looks like a user turn"

# ledger has exactly one entry for this conversation.
LED="$SHADOW_STATE/handoffs/$CONV.done"
if [ -f "$LED" ]; then
  N="$("$NODE_BIN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.length)' "$LED")"
  [ "$N" = "1" ] && ok "ledger has exactly one entry (exactly-once)" || bad "ledger entries=$N"
else
  bad "no ledger written"
fi

finish
