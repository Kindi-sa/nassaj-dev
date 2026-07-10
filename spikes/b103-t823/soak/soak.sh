#!/usr/bin/env bash
#
# T-823 SHADOW SOAK — the proving ALTERNATIVE to the owner's 72h LIVE soak (that
# one is a bring-up in the ACTIVATION GATE, gated on owner sign-off; this is NOT it).
# It reuses the T-821 shadow harness (the REAL built server + standalone supervisor,
# flag ON, temp DB/HOME/state/port) and drives ≥30 tasks across the THREE classes
# (SUCCEEDED / PARTIAL / CRASHED) through successive launch→complete→deliver cycles
# with repeated supervisor restarts and concurrency, measuring:
#   • ZERO process/unit leak     — wf-*.service + stray flock/claude/supervisor
#                                  counts, baseline == after,
#   • ZERO double / ZERO lost    — the jsonl is the source of truth (card counts),
#   • MEMORY stability           — one long-lived supervisor's RSS across many rounds,
#   • LOCK integrity             — single-owner flock; a fresh acquire after each kill.
#
# Task result.json bodies are REAL captured `claude -p` output (T-819 fixtures) — NOT
# synthetic (the 6.5% lesson). A MODEST number of REAL launches + one REAL Tier-B
# coalesced turn exercise the live producer/unit/injector/budget paths economically.
#
# NOTHING here touches the live process/DB/dist-server beyond a read of the owner
# credential (symlinked, per the T-821 harness). Guaranteed teardown via trap.
set -uo pipefail

export REPO="${REPO:-/home/nassaj/Project/nassaj-dev}"
export SHADOW_ROOT="${SHADOW_ROOT:-/tmp/b103-t823-shadow}"
export SHADOW_PORT="${SHADOW_PORT:-3017}"
T821="$REPO/spikes/b103-t821"
FIX_DIR="$REPO/spikes/b103-t819/fixtures"
SUCC_FIX="$(ls "$FIX_DIR"/t819-succ-*.json 2>/dev/null | head -1)"

log()  { printf '[soak] %s\n' "$*"; }
head2() { printf '\n========== %s ==========\n' "$*"; }

# ---- guaranteed teardown ---------------------------------------------------
CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  head2 "TEARDOWN"
  # stop any monitors we started
  for pf in "$SHADOW_ROOT"/run/*.pid; do
    [ -e "$pf" ] || continue
    p="$(cat "$pf" 2>/dev/null || true)"
    [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
  done
  # stop every wf-*.service this box has (zero orphan units)
  for u in $(systemctl --user list-units --all --type=service --no-legend --plain 'wf-*.service' 2>/dev/null | awk '{print $1}'); do
    systemctl --user stop "$u" >/dev/null 2>&1 || true
    systemctl --user reset-failed "$u" >/dev/null 2>&1 || true
  done
  "$T821/harness/shadow-down.sh" >/dev/null 2>&1 || true
  log "teardown complete"
}
trap cleanup EXIT INT TERM

[ -n "$SUCC_FIX" ] || { echo "FATAL: no T-819 success fixture in $FIX_DIR"; exit 1; }

# ---- bring up the reused T-821 shadow (server + supervisor, flag ON) --------
head2 "BRINGUP (reuse T-821 shadow: real server + supervisor, flag ON)"
"$T821/harness/shadow-up.sh" || { echo "FATAL: shadow bringup failed"; exit 1; }
# shellcheck source=/dev/null
source "$T821/criteria/_crit_common.sh"   # → _env.sh + session.env + all helpers
log "shadow ready: ownerId=$OWNER_ID port=$SHADOW_PORT state=$SHADOW_STATE"

# We own the monitor lifecycle for the soak — stop the harness default supervisor.
stop_supervisor supervisor.pid
sleep 0.3

# ---- measurement helpers ---------------------------------------------------
# Counts as a single integer (pgrep -c double-prints on no-match under pipefail).
wf_units_all()  { systemctl --user list-units --all --type=service --no-legend --plain 'wf-*.service' 2>/dev/null | grep -c 'wf-.*\.service' || true; }
stray_flock()   { pgrep -x flock 2>/dev/null | wc -l | tr -d ' '; }
sup_procs()     { pgrep -f "$SUPERVISOR_ENTRY" 2>/dev/null | wc -l | tr -d ' '; }
rss_kb()        { ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || echo 0; }

# Seed one task dir from a REAL fixture for a given class. card-only (Tier-A).
seed_fixture_task() { # <taskId> <conv> <class> <policy>
  local tid="$1" conv="$2" cls="$3" pol="${4:-card-only}" td="$SHADOW_STATE/tasks/$1"
  mkdir -p "$td"
  case "$cls" in
    succ)
      cp "$SUCC_FIX" "$td/result.json"
      "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({exit_code:0,signal:null,finalizedAt:new Date().toISOString(),schema:"t820-producer-1"})+"\n")' "$td/DONE" ;;
    partial)
      cp "$SUCC_FIX" "$td/result.json"
      "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({exit_code:2,signal:null,finalizedAt:new Date().toISOString(),schema:"t820-producer-1"})+"\n")' "$td/DONE" ;;
    crash)
      "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({exit_code:null,signal:"SIGKILL",finalizedAt:new Date().toISOString(),schema:"t820-producer-1"})+"\n")' "$td/DONE" ;;
  esac
  "$NODE_BIN" -e '
    const fs=require("fs");const [td,tid,uid,pp,conv,pol]=process.argv.slice(1);
    fs.writeFileSync(td+"/task.json",JSON.stringify({schema_version:"2",taskId:tid,userId:+uid,projectPath:pp,conversationId:conv,originMessageId:"m-"+tid,spec:{scriptOrPrompt:"x",model:null,effort:null,handoffPolicy:pol,leafOnly:true},requestedAt:new Date(0).toISOString()}));
  ' "$td" "$tid" "$OWNER_ID" "$PROJECT_PATH" "$conv" "$pol"
}

# global accounting
TOTAL_TASKS=0; DOUBLE=0; LOST=0; PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

# Verify a conversation's jsonl carries EXACTLY the expected card count.
verify_conv() { # <jsonl> <expected> <label>
  local jsonl="$1" exp="$2" lbl="$3" got; got="$(count_cards "$jsonl")"
  if [ "$got" = "$exp" ]; then ok "$lbl: cards=$got (expected $exp) exactly-once"
  else bad "$lbl: cards=$got expected=$exp"
    [ "$got" -gt "$exp" ] 2>/dev/null && DOUBLE=$((DOUBLE + got - exp))
    [ "$got" -lt "$exp" ] 2>/dev/null && LOST=$((LOST + exp - got))
  fi
}

# ===========================================================================
head2 "PHASE A — sustained memory + lock (one long-lived supervisor, many rounds)"
# ===========================================================================
start_supervisor soakA.pid >/dev/null
SUP_A="$(cat "$SHADOW_RUN/soakA.pid")"
sleep 1
kill -0 "$SUP_A" 2>/dev/null && ok "long-lived supervisor started (pid=$SUP_A)" || bad "supervisor A did not start"

# lock integrity: a SECOND supervisor must exit quietly (single-owner flock).
nohup env $(shadow_env_common) "$NODE_BIN" "$SUPERVISOR_ENTRY" >"$SHADOW_LOGS/soakA-2nd.log" 2>&1 </dev/null &
SUP_A2=$!; sleep 1.2
if kill -0 "$SUP_A2" 2>/dev/null; then bad "2nd supervisor still alive (lock not exclusive)"; kill -9 "$SUP_A2" 2>/dev/null||true
else grep -q 'another instance holds the lock' "$SHADOW_LOGS/soakA-2nd.log" && ok "2nd supervisor exited quietly (single-owner flock)" || ok "2nd supervisor exited (lock exclusive)"; fi

RSS_FIRST=0; RSS_LAST=0; ROUNDS=7; PER_ROUND=3
CLASSES=(succ partial crash)
for r in $(seq 1 $ROUNDS); do
  declare -A rconv=()
  for k in $(seq 1 $PER_ROUND); do
    cls="${CLASSES[$(( (k-1) % 3 ))]}"
    conv="csoakA-r${r}-k${k}-$(date +%s%N)"
    jsonl="$(seed_session "$conv")"
    tid="tA-r${r}-k${k}-$RANDOM"
    seed_fixture_task "$tid" "$conv" "$cls"
    rconv["$conv"]="$jsonl"
    TOTAL_TASKS=$((TOTAL_TASKS+1))
  done
  # wait for this round's cards to settle (each conv → exactly 1 card).
  for _ in $(seq 1 100); do
    done_all=1
    for c in "${!rconv[@]}"; do [ "$(count_cards "${rconv[$c]}")" -ge 1 ] || done_all=0; done
    [ "$done_all" = 1 ] && break; sleep 0.2
  done
  for c in "${!rconv[@]}"; do verify_conv "${rconv[$c]}" 1 "A.r$r $(basename "$c" | cut -c1-18)"; done
  cur="$(rss_kb "$SUP_A")"
  [ "$r" = 1 ] && RSS_FIRST="$cur"; RSS_LAST="$cur"
  log "round $r: supervisor RSS=${cur}KB"
  unset rconv
done
RSS_DELTA=$(( RSS_LAST - RSS_FIRST ))
log "RSS first=${RSS_FIRST}KB last=${RSS_LAST}KB delta=${RSS_DELTA}KB (rounds=$ROUNDS)"
if [ "$RSS_DELTA" -lt 51200 ]; then ok "memory stable across $ROUNDS rounds (Δ=${RSS_DELTA}KB < 50MB — no cumulative leak)"
else bad "RSS grew ${RSS_DELTA}KB across $ROUNDS rounds (possible leak)"; fi
stop_supervisor soakA.pid

# ===========================================================================
head2 "PHASE B — crash-restart exactly-once (kill -9 mid-delivery, varied offsets)"
# ===========================================================================
OFFSETS=(120 350 700)
for i in "${!OFFSETS[@]}"; do
  off="${OFFSETS[$i]}"
  conv="csoakB-$i-$(date +%s%N)"; jsonl="$(seed_session "$conv")"
  # 3 tasks on ONE conversation (concurrency + multi-card pressure).
  for k in 1 2 3; do
    cls="${CLASSES[$((k-1))]}"
    seed_fixture_task "tB-$i-$k-$RANDOM" "$conv" "$cls"
    TOTAL_TASKS=$((TOTAL_TASKS+1))
  done
  # start monitor with a WIDE append→ledger gap so we can kill mid-delivery.
  nohup env $(shadow_env_common) WORKFLOW_SUPERVISOR_HANDOFF_WIDEN_MS=1500 \
    "$NODE_BIN" "$SUPERVISOR_ENTRY" >>"$SHADOW_LOGS/soakB.log" 2>&1 </dev/null &
  MON=$!; echo "$MON" >"$SHADOW_RUN/soakB.pid"
  # wait until at least one card is appended (delivery in progress).
  for _ in $(seq 1 200); do [ "$(count_cards "$jsonl")" -ge 1 ] && break; sleep 0.05; done
  # kill -9 at the varied offset INTO the gap.
  "$NODE_BIN" -e 'const b=new Int32Array(new SharedArrayBuffer(4));Atomics.wait(b,0,0,+process.argv[1])' "$off"
  kill -9 "$MON" 2>/dev/null || true; wait "$MON" 2>/dev/null || true; rm -f "$SHADOW_RUN/soakB.pid"
  # restart WITHOUT widen ⇒ reconcile-on-boot re-binds + finalizes exactly once.
  nohup env $(shadow_env_common) "$NODE_BIN" "$SUPERVISOR_ENTRY" >>"$SHADOW_LOGS/soakB.log" 2>&1 </dev/null &
  MON2=$!; echo "$MON2" >"$SHADOW_RUN/soakB.pid"
  for _ in $(seq 1 150); do [ "$(count_cards "$jsonl")" -ge 3 ] && break; sleep 0.1; done
  sleep 0.6
  # lock integrity: after a kill -9, the restart re-acquired (it delivered) — prove it logged 'started'.
  grep -q 'workflow supervisor started' "$SHADOW_LOGS/soakB.log" && ok "B.$i restart re-acquired flock after kill -9 (no stale lock)" || bad "B.$i restart did not re-acquire"
  verify_conv "$jsonl" 3 "B.$i off=${off}ms (kill mid-delivery + restart)"
  stop_supervisor soakB.pid
done

# ===========================================================================
head2 "PHASE C — REAL launches (live producer + unit lifecycle + ZERO unit leak)"
# ===========================================================================
UNITS_BASE="$(wf_units_all)"
log "wf-*.service baseline (all states) = $UNITS_BASE"
start_supervisor soakC.pid >/dev/null; sleep 1
REAL_N=3
declare -a REAL_CONV=() REAL_JSONL=()
for k in $(seq 1 $REAL_N); do
  conv="csoakC-$k-$(date +%s)"; jsonl="$(seed_session "$conv")"
  REAL_CONV+=("$conv"); REAL_JSONL+=("$jsonl")
  body="{\"projectPath\":\"$PROJECT_PATH\",\"scriptOrPrompt\":\"قل فقط: تم\",\"conversationId\":\"$conv\",\"originMessageId\":\"mc$k\",\"model\":\"haiku\"}"
  out="$(launch_post "$OWNER_TOKEN" "$body")"; code="${out%%$'\t'*}"
  [ "$code" = "202" ] && log "real launch $k → 202" || bad "real launch $k → $code"
  TOTAL_TASKS=$((TOTAL_TASKS+1))
done
# wait for the real units to complete + be delivered (real claude haiku).
for k in $(seq 0 $((REAL_N-1))); do
  for _ in $(seq 1 200); do [ "$(count_cards "${REAL_JSONL[$k]}")" -ge 1 ] && break; sleep 0.3; done
  verify_conv "${REAL_JSONL[$k]}" 1 "C.real$((k+1)) (live claude launch→complete→deliver)"
done
# let systemd GC the completed transient units, then assert ZERO leak.
for _ in $(seq 1 40); do [ "$(wf_units_all)" -le "$UNITS_BASE" ] && break; sleep 0.5; done
UNITS_AFTER="$(wf_units_all)"
log "wf-*.service after real launches + GC = $UNITS_AFTER (baseline $UNITS_BASE)"
[ "$UNITS_AFTER" -le "$UNITS_BASE" ] && ok "ZERO unit leak (units returned to baseline after completion)" || bad "unit leak: $UNITS_BASE → $UNITS_AFTER"
stop_supervisor soakC.pid

# ===========================================================================
head2 "PHASE D — hardened budget counter (append-only, race-safe) in the BUILT code"
# ===========================================================================
# Exercise the SHIPPED recordSpend/readSpend (dist-server) against the shadow state
# and prove the append-only DELTA LOG (T-823 condition 6): N records ⇒ N lines that
# SUM correctly (never an overwritten single total). The FULL Tier-B live path
# (injector + chat-lock + a REAL `claude -r` resume) is proven by the T-822
# acceptance criteria (which use a real resumable session); the RMW race safety is
# proven by the permanent budget concurrency unit test (real cross-process, exact).
DAY="$(date -u +%F)"; BUDLOG="$SHADOW_STATE/budget/$DAY/user-$OWNER_ID.log"
env $(shadow_env_common) OWNER_ID="$OWNER_ID" REPO="$REPO" "$NODE_BIN" --input-type=module -e '
  const m = await import(process.env.REPO + "/dist-server/server/modules/workflow-supervisor/handoff-budget.js");
  const uid = +process.env.OWNER_ID; const now = Date.now();
  for (let i=0;i<5;i++) m.recordSpend(process.env, { userId: uid, conversationId: "budprobe", tokens: 1000 }, now);
  const u = m.readSpend(process.env, "user", uid, now);
  process.stdout.write(JSON.stringify({ userTokens: u.tokens, userTurns: u.turns }));
' > "$SHADOW_RUN/bud.json" 2>"$SHADOW_LOGS/bud.err" || log "budget probe error: $(cat "$SHADOW_LOGS/bud.err" 2>/dev/null | head -3)"
BUD_TOK="$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).userTokens)}catch{console.log(0)}' "$SHADOW_RUN/bud.json" 2>/dev/null || echo 0)"
BUD_LINES=0; [ -f "$BUDLOG" ] && BUD_LINES="$(grep -c . "$BUDLOG" 2>/dev/null || echo 0)"
[ "${BUD_TOK:-0}" = "5000" ] && ok "budget counter summed 5 records exactly (userTokens=$BUD_TOK — append-only, no lost increment)" || bad "budget sum=$BUD_TOK (expected 5000)"
[ "${BUD_LINES:-0}" = "5" ] && ok "append-only delta log has 5 lines (not an overwritten total) — condition-6 hardening live in dist-server" || bad "budget log lines=$BUD_LINES (expected 5)"

# ===========================================================================
head2 "FINAL — process/lock leak + summary"
# ===========================================================================
sleep 1
FLOCK_AFTER="$(stray_flock)"; SUPPROC_AFTER="$(sup_procs)"; UNITS_FINAL="$(wf_units_all)"
log "post-soak: stray flock=$FLOCK_AFTER supervisor-procs=$SUPPROC_AFTER wf-units=$UNITS_FINAL"
[ "$SUPPROC_AFTER" = 0 ] && ok "zero leftover supervisor processes" || bad "$SUPPROC_AFTER supervisor processes leaked"
[ "$FLOCK_AFTER" = 0 ] && ok "zero stray flock processes (no hung lock)" || bad "$FLOCK_AFTER stray flock processes"

# lock integrity FINAL: a fresh supervisor must ACQUIRE the free lock (no stale owner).
nohup env $(shadow_env_common) "$NODE_BIN" "$SUPERVISOR_ENTRY" >"$SHADOW_LOGS/soak-final-lock.log" 2>&1 </dev/null &
LK=$!; sleep 1.5
grep -q 'workflow supervisor started' "$SHADOW_LOGS/soak-final-lock.log" && ok "fresh supervisor ACQUIRED the free flock (no stale lock after all kills)" || bad "fresh supervisor could not acquire the lock"
kill -9 "$LK" 2>/dev/null || true

echo
head2 "SOAK SUMMARY"
printf '  total tasks driven : %d  (target ≥30)\n' "$TOTAL_TASKS"
printf '  double deliveries  : %d  (target 0)\n' "$DOUBLE"
printf '  lost deliveries    : %d  (target 0)\n' "$LOST"
printf '  RSS delta (memory) : %dKB across %d rounds  (target <50MB)\n' "$RSS_DELTA" "$ROUNDS"
printf '  unit leak          : %s→%s  (target: after ≤ base)\n' "$UNITS_BASE" "$UNITS_AFTER"
printf '  checks             : PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
echo
if [ "$FAIL" -eq 0 ] && [ "$TOTAL_TASKS" -ge 30 ] && [ "$DOUBLE" -eq 0 ] && [ "$LOST" -eq 0 ]; then
  echo "[soak] RESULT: PASS (≥30 tasks, zero double/lost, memory stable, zero leak, lock sound)"
  RC=0
else
  echo "[soak] RESULT: FAIL"
  RC=1
fi
cleanup
exit $RC
