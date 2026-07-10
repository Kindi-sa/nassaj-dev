#!/usr/bin/env bash
#
# Criterion 4 (§و م2) — the master no-op. With WORKFLOW_SUPERVISOR OFF the launch
# route is effectively ABSENT (404) and writes ZERO state; the rest of the server
# behaves normally. Proven on a dedicated flag-OFF instance (same temp DB/state).
CRIT_NAME=criterion4
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion4] flag OFF ⇒ route 404 + zero side effects (byte-identical no-op)"

# Start a throwaway flag-OFF server on the OFF port. WORKFLOW_SUPERVISOR=0 is an
# explicit FALSY value: isSupervisorEnabled treats only 1/true/yes/on as ON, and
# because it is pre-set, load-env cannot re-enable it from a future .env (the
# flag-trap that would otherwise defeat this). SERVER_PORT (not PORT) is the knob.
nohup env $(shadow_env_common) WORKFLOW_SUPERVISOR=0 SERVER_PORT="$SHADOW_PORT_OFF" \
  "$NODE_BIN" "$SERVER_ENTRY" > "$SHADOW_LOGS/server-off.log" 2>&1 < /dev/null &
OFF_PID=$!
echo "$OFF_PID" > "$SHADOW_RUN/server-off.pid"
BASE_OFF="http://127.0.0.1:$SHADOW_PORT_OFF"

# Wait for a STABLE listener: two consecutive good probes (the boot briefly flaps
# the listener, so a single 200 is not enough to POST against).
stable=0
for _ in $(seq 1 90); do
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE_OFF/api/auth/status" 2>/dev/null || echo 000)"
  if [ "$code" != "000" ]; then stable=$((stable+1)); [ "$stable" -ge 2 ] && break; else stable=0; fi
  kill -0 "$OFF_PID" 2>/dev/null || break
  sleep 0.5
done
[ "$stable" -ge 2 ] && ok "flag-off server up (stable) on $BASE_OFF" || { bad "flag-off server did not stabilize"; tail -n 20 "$SHADOW_LOGS/server-off.log" >&2; finish; exit 1; }

# Confirm the flag is genuinely OFF in the process (from /proc — no trust).
PROC_FLAG="$(environ_var "$OFF_PID" WORKFLOW_SUPERVISOR)"
case "$PROC_FLAG" in
  ""|0|false|no|off) ok "process env WORKFLOW_SUPERVISOR is OFF ('${PROC_FLAG}')" ;;
  *) bad "flag is ON in the off process: '$PROC_FLAG'" ;;
esac

# The launch route must 404 (route effectively absent) and write nothing. NOTE:
# target the flag-OFF server (BASE_OFF), NOT the main flag-ON one.
CONV="conv4off$(date +%s)"
BODY="{\"projectPath\":\"$PROJECT_PATH\",\"scriptOrPrompt\":\"x\",\"conversationId\":\"$CONV\",\"originMessageId\":\"m\",\"model\":\"haiku\"}"
# Retry the POST until it connects (ride out any residual boot flap); a stable
# flag-off server returns 404 deterministically.
CODE=000
for _ in $(seq 1 10); do
  CODE="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE_OFF/api/workflow-supervisor/launch" \
    -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' -d "$BODY" 2>/dev/null || echo 000)"
  [ "$CODE" != "000" ] && break
  sleep 0.5
done
[ "$CODE" = "404" ] && ok "POST /launch (flag off) → 404 (route absent)" || bad "flag-off route → $CODE (expected 404)"

sleep 1
if grep -rqs "$CONV" "$SHADOW_STATE" 2>/dev/null; then bad "flag-off request left state on disk"; else ok "flag-off request wrote ZERO state (no intent, no task)"; fi

# The rest of the server is unaffected: a normal public endpoint still answers.
STATUS_CODE="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$BASE_OFF/api/auth/status" 2>/dev/null || echo 000)"
[ "$STATUS_CODE" != "000" ] && [ "$STATUS_CODE" != "404" ] && ok "rest of the server behaves normally (/api/auth/status → $STATUS_CODE)" \
  || bad "server misbehaved with the flag off (/api/auth/status → $STATUS_CODE)"

# teardown the flag-off instance.
kill "$OFF_PID" 2>/dev/null || true
for _ in $(seq 1 20); do kill -0 "$OFF_PID" 2>/dev/null || break; sleep 0.2; done
kill -9 "$OFF_PID" 2>/dev/null || true
rm -f "$SHADOW_RUN/server-off.pid"
finish
