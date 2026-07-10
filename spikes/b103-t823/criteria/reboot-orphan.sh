#!/usr/bin/env bash
#
# T-823 item 2 — PROVE reboot semantics on the shadow: a transient wf-*.service does
# NOT survive a reboot and is NEVER auto-resumed; it is surfaced as a VISIBLE orphan.
# Simulation of reboot = create a REAL live wf unit (task "running") → TEAR IT DOWN
# (transient units die on reboot) → boot a FRESH supervisor. Assert the supervisor:
#   (a) audits the task as `reboot-orphan` with resumed:false,
#   (b) surfaces it as a VISIBLE CRASHED "did not complete" card in the transcript,
#   (c) does NOT relaunch it (the unit is NOT recreated).
# Light bringup: temp DB + seeded owner/project/session + the standalone supervisor
# (NO server, NO real claude — card-only delivery). Guaranteed teardown via trap.
set -uo pipefail

export REPO="${REPO:-/home/nassaj/Project/nassaj-dev}"
export SHADOW_ROOT="${SHADOW_ROOT:-/tmp/b103-t823-reboot}"
export SHADOW_PORT="${SHADOW_PORT:-3019}"   # unused (no server) — set to avoid _env collision
# shellcheck source=/dev/null
source "$REPO/spikes/b103-t821/harness/_env.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
log() { printf '[reboot-orphan] %s\n' "$*"; }

# Count VALID (JSON.parse-able) task_reconcile cards carrying a handoffId (local
# copy — _crit_common.sh is not sourced here since this is a light, server-less bringup).
count_cards() {
  [ -f "$1" ] || { echo 0; return; }
  "$NODE_BIN" -e '
    const fs=require("fs");
    const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
    let n=0; for(const l of lines){ try{ const o=JSON.parse(l); if(o.kind==="task_reconcile"&&o.handoffId) n++; }catch{} }
    process.stdout.write(String(n));
  ' "$1"
}

SUP_PID=""
cleanup() {
  [ -n "$SUP_PID" ] && kill -9 "$SUP_PID" 2>/dev/null || true
  kill_all_wf_units 2>/dev/null || true
  rm -rf "$SHADOW_ROOT"
}
trap cleanup EXIT INT TERM

kill_all_wf_units 2>/dev/null || true
rm -rf "$SHADOW_ROOT"
mkdir -p "$SHADOW_HOME" "$SHADOW_STATE" "$SHADOW_LOGS" "$SHADOW_RUN" "$SHADOW_TRANSCRIPTS"
PROJECT_PATH="$SHADOW_ROOT/proj"; mkdir -p "$PROJECT_PATH"

echo "[reboot-orphan] transient unit does not survive reboot ⇒ visible orphan, NOT resumed"

# 1) seed temp DB (owner + owned project) + a session row (conv → jsonl).
SEED="$(env $(shadow_env_common) DB_INDEX="$DB_INDEX" "$NODE_BIN" "$REPO/spikes/b103-t821/harness/seed-db.mjs" "$PROJECT_PATH")" \
  || { bad "seed-db failed: $SEED"; exit 1; }
OWNER_ID="$(printf '%s' "$SEED" | sed -n 's/.*"ownerId":\([0-9]*\).*/\1/p')"
[ -n "$OWNER_ID" ] || { bad "no ownerId from seed"; exit 1; }
CONV="creboot$(date +%s)"; JSONL="$SHADOW_TRANSCRIPTS/$CONV.jsonl"
env $(shadow_env_common) DB_INDEX="$DB_INDEX" "$NODE_BIN" "$REPO/spikes/b103-t821/harness/seed-session.mjs" "$CONV" "$PROJECT_PATH" "$JSONL" >/dev/null \
  || { bad "seed-session failed"; exit 1; }
log "seeded ownerId=$OWNER_ID conv=$CONV"

# 2) seed the task as if LAUNCHED and mid-run: task.json + a partial result, NO DONE.
TID="reborphan-$$"; TD="$SHADOW_STATE/tasks/$TID"; mkdir -p "$TD"
printf 'half-streamed output' > "$TD/result.json.partial"
"$NODE_BIN" -e '
  const fs=require("fs");const [td,tid,uid,pp,conv]=process.argv.slice(1);
  fs.writeFileSync(td+"/task.json",JSON.stringify({schema_version:"2",taskId:tid,userId:+uid,projectPath:pp,conversationId:conv,originMessageId:"m1",spec:{scriptOrPrompt:"x",model:null,effort:null,handoffPolicy:"card-only",leafOnly:true},requestedAt:new Date(0).toISOString()}));
' "$TD" "$TID" "$OWNER_ID" "$PROJECT_PATH" "$CONV"

# 3) create the REAL live unit for it (the task "running" before the reboot).
UNIT="wf-$TID.service"
systemd-run --user --quiet --unit="$UNIT" --description="nassaj workflow wf-owner=$OWNER_ID" -- sleep 300 \
  || { bad "could not create the running unit"; exit 1; }
sleep 0.4
[ "$(systemctl --user is-active "$UNIT" 2>/dev/null)" = "active" ] && ok "task 'running' (unit $UNIT active)" || bad "unit not active"

# 4) SIMULATE REBOOT: transient units do NOT survive — tear it down. task.json stays,
#    no DONE, no unit.
systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
sleep 0.4
gone="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
[ "$gone" != "active" ] && ok "reboot simulated: unit gone (is-active=$gone), task.json + partial remain, no DONE" || bad "unit still active after teardown"

# 5) boot a FRESH supervisor (short grace) — reconcile-on-boot must surface the orphan.
nohup env $(shadow_env_common) WORKFLOW_SUPERVISOR_RECONCILE_GRACE_MS=300 \
  "$NODE_BIN" "$SUPERVISOR_ENTRY" > "$SHADOW_LOGS/reboot-sup.log" 2>&1 < /dev/null &
SUP_PID=$!
log "supervisor booting (pid=$SUP_PID)"

# 6) wait for the reboot-orphan audit + the visible card.
for _ in $(seq 1 100); do grep -q '"event":"reboot-orphan"' "$TD/audit.log" 2>/dev/null && break; sleep 0.1; done
for _ in $(seq 1 100); do [ "$(count_cards "$JSONL")" -ge 1 ] && break; sleep 0.1; done

# (a) audited as reboot-orphan, resumed:false.
if grep -q '"event":"reboot-orphan"' "$TD/audit.log" 2>/dev/null && grep -q '"resumed":false' "$TD/audit.log" 2>/dev/null; then
  ok "supervisor audited it as reboot-orphan (resumed:false)"
else
  bad "no reboot-orphan audit line"; tail -n 5 "$SHADOW_LOGS/reboot-sup.log" 2>/dev/null || true
fi

# (b) VISIBLE: exactly one CRASHED "did not complete" card in the transcript.
CARDN="$(count_cards "$JSONL")"
OUTCOME="$("$NODE_BIN" -e '
  const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(s=>{try{return JSON.parse(s)}catch{return null}}).find(o=>o&&o.kind==="task_reconcile");
  console.log(l?(l.backgroundTaskOutcome||l.taskStatus||"?"):"NONE");' "$JSONL" 2>/dev/null || echo NONE)"
[ "$CARDN" = "1" ] && ok "orphan is VISIBLE: exactly one card in the transcript (outcome=$OUTCOME)" || bad "card count=$CARDN (expected 1)"
[ "$OUTCOME" = "CRASHED" ] && ok "card marks it did-not-complete (CRASHED)" || bad "unexpected card outcome=$OUTCOME"

# (c) NOT resumed: the unit was NOT recreated (no relaunch).
sleep 0.6
recreated="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
[ "$recreated" != "active" ] && ok "NOT auto-resumed: unit $UNIT was not recreated (is-active=$recreated)" || bad "unit was relaunched — auto-resume MUST NOT happen"

echo "[reboot-orphan] pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
