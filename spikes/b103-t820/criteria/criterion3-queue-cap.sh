#!/usr/bin/env bash
#
# Criterion 3 (§و م2 / §ز الشرط 7) — the HOST-WIDE concurrency cap. With the
# global cap saturated, an (N+1)th launch is QUEUED on disk (no OOM, no silent
# drop); freeing a slot releases it. Proves the GLOBAL gate specifically (the
# per-user gate is left slack).
CRIT_NAME=criterion3
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion3] global cap ($SHADOW_MAX_GLOBAL) → (N+1)th launch QUEUED, not OOM"
: > "$SHADOW_RUN/dummy-units.txt"

# Saturate the HOST-WIDE gate with dummy wf-*.service units (no owner marker, so
# the per-user gate stays slack; only the global count reaches the cap).
DUMMIES=()
for i in $(seq 1 "$SHADOW_MAX_GLOBAL"); do
  u="wf-t820dummy-$$-$i.service"
  systemd-run --user --quiet --unit="$u" -- sleep 300 >/dev/null 2>&1 || true
  echo "$u" >> "$SHADOW_RUN/dummy-units.txt"
  DUMMIES+=("$u")
done
# wait until the global active count reflects the dummies (== cap).
for _ in $(seq 1 40); do [ "$(global_active_count)" -ge "$SHADOW_MAX_GLOBAL" ] && break; sleep 0.1; done
GA="$(global_active_count)"
[ "$GA" -ge "$SHADOW_MAX_GLOBAL" ] && ok "global capacity saturated ($GA active ≥ cap $SHADOW_MAX_GLOBAL)" \
  || bad "could not saturate global capacity (active=$GA)"

MEM_BEFORE="$(mem_available_mb)"
note "MemAvailable before queued launch: ${MEM_BEFORE}MB"

# POST the (N+1)th task — must be QUEUED (intent stays on disk, no unit).
CONV="conv3q$(date +%s)"
BODY="{\"projectPath\":\"$PROJECT_PATH\",\"scriptOrPrompt\":\"Reply with exactly: OK\",\"conversationId\":\"$CONV\",\"originMessageId\":\"m\",\"model\":\"haiku\"}"
OUT="$(launch_post "$OWNER_TOKEN" "$BODY")"; CODE="${OUT%%$'\t'*}"; BODYRESP="${OUT#*$'\t'}"
[ "$CODE" = "202" ] && ok "POST accepted (202) → taskId enqueued" || bad "POST → $CODE"
TASK_ID="$(json_field "$BODYRESP" taskId)"
INTENT="$SHADOW_STATE/intents/$OWNER_ID/$TASK_ID.json"

sleep 3  # several supervisor poll cycles

if [ -f "$INTENT" ]; then ok "intent REMAINS on disk (queued, not consumed)"; else bad "intent gone — it launched despite the cap"; fi
if unit_exists "wf-$TASK_ID.service"; then bad "unit exists — the cap did NOT hold"; else ok "no wf-$TASK_ID.service while capped (QUEUED, not launched)"; fi
[ -e "$SHADOW_STATE/tasks/$TASK_ID/DONE" ] && bad "task produced DONE while capped" || ok "no result produced while queued"

MEM_AFTER="$(mem_available_mb)"
note "MemAvailable after queued launch: ${MEM_AFTER}MB"
if [ "$MEM_AFTER" -gt 200 ] && [ "$MEM_AFTER" -ge "$((MEM_BEFORE - 400))" ]; then
  ok "no OOM: memory stable while queued (${MEM_BEFORE}→${MEM_AFTER}MB)"
else
  bad "memory dropped suspiciously (${MEM_BEFORE}→${MEM_AFTER}MB)"
fi

# Free ONE slot → the queued task must launch on the next poll.
first="${DUMMIES[0]}"
kill_wf_unit "$first"
note "freed one slot ($first) — expecting the queued task to launch"
if wait_for_file "$SHADOW_STATE/tasks/$TASK_ID/DONE" 120; then
  ok "queued task LAUNCHED after a slot freed and produced DONE (released from queue)"
  DONE_EC="$(sed -n 's/.*"exit_code":\([0-9-]*\).*/\1/p' "$SHADOW_STATE/tasks/$TASK_ID/DONE")"
  [ "$DONE_EC" = "0" ] && ok "released task DONE exit_code=0" || note "released task DONE exit_code=$DONE_EC"
else
  bad "queued task never launched after freeing a slot"
fi

# cleanup: stop the task unit + remaining dummies.
kill_wf_unit "wf-$TASK_ID.service"
for u in "${DUMMIES[@]}"; do kill_wf_unit "$u"; done
: > "$SHADOW_RUN/dummy-units.txt"
finish
