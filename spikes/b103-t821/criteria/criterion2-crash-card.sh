#!/usr/bin/env bash
#
# Criterion 2 (§و م3 crash) — a task CRASHES live (the unit is SIGKILLed mid-run,
# so the wrapper never seals a DONE) and the monitor's §أ-3 DONE-absent
# reconciliation classifies it CRASHED and delivers a correct "settled" card with
# NO LLM role. Exercises the reconciliation grace path end-to-end, live.
CRIT_NAME=criterion2
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion2] live crash (SIGKILL mid-run) ⇒ DONE-absent reconciliation ⇒ settled card, no LLM role"

CONV="convcrash$(date +%s)"
JSONL="$(seed_session "$CONV")" || { bad "seed_session failed"; finish; exit 1; }

# A longer prompt widens the mid-run kill window so the SIGKILL lands before seal.
BODY="{\"projectPath\":\"$PROJECT_PATH\",\"scriptOrPrompt\":\"اكتب مقالاً من 300 كلمة عن أهمية الماء\",\"conversationId\":\"$CONV\",\"originMessageId\":\"m1\",\"model\":\"haiku\"}"
OUT="$(launch_post "$OWNER_TOKEN" "$BODY")"
CODE="${OUT%%$'\t'*}"; RESP="${OUT#*$'\t'}"
[ "$CODE" = "202" ] && ok "POST /launch → 202" || { bad "POST /launch → $CODE ($RESP)"; finish; exit 1; }
TASK_ID="$(json_field "$RESP" taskId)"
UNIT="wf-$TASK_ID.service"

# Wait for the unit to be active, then SIGKILL it mid-run (before it can seal).
ACTIVE=""
for _ in $(seq 1 200); do [ "$(unit_is_active "$UNIT")" = "active" ] && { ACTIVE=1; break; }; sleep 0.1; done
[ -n "$ACTIVE" ] && ok "unit $UNIT became active" || { bad "unit never became active"; finish; exit 1; }
sleep 1.5   # let claude get mid-generation
systemctl --user kill -s SIGKILL "$UNIT" 2>/dev/null || true
note "SIGKILLed the unit mid-run (no DONE will be sealed)"

# The monitor's reconciliation (terminal + DONE absent, after the grace) delivers.
CARDS=0
for _ in $(seq 1 120); do CARDS="$(count_cards "$JSONL")"; [ "$CARDS" -ge 1 ] && break; sleep 0.25; done
[ "$CARDS" = "1" ] && ok "exactly one card delivered for the crashed task" || bad "card count=$CARDS (expected 1)"

"$NODE_BIN" -e '
  const fs=require("fs");
  const l=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse)
    .find(o=>o.kind==="task_reconcile");
  if(!l){console.log("NO_CARD");process.exit(0);}
  console.log(JSON.stringify({isTaskNotification:l.isTaskNotification,originKind:l.originKind,
    taskStatus:l.taskStatus,outcome:l.backgroundTaskOutcome}));
' "$JSONL" > /tmp/.t821c2.$$ 2>/dev/null
C="$(cat /tmp/.t821c2.$$)"; rm -f /tmp/.t821c2.$$
note "crash card: $C"
grep -q '"isTaskNotification":true' <<<"$C" && ok "card is a task-notification (no LLM/user role)" || bad "not a task-notification"
grep -q '"originKind":"task-notification"' <<<"$C" && ok "originKind=task-notification" || bad "originKind wrong"
grep -q '"taskStatus":"settled"' <<<"$C" && ok "taskStatus=settled (crash → settled, correct semantics)" || bad "taskStatus not settled"
grep -qE '"outcome":"(CRASHED|PARTIAL-untrusted|PARTIAL)"' <<<"$C" && ok "outcome is a non-success terminal ($(sed -n 's/.*"outcome":"\([^"]*\)".*/\1/p' <<<"$C"))" || bad "outcome not a crash/partial"

# result.json must NOT exist for a crashed task (no torn result promoted).
TD="$SHADOW_STATE/tasks/$TASK_ID"
[ ! -f "$TD/result.json" ] && ok "no result.json for the crashed task (no torn result promoted)" || note "result.json present (claude may have sealed just before the kill)"

kill_wf_unit "$UNIT"
finish
