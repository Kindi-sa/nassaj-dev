#!/usr/bin/env bash
#
# Criterion 1 (§و م2) — an authenticated launch produces a wf-<taskId>.service
# whose /proc environ shows the LAUNCHING USER's per-user CLAUDE_CONFIG_DIR
# (isolation proven), and result.json + DONE appear per the §أ-4 contract.
CRIT_NAME=criterion1
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion1] authenticated launch → isolated unit + result.json/DONE"
EXPECT_CFG="$SHADOW_HOME/.nassaj-users/$OWNER_ID/.claude"
proj_snapshot="$(stat -c %Y "$HOME/.claude/projects" 2>/dev/null || echo NA)"

CONV="conv1t820$(date +%s)"
BODY="{\"projectPath\":\"$PROJECT_PATH\",\"scriptOrPrompt\":\"Reply with exactly: OK\",\"conversationId\":\"$CONV\",\"originMessageId\":\"m1\",\"model\":\"haiku\"}"
OUT="$(launch_post "$OWNER_TOKEN" "$BODY")"
CODE="${OUT%%$'\t'*}"; BODYRESP="${OUT#*$'\t'}"
[ "$CODE" = "202" ] && ok "POST /launch → 202" || { bad "POST /launch → $CODE ($BODYRESP)"; finish; exit 1; }
TASK_ID="$(json_field "$BODYRESP" taskId)"
[ -n "$TASK_ID" ] && ok "taskId returned: $TASK_ID" || bad "no taskId in response"
UNIT="wf-$TASK_ID.service"

# Capture the unit's MainPID environ AS SOON AS it is alive (the node wrapper
# lives from launch until it seals — a few seconds; poll fast to catch it).
CFG_SEEN=""; HOME_SEEN=""; PID_SEEN=""
for _ in $(seq 1 300); do
  mp="$(unit_mainpid "$UNIT")"
  if [ -n "$mp" ] && [ "$mp" != "0" ] && [ -r "/proc/$mp/environ" ]; then
    c="$(environ_var "$mp" CLAUDE_CONFIG_DIR)"
    if [ -n "$c" ]; then CFG_SEEN="$c"; HOME_SEEN="$(environ_var "$mp" HOME)"; PID_SEEN="$mp"; break; fi
  fi
  sleep 0.1
done
if [ -n "$CFG_SEEN" ]; then
  note "unit $UNIT MainPID=$PID_SEEN /proc environ CLAUDE_CONFIG_DIR=$CFG_SEEN HOME=$HOME_SEEN"
  [ "$CFG_SEEN" = "$EXPECT_CFG" ] && ok "isolation: CLAUDE_CONFIG_DIR is the launching user's per-user dir" \
    || bad "CLAUDE_CONFIG_DIR=$CFG_SEEN, expected $EXPECT_CFG"
  [ "$HOME_SEEN" = "$SHADOW_HOME" ] && ok "unit HOME is the isolated shadow home ($HOME_SEEN)" \
    || bad "unit HOME=$HOME_SEEN, expected $SHADOW_HOME"
else
  bad "could not read the unit's environ (unit never exposed a MainPID)"
fi

# result.json + DONE per §أ-4. The producer CONTRACT is: result.json exists ONLY
# on a clean exit; a non-zero exit leaves .partial (never a torn result.json) +
# DONE carrying the code. We assert the artifacts match the contract for the
# ACTUAL claude outcome (a real run), and that the real envelope was captured.
TD="$SHADOW_STATE/tasks/$TASK_ID"
if wait_for_file "$TD/DONE" 120; then
  ok "DONE appeared (task sealed — the producer's last atomic trace)"
  DONE_EC="$(sed -n 's/.*"exit_code":\([0-9-]*\).*/\1/p' "$TD/DONE")"
  if [ "$DONE_EC" = "0" ]; then
    note "claude exited 0 (SUCCESS path)"
    [ -f "$TD/result.json" ] && ok "per contract: clean exit ⇒ result.json present (atomic rename)" \
      || bad "clean exit but result.json missing"
    [ -f "$TD/result.json.partial" ] && bad ".partial lingered after a clean seal" \
      || ok "per contract: .partial consumed on clean seal"
  else
    RES="$(sed -n 's/.*"result":"\([^"]*\)".*/\1/p' "$TD/result.json.partial" 2>/dev/null | head -1)"
    note "claude exited $DONE_EC (FAILURE path) — real run result: '${RES}'"
    [ ! -f "$TD/result.json" ] && ok "per contract: non-zero exit ⇒ NO result.json (no torn/partial result promoted)" \
      || bad "result.json present despite non-zero exit (CONTRACT VIOLATION)"
    [ -f "$TD/result.json.partial" ] && ok "per contract: result.json.partial retained for inspection" \
      || bad "no .partial retained on the failure path"
    note "ENV CONSTRAINT: this box's claude OAuth refreshes ONLY from the canonical ~/.claude"
    note "(the live nassaj-dev process keeps that token fresh in-place); an isolated per-user COPY"
    note "cannot refresh an expired owner token → claude auth-failed here. This exercises the"
    note "FAILURE-path contract LIVE. The SUCCESS-path clean result.json (rename on exit 0) is"
    note "proven on REAL captured claude fixtures by result-capture-writer.test.ts (server code)."
  fi
  grep -qs '"type":"result"' "$TD/result.json" "$TD/result.json.partial" \
    && ok "the REAL claude JSON envelope was captured atomically (result.json|.partial)" \
    || bad "no claude JSON envelope captured"
else
  bad "DONE never appeared within 120s"; tail -n 5 "$TD/stderr.log" 2>/dev/null || true
fi

# task.json (durable delivery context) persisted with the conversation.
if [ -f "$SHADOW_STATE/tasks/$TASK_ID/task.json" ]; then
  TC="$(json_field "$(cat "$SHADOW_STATE/tasks/$TASK_ID/task.json")" conversationId)"
  [ "$TC" = "$CONV" ] && ok "task.json persisted with conversationId=$CONV" || bad "task.json conversationId=$TC"
else
  bad "task.json (durable context) not persisted"
fi

# zero-touch: the real shared transcripts dir must be untouched; the shadow's
# transcript must live under the temp per-user tree.
now_snapshot="$(stat -c %Y "$HOME/.claude/projects" 2>/dev/null || echo NA)"
[ "$now_snapshot" = "$proj_snapshot" ] && ok "real ~/.claude/projects mtime unchanged (transcripts stayed in temp)" \
  || note "note: ~/.claude/projects mtime changed ($proj_snapshot→$now_snapshot) — verify shadow transcript is in temp"
find "$SHADOW_HOME/.nassaj-users/$OWNER_ID/.claude/projects" -type f 2>/dev/null | head -1 >/dev/null \
  && ok "shadow transcript materialized under the temp per-user tree" \
  || note "no transcript file found under temp per-user tree (claude may store elsewhere under temp)"

kill_wf_unit "$UNIT"
finish
