#!/usr/bin/env bash
#
# T-822 GATE (tester) — CORRECTED real-WS contention proof. 5 attempts where a
# real authenticated live WS turn (the claude-sdk.js seam) must contend on the
# per-conversation flock that is GENUINELY HELD by the Tier-B side:
#   attempts 1-3: the REAL injector (real claude turn + widen ⇒ it actually writes
#                 the resumed turn to the SAME jsonl, then holds through the
#                 commit→ledger widen). attempt 3 also kills the injector's claude
#                 child mid-turn (adversarial a-1: finally must still release).
#   attempts 4-5: the shipped acquireInjectorTurnLock held for 8s (0-claude, same
#                 flock) — extra live-turn-vs-held-lock samples.
# Before each live turn we POLL until an external flock proves the lock is HELD, so
# contention is guaranteed (not a timing accident). Proves: zero jsonl corruption,
# human priority (every live turn completes, zero fail-open), lock freed after each.
# Guaranteed teardown via trap. Never touches the live process/port/DB.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRIT_NAME=ws-contend
# shellcheck source=/dev/null
source "$HERE/../../criteria/_crit_common.sh"   # gives seed_task, jsonl_health, shadow_env_common, SID, etc.

SEAT_PORT="${SEAT_PORT:-39014}"
JWT_SECRET_TEST="t822-gate-tester-shadow-secret-0123456789-abcdef"
SEAT_LOG="$SHADOW_LOGS/seat-contend.log"; SEAT_PIDFILE="$SHADOW_RUN/seat-contend.pid"; SEAT_PGID=""
LOCKDIR="$SHADOW_STATE/chat-locks"; AUDIT="$SHADOW_STATE/chat-lock-audit.log"
HOLDER="$HERE/hold-injector-lock.ts"; CLIENT="$HERE/ws-client.mjs"; SERVER="$HERE/ws-seat-server.ts"
WIDEN="${WIDEN:-6000}"

teardown(){ [ -n "$SEAT_PGID" ] && kill -9 -- "-$SEAT_PGID" 2>/dev/null || true; [ -f "$SEAT_PIDFILE" ] && kill -9 "$(cat "$SEAT_PIDFILE" 2>/dev/null)" 2>/dev/null; rm -f "$SEAT_PIDFILE"
  for f in "$SHADOW_RUN"/contend-*.pid; do [ -e "$f" ] || continue; kill -9 "$(cat "$f" 2>/dev/null)" 2>/dev/null || true; rm -f "$f"; done; }
trap teardown EXIT INT TERM

: > "$SEAT_LOG"
setsid env $(shadow_env_common) WORKFLOW_SUPERVISOR_CHAT_LOCK=1 JWT_SECRET="$JWT_SECRET_TEST" SEAT_PORT="$SEAT_PORT" \
  $TSX "$SERVER" >>"$SEAT_LOG" 2>&1 &
SPID=$!; echo "$SPID" > "$SEAT_PIDFILE"; SEAT_PGID="$SPID"
for _ in $(seq 1 60); do grep -q SEAT_READY "$SEAT_LOG" && break; kill -0 "$SPID" 2>/dev/null || { bad "seat died on boot"; tail -20 "$SEAT_LOG"; finish; exit 1; }; sleep 0.5; done
grep -q SEAT_READY "$SEAT_LOG" || { bad "seat never READY"; tail -20 "$SEAT_LOG"; finish; exit 1; }
note "seat READY 127.0.0.1:$SEAT_PORT (pgid=$SEAT_PGID)"
TOKEN="$(curl -s "http://127.0.0.1:$SEAT_PORT/mint?u=$OWNER_ID")"
[ -n "$TOKEN" ] && [ "$TOKEN" != "no-user" ] && ok "minted real owner token (len=${#TOKEN})" || { bad "mint failed: $TOKEN"; finish; exit 1; }

lock_state(){ local lf="$LOCKDIR/$1.lock"; [ -f "$lf" ] || { echo nofile; return; }; if flock -n "$lf" -c true 2>/dev/null; then echo free; else echo held; fi; }
wait_held(){ local sid="$1" n="${2:-30}"; for _ in $(seq 1 "$n"); do [ "$(lock_state "$sid")" = held ] && return 0; sleep 0.5; done; return 1; }
failopen_ct(){ grep -c chat-lock-timeout-fail-open "$AUDIT" 2>/dev/null || echo 0; }

WSSID="$SID"; WSTR="$TRANSCRIPT"
FO_BASE="$(failopen_ct)"
CORRUPT=0; INCOMPLETE=0; LEAKED=0; NOCONTEND=0; WROTE_INJ=0

for i in 1 2 3 4 5; do
  HOLDKIND="injector"; [ "$i" -ge 4 ] && HOLDKIND="lockholder"
  read -r PRE_L PRE_B <<<"$(jsonl_health "$WSTR")"

  if [ "$HOLDKIND" = injector ]; then
    TID="ctnd-$i-$(date +%s%N)"
    seed_task "$TID" "$WSSID" "auto-turn" "نتيجة تنازع WS رقم $i: تم."
    env $(shadow_env_common) WORKFLOW_SUPERVISOR_INJECT_WIDEN_MS="$WIDEN" \
      $TSX "$DRIVER" inject --conv "$WSSID" --project "$PROJECT_PATH" --jsonl "$WSTR" --tasks "$TID" \
      > "$SHADOW_LOGS/ctnd-inj-$i.json" 2>>"$SHADOW_LOGS/ctnd-inj.err" &
    HPID=$!
  else
    env $(shadow_env_common) $TSX "$HOLDER" --conv "$WSSID" --hold-ms 9000 \
      > "$SHADOW_LOGS/ctnd-hold-$i.json" 2>>"$SHADOW_LOGS/ctnd-hold.err" &
    HPID=$!
  fi
  echo "$HPID" > "$SHADOW_RUN/contend-$i.pid"

  if ! wait_held "$WSSID" 30; then
    NOCONTEND=$((NOCONTEND+1)); note "attempt $i ($HOLDKIND): lock never became HELD — NOT a valid contention"; wait "$HPID" 2>/dev/null || true; rm -f "$SHADOW_RUN/contend-$i.pid"; continue
  fi

  # attempt 3: kill the injector's real claude child mid-turn (adversarial a-1).
  KILLED=0
  if [ "$i" = 3 ]; then
    CPID="$(pgrep -f "claude.*-r ${WSSID}" 2>/dev/null | head -1)"
    [ -n "$CPID" ] && kill -9 "$CPID" 2>/dev/null && KILLED=1
  fi

  # the REAL live human turn over the authenticated socket — must WAIT then acquire.
  node "$CLIENT" --url "ws://127.0.0.1:$SEAT_PORT/ws" --token "$TOKEN" \
    --sid "$WSSID" --cwd "$PROJECT_PATH" --tag "$i" --model haiku --timeout 90000 \
    > "$SHADOW_LOGS/ctnd-live-$i.json" 2>>"$SHADOW_LOGS/ctnd-live.err"

  wait "$HPID" 2>/dev/null || true; rm -f "$SHADOW_RUN/contend-$i.pid"

  read -r L B <<<"$(jsonl_health "$WSTR")"
  COMP="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).completed)}catch{console.log("ERR")}' "$SHADOW_LOGS/ctnd-live-$i.json")"
  TMS="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).turnMs||0)}catch{console.log(0)}' "$SHADOW_LOGS/ctnd-live-$i.json")"
  LAFTER="$(lock_state "$WSSID")"
  INJEV="n/a"; [ "$HOLDKIND" = injector ] && INJEV="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).event)}catch{console.log("ERR")}' "$SHADOW_LOGS/ctnd-inj-$i.json")"
  # did the injector actually WRITE a resumed turn (more lines) before the live turn?
  [ "$HOLDKIND" = injector ] && [ "$INJEV" = delivered ] && WROTE_INJ=$((WROTE_INJ+1))

  [ "$B" = 0 ] || CORRUPT=$((CORRUPT+1))
  [ "$COMP" = true ] || INCOMPLETE=$((INCOMPLETE+1))
  [ "$LAFTER" = held ] && LEAKED=$((LEAKED+1))
  note "attempt $i ($HOLDKIND): contendHeld=yes injEvent=$INJEV killedChild=$KILLED liveCompleted=$COMP turnMs=$TMS tornTotal=$B lockAfter=$LAFTER lines($PRE_L→$L)"
done

echo
read -r FL FB <<<"$(jsonl_health "$WSTR")"
FO_DELTA=$(( $(failopen_ct) - FO_BASE ))
[ "$NOCONTEND" = 0 ] && ok "all 5 attempts achieved a genuinely HELD lock (real contention, not a timing accident)" || bad "$NOCONTEND/5 attempts failed to establish contention"
[ "$WROTE_INJ" -ge 1 ] && ok "the REAL injector committed a resumed turn to the SAME jsonl in $WROTE_INJ attempt(s) (concurrent WRITE tested)" || bad "no real injector delivery observed — concurrent-write dimension not exercised"
[ "$CORRUPT" = 0 ] && ok "ZERO jsonl corruption across 5 real-WS contended attempts (final: $FL lines, $FB torn)" || bad "$CORRUPT/5 attempts corrupted the transcript"
[ "$INCOMPLETE" = 0 ] && ok "human priority: every contended live WS turn COMPLETED (acquired within the ceiling)" || bad "$INCOMPLETE/5 live turns did not complete"
[ "$FO_DELTA" = 0 ] && ok "zero chat-lock fail-open events (human always ACQUIRED cleanly, never forced open)" || bad "$FO_DELTA fail-open events"
[ "$LEAKED" = 0 ] && ok "no lock leak: flock FREE (reclaimable) after every contended turn" || bad "$LEAKED attempts leaked a held lock"
finish
