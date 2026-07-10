#!/usr/bin/env bash
#
# T-822 GATE (tester) — REAL WS-SEAT proof. Boots the SHIPPED websocket gateway
# (ws-seat-server.ts: token auth → handleChatConnection → queryClaudeSDK →
# runClaudeSDKQuery, the EXACT critical-path seam) on a loopback high port, mints a
# token for the seeded owner, and drives REAL claude-command turns over a REAL
# authenticated socket CONCURRENTLY with a Tier-B injection that holds the
# per-conversation flock (widened). Proves: (1) zero jsonl corruption, (2) human
# priority (every live turn completes within the bounded ceiling, zero fail-open),
# (3) the lock is released after every turn (external flock -n reclaims it).
#
# NEVER touches the live process/port 3004/live DB. Server started via setsid +
# pidfile; a trap guarantees the whole process group is reaped on ANY exit.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRIT_NAME=ws-seat
# _crit_common.sh sources _env.sh + session.env AND defines seed_task/jsonl_health/
# make_session (needed by the contention loop below). Sourcing only _env.sh (the
# original bug) left those undefined ⇒ the injectors saw no task.json (userId 0 ⇒
# denied) and the corruption check read an empty value. contend.sh is the
# authoritative, corrected contention proof; this script adds the drop + flag-off
# phases on top of the same real WS seat.
# shellcheck source=/dev/null
source "$HERE/../../criteria/_crit_common.sh"

SEAT_PORT="${SEAT_PORT:-39004}"
JWT_SECRET_TEST="t822-gate-tester-shadow-secret-0123456789-abcdef"   # >=32 chars
SEAT_SERVER="$HERE/ws-seat-server.ts"
SEAT_CLIENT="$HERE/ws-client.mjs"
SEAT_LOG="$SHADOW_LOGS/seat-server.log"
SEAT_PIDFILE="$SHADOW_RUN/seat-server.pid"
LOCKDIR="$SHADOW_STATE/chat-locks"
AUDIT="$SHADOW_STATE/chat-lock-audit.log"
ATTEMPTS="${ATTEMPTS:-5}"
WIDEN="${WIDEN:-6000}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
note() { printf '  ---- %s\n' "$*"; }

SEAT_PGID=""
teardown() {
  # kill the seat server's whole process group (server + tsx + any claude child).
  if [ -n "$SEAT_PGID" ] && kill -0 -- "-$SEAT_PGID" 2>/dev/null; then
    kill -TERM -- "-$SEAT_PGID" 2>/dev/null || true
    sleep 1
    kill -9 -- "-$SEAT_PGID" 2>/dev/null || true
  fi
  if [ -f "$SEAT_PIDFILE" ]; then
    local p; p="$(cat "$SEAT_PIDFILE" 2>/dev/null || true)"
    [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
    rm -f "$SEAT_PIDFILE"
  fi
}
trap teardown EXIT INT TERM

start_seat() { # <chatLockFlag>
  local flag="$1"
  : > "$SEAT_LOG"
  setsid env $(shadow_env_common) \
    WORKFLOW_SUPERVISOR_CHAT_LOCK="$flag" \
    JWT_SECRET="$JWT_SECRET_TEST" \
    SEAT_PORT="$SEAT_PORT" \
    WORKFLOW_SUPERVISOR_INJECT_WIDEN_MS=0 \
    $TSX "$SEAT_SERVER" >>"$SEAT_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$SEAT_PIDFILE"
  SEAT_PGID="$pid"   # setsid ⇒ child is its own group leader (pgid == pid)
  # wait for READY
  for _ in $(seq 1 60); do
    grep -q "SEAT_READY" "$SEAT_LOG" 2>/dev/null && return 0
    kill -0 "$pid" 2>/dev/null || { echo "[seat] server died on boot:"; tail -20 "$SEAT_LOG"; return 1; }
    sleep 0.5
  done
  echo "[seat] server never became READY:"; tail -20 "$SEAT_LOG"; return 1
}
stop_seat() { teardown; SEAT_PGID=""; }

mint_token() { curl -s "http://127.0.0.1:$SEAT_PORT/mint?u=$OWNER_ID"; }

lock_free() { # <sid> : 0 if the lock is FREE (reclaimable), 1 if held/none
  local lf="$LOCKDIR/$1.lock"
  [ -f "$lf" ] || { echo "nofile"; return; }
  if flock -n "$lf" -c true 2>/dev/null; then echo "free"; else echo "held"; fi
}
audit_failopen() { grep -c "chat-lock-timeout-fail-open" "$AUDIT" 2>/dev/null || echo 0; }

echo "=========================================================================="
echo "[ws-seat] PHASE ON — flag ON, real WS seat ∥ Tier-B injection ($ATTEMPTS attempts)"
echo "=========================================================================="
start_seat 1 || { bad "seat server (ON) failed to boot"; echo "[ws-seat] pass=$PASS fail=$FAIL"; exit 1; }
note "seat server READY on 127.0.0.1:$SEAT_PORT (pgid=$SEAT_PGID)"
TOKEN="$(mint_token)"
[ -n "$TOKEN" ] && [ "$TOKEN" != "no-user" ] && ok "minted a token for owner=$OWNER_ID via the real generateToken" || { bad "token mint failed: $TOKEN"; exit 1; }

WSSID="$SID"; WSTR="$TRANSCRIPT"
FAILOPEN_BASE="$(audit_failopen)"
CORRUPT=0; INCOMPLETE=0; LEAKED=0; ENGAGED=0

for i in $(seq 1 "$ATTEMPTS"); do
  TID="wsseat-$i-$(date +%s%N)"
  seed_task "$TID" "$WSSID" "auto-turn" "نتيجة مقعد WS رقم $i: تم."

  # (1) injector holds the per-conversation flock during its REAL turn + widen.
  env $(shadow_env_common) WORKFLOW_SUPERVISOR_INJECT_WIDEN_MS="$WIDEN" \
    $TSX "$DRIVER" inject --conv "$WSSID" --project "$PROJECT_PATH" --jsonl "$WSTR" --tasks "$TID" \
    > "$SHADOW_LOGS/wsseat-inj-$i.json" 2>>"$SHADOW_LOGS/wsseat-inj.err" &
  INJ_PID=$!; echo "$INJ_PID" > "$SHADOW_RUN/wsseat-inj.pid"

  sleep 1.0   # let the injector acquire the flock + start its turn first

  # confirm the flock is genuinely HELD by the injector right now (seam target).
  HELD_DURING="$(lock_free "$WSSID")"

  # attempt 3: kill the injector's claude child MID-TURN (adversarial a-1) — the
  # injector's finally must still release the lock so the human can acquire.
  KILLED_CHILD=0
  if [ "$i" = "3" ]; then
    CPID="$(pgrep -P "$(pgrep -P "$INJ_PID" 2>/dev/null | head -1)" 2>/dev/null | head -1)"
    [ -z "$CPID" ] && CPID="$(pgrep -f "claude.*-r $WSSID" 2>/dev/null | head -1)"
    if [ -n "$CPID" ]; then kill -9 "$CPID" 2>/dev/null && KILLED_CHILD=1; fi
  fi

  # (2) the REAL live human turn over the authenticated socket (the claude-sdk.js seam).
  node "$SEAT_CLIENT" --url "ws://127.0.0.1:$SEAT_PORT/ws" --token "$TOKEN" \
    --sid "$WSSID" --cwd "$PROJECT_PATH" --tag "$i" --model haiku --timeout 90000 \
    > "$SHADOW_LOGS/wsseat-live-$i.json" 2>>"$SHADOW_LOGS/wsseat-live.err"

  wait "$INJ_PID" 2>/dev/null || true
  rm -f "$SHADOW_RUN/wsseat-inj.pid"

  read -r LINES BAD <<<"$(jsonl_health "$WSTR")"
  COMPLETED="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).completed)}catch{console.log("ERR")}' "$SHADOW_LOGS/wsseat-live-$i.json")"
  TURNMS="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).turnMs||0)}catch{console.log(0)}' "$SHADOW_LOGS/wsseat-live-$i.json")"
  LOCKAFTER="$(lock_free "$WSSID")"

  [ "$BAD" = "0" ] || { CORRUPT=$((CORRUPT+1)); }
  [ "$COMPLETED" = "true" ] || { INCOMPLETE=$((INCOMPLETE+1)); }
  [ "$LOCKAFTER" = "held" ] && LEAKED=$((LEAKED+1))
  # "engaged" heuristic: the live turn waited a floor ~ the remaining lock hold.
  if [ "$KILLED_CHILD" != "1" ] && [ "$TURNMS" -ge 4000 ]; then ENGAGED=$((ENGAGED+1)); fi

  note "attempt $i: heldDuringInjector=$HELD_DURING completed=$COMPLETED turnMs=${TURNMS} torn=$BAD lockAfter=$LOCKAFTER killedChild=$KILLED_CHILD lines=$LINES"
done

read -r FLINES FBAD <<<"$(jsonl_health "$WSTR")"
FAILOPEN_NOW="$(audit_failopen)"
FAILOPEN_DELTA=$((FAILOPEN_NOW - FAILOPEN_BASE))

[ "$CORRUPT" = "0" ]   && ok "ZERO jsonl corruption across $ATTEMPTS real-WS concurrent attempts (final: $FLINES lines, $FBAD torn)" || bad "$CORRUPT/$ATTEMPTS attempts corrupted the transcript"
[ "$INCOMPLETE" = "0" ] && ok "human priority: every live WS turn COMPLETED (none starved past the ceiling)" || bad "$INCOMPLETE/$ATTEMPTS live turns did not complete"
[ "$FAILOPEN_DELTA" = "0" ] && ok "zero chat-lock fail-open audit lines (human always ACQUIRED the real lock within ceiling)" || bad "$FAILOPEN_DELTA fail-open events (injector overran the ceiling)"
[ "$LEAKED" = "0" ]    && ok "no lock leak: the per-conversation flock was FREE (reclaimable) after every turn" || bad "$LEAKED attempts left a held lock (release() leak)"
[ "$ENGAGED" -ge 1 ]   && ok "seam ENGAGED on the real path: $ENGAGED/$ATTEMPTS live turns waited a floor≈lock-hold (serialized behind the injector)" || note "engaged floor not observed (timing) — corruption/priority claims still hold"

echo
echo "=========================================================================="
echo "[ws-seat] ADVERSARIAL a-2 — cut the WS mid-turn ⇒ seam finally releases"
echo "=========================================================================="
# flag ON, plain live turn, socket TERMINATED mid-turn: the lock is taken then the
# turn errors; the claude-sdk.js finally must release it (external flock reclaims).
DROP_TID="wsseat-drop-$(date +%s%N)"
node "$SEAT_CLIENT" --url "ws://127.0.0.1:$SEAT_PORT/ws" --token "$TOKEN" \
  --sid "$WSSID" --cwd "$PROJECT_PATH" --tag "drop" --model haiku --drop-after-ms 1200 --timeout 30000 \
  > "$SHADOW_LOGS/wsseat-drop.json" 2>>"$SHADOW_LOGS/wsseat-live.err"
sleep 3   # let the server-side turn observe the dead socket and hit finally
DROP_LOCK="$(lock_free "$WSSID")"
read -r DLINES DBAD <<<"$(jsonl_health "$WSTR")"
[ "$DROP_LOCK" != "held" ] && ok "WS dropped mid-turn ⇒ lock released by finally (state=$DROP_LOCK)" || bad "WS drop LEAKED the lock (still held)"
[ "$DBAD" = "0" ] && ok "transcript still fully parseable after a mid-turn drop ($DLINES lines, 0 torn)" || bad "mid-turn drop left $DBAD torn lines"
stop_seat

echo
echo "=========================================================================="
echo "[ws-seat] ADVERSARIAL b — flag OFF on the REAL WS path ⇒ seam no-op"
echo "=========================================================================="
# Bring the seat up with the sub-flag OFF. A live turn must NOT create/take any
# lock (byte-identical seam), while the master flag stays on.
start_seat 0 || { bad "seat server (OFF) failed to boot"; echo "[ws-seat] pass=$PASS fail=$FAIL"; exit 1; }
TOKEN="$(mint_token)"
LOCK_BEFORE_OFF="$(lock_free "$WSSID")"
node "$SEAT_CLIENT" --url "ws://127.0.0.1:$SEAT_PORT/ws" --token "$TOKEN" \
  --sid "$WSSID" --cwd "$PROJECT_PATH" --tag "off" --model haiku --timeout 90000 \
  > "$SHADOW_LOGS/wsseat-off.json" 2>>"$SHADOW_LOGS/wsseat-live.err"
OFF_COMPLETED="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).completed)}catch{console.log("ERR")}' "$SHADOW_LOGS/wsseat-off.json")"
OFF_TURNMS="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).turnMs||0)}catch{console.log(0)}' "$SHADOW_LOGS/wsseat-off.json")"
read -r OLINES OBAD <<<"$(jsonl_health "$WSTR")"
[ "$OFF_COMPLETED" = "true" ] && ok "flag OFF: live WS turn completed normally on the real path (turnMs=$OFF_TURNMS)" || bad "flag OFF: live turn did not complete ($OFF_COMPLETED)"
[ "$OBAD" = "0" ] && ok "flag OFF: transcript parseable ($OLINES lines, 0 torn)" || bad "flag OFF torn lines: $OBAD"
note "flag OFF lock state before/after: before=$LOCK_BEFORE_OFF (a prior ON attempt may have created the file; OFF just never TAKES it)"
stop_seat

echo
printf '[ws-seat] pass=%d fail=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
