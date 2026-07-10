#!/usr/bin/env bash
# Minimal smoke: boot the seat server (flag ON), one plain live WS turn, verify the
# real seam takes+releases the lock. Guaranteed teardown via trap. ~1 claude run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../_env.sh"
source "$SHADOW_RUN/session.env"
SEAT_PORT="${SEAT_PORT:-39004}"
JWT_SECRET_TEST="t822-gate-tester-shadow-secret-0123456789-abcdef"
LOG="$SHADOW_LOGS/seat-smoke.log"; PIDF="$SHADOW_RUN/seat-smoke.pid"; PGID=""
teardown(){ [ -n "$PGID" ] && kill -9 -- "-$PGID" 2>/dev/null || true; [ -f "$PIDF" ] && kill -9 "$(cat "$PIDF")" 2>/dev/null; rm -f "$PIDF"; }
trap teardown EXIT INT TERM
: > "$LOG"
setsid env $(shadow_env_common) WORKFLOW_SUPERVISOR_CHAT_LOCK=1 JWT_SECRET="$JWT_SECRET_TEST" SEAT_PORT="$SEAT_PORT" \
  $TSX "$HERE/ws-seat-server.ts" >>"$LOG" 2>&1 &
PID=$!; echo "$PID" > "$PIDF"; PGID="$PID"
for _ in $(seq 1 60); do grep -q SEAT_READY "$LOG" && break; kill -0 "$PID" 2>/dev/null || { echo "DIED:"; tail -25 "$LOG"; exit 1; }; sleep 0.5; done
grep -q SEAT_READY "$LOG" || { echo "NO READY:"; tail -25 "$LOG"; exit 1; }
echo "[smoke] READY: $(grep SEAT_READY "$LOG")"
TOKEN="$(curl -s "http://127.0.0.1:$SEAT_PORT/mint?u=$OWNER_ID")"
echo "[smoke] token len=${#TOKEN}"
node "$HERE/ws-client.mjs" --url "ws://127.0.0.1:$SEAT_PORT/ws" --token "$TOKEN" --sid "$SID" --cwd "$PROJECT_PATH" --tag smoke --model haiku --timeout 90000
LF="$SHADOW_STATE/chat-locks/$SID.lock"
if [ -f "$LF" ]; then flock -n "$LF" -c true 2>/dev/null && echo "[smoke] lock FREE after turn (released)" || echo "[smoke] lock STILL HELD (leak!)"; else echo "[smoke] no lock file"; fi
read -r L B <<<"$("$NODE_BIN" -e 'const fs=require("fs");const p=process.argv[1];const ls=fs.readFileSync(p,"utf8").split("\n").filter(Boolean);let b=0;for(const l of ls){try{JSON.parse(l)}catch{b++}}console.log(ls.length+" "+b)' "$TRANSCRIPT")"
echo "[smoke] transcript: $L lines, $B torn"
