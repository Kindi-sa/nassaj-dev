#!/usr/bin/env bash
#
# Criterion 6 (supervisor resilience, §ب-2 / §و/المرحلة 1 بند 6): the permanent supervisor,
# killed with kill -9 mid REAL run and restarted, re-binds (reconcile-on-boot scans wf-*.service
# + on-disk tasks/) and delivers EXACTLY ONCE — zero double, zero lost — across >=10 attempts.
#
# Each attempt runs a REAL `claude -p --model haiku` background task as its own transient
# systemd unit (which OUTLIVES the supervisor). Two kill regimes:
#   random : kill -9 at a RANDOM offset into the supervisor's run (breadth; mostly exercises
#            reconcile-on-boot re-binding of a still-running or just-completed task).
#   window : widen the inject→ledger gap (HANDOFF_WIDEN_MS) + a marker so we kill -9 PRECISELY
#            inside it (the dangerous double/lost window — hole 2-ب on the live path).
# Exactly-once = (final valid handoff lines == 1) AND (real inject events across ALL supervisor
# incarnations == 1) AND (ledger present).
#
# Chunkable: FROM/TO select the attempt range; REC persists (truncated only when FROM=1).
# Env: N_RANDOM (10) N_WINDOW (5). AGG=1 (default) re-aggregates REC → criterion6.json.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_consumer_common.sh"

N_RANDOM="${N_RANDOM:-10}"; N_WINDOW="${N_WINDOW:-5}"; TOTAL=$((N_RANDOM + N_WINDOW))
C6_ROOT="${C6_ROOT:-$STATE_ROOT/c6}"; mkdir -p "$C6_ROOT"
REC="$C6_ROOT/records.jsonl"
FROM="${FROM:-1}"; TO="${TO:-$TOTAL}"; AGG="${AGG:-1}"
PROMPT_C6="${PROMPT_C6:-Reply with the single word: ok}"
[ "$FROM" = "1" ] && : > "$REC"

emit_record () { # all fields via env (no argv indexing)
  REC_FILE="$REC" node -e '
    const fs=require("fs");const e=process.env;
    const r={ i:+e.RI, mode:e.RMODE, taskId:e.RTID, unit:e.RUNIT, killWindow:e.RKW, offset:e.ROFF,
      ledgerAtKill:e.RLAK, validAtKill:+e.RVAK, restartRc:+e.RRC, classification:e.RCLASS,
      injectEvents:+e.RIE, finalValid:+e.RFV, finalTorn:+e.RFT, ledgerEntries:+e.RLE,
      exactlyOnce:e.REO==="true", doubles:e.RDBL==="true", lost:e.RLOST==="true" };
    fs.appendFileSync(e.REC_FILE,JSON.stringify(r)+"\n");'
}

class_of () { # actionsFile taskId
  ACT="$1" TID="$2" node -e 'const fs=require("fs");const p=process.env.ACT;let c="?";if(fs.existsSync(p))for(const l of fs.readFileSync(p,"utf8").split("\n")){if(!l)continue;try{const o=JSON.parse(l);if(o.taskId===process.env.TID&&o.classification)c=o.classification}catch{}}console.log(c)'
}

run_attempt () { # i mode
  local i="$1" mode="$2"
  local tid; tid="t819-c6-$(date +%s)-$i-$RANDOM"
  local A="$C6_ROOT/att-$i"; rm -rf "$A"; mkdir -p "$A/tasks/$tid" "$A/handoffs"
  local conv="$A/conv.jsonl"; seed_conv "$conv" "$CONV_A"
  local sid; sid=$(sid_of "$conv"); local hid; hid=$(hid_of "$tid")
  local unit; unit=$(launch_task "$A/tasks/$tid" "$tid" "$PROMPT_C6")
  seed_task_json "$A/tasks/$tid" "$tid" "$sid" "$conv" "$unit"
  local LOCK="$A/supervisor.lock" ACT="$A/actions.jsonl" LOG="$A/sup.log"
  local spid killWindow offdesc

  if [ "$mode" = "window" ]; then
    HANDOFF_WIDEN_MS=1500 SUPERVISOR_MARK_INJECT=1 \
      bash "$SUP_RUN" "$LOCK" -- --state-root "$A" --mode drain-exit --grace-ms 1200 --poll-ms 150 \
      --log "$LOG" --actions "$ACT" >/dev/null 2>&1 &
    spid=$!; killWindow="timeout-no-mark"; offdesc="marker"
    local j
    for ((j=0; j<600; j++)); do          # up to ~60s: wait for task done + entry into the gap
      [ -f "$A/tasks/$tid/INJECT-PENDING" ] && { killWindow="in-inject-ledger-gap"; break; }
      kill -0 "$spid" 2>/dev/null || { killWindow="delivered-before-mark"; break; }
      sleep 0.1
    done
    kill -9 "$spid" 2>/dev/null || true
  else
    HANDOFF_WIDEN_MS=0 \
      bash "$SUP_RUN" "$LOCK" -- --state-root "$A" --mode drain-exit --grace-ms 1200 --poll-ms 150 \
      --log "$LOG" --actions "$ACT" >/dev/null 2>&1 &
    spid=$!
    local off_ms=$(( 200 + RANDOM % 6000 ))   # random offset in [0.2s, 6.2s]
    offdesc="${off_ms}ms"
    sleep "$(awk "BEGIN{printf \"%.3f\", $off_ms/1000}")"
    killWindow="pre-done"; [ -f "$A/tasks/$tid/DONE" ] && killWindow="post-done-pre-inject"
    local xv xr xt; read -r xv xr xt <<<"$(scan_counts "$conv" "$hid")"
    [ "${xv:-0}" -ge 1 ] && killWindow="post-inject-pre-ledger"
    [ -f "$A/handoffs/$sid.done" ] && killWindow="post-ledger"
    kill -9 "$spid" 2>/dev/null || true
  fi
  wait "$spid" 2>/dev/null || true

  # state at kill time (before restart)
  sleep 0.2
  local av ar at; read -r av ar at <<<"$(scan_counts "$conv" "$hid")"
  local ledger_at_kill; ledger_at_kill=$([ -f "$A/handoffs/$sid.done" ] && echo yes || echo no)

  # RESTART: reconcile-on-boot + finish delivery + exit. Brief lock wait tolerates a clearing lock.
  SUPERVISOR_LOCK_WAIT=8 HANDOFF_WIDEN_MS=0 \
    timeout 120 bash "$SUP_RUN" "$LOCK" -- --state-root "$A" --mode drain-exit --grace-ms 1200 \
    --poll-ms 150 --log "$LOG" --actions "$ACT" >/dev/null 2>&1
  local restart_rc=$?

  local fv fr ft; read -r fv fr ft <<<"$(scan_counts "$conv" "$hid")"
  local inj; inj=$(count_inject_events "$ACT" "$tid")
  local ledp; ledp=$([ -f "$A/handoffs/$sid.done" ] && echo yes || echo no)
  local lent; lent=$(ledger_entries_for "$A" "$sid" "$tid")
  local cls; cls=$(class_of "$ACT" "$tid")
  # Ground truth of "how many times delivered" is the number of VALID handoff lines in the
  # jsonl (finalValid) + ledger entries — NOT logged inject events, which undercount when the
  # injecting supervisor is killed inside the gap (injected the line, died before logging).
  local eo dbl lost
  eo=$([ "$fv" = "1" ] && [ "$ledp" = "yes" ] && [ "$lent" = "1" ] && echo true || echo false)
  dbl=$([ "${fv:-0}" -gt 1 ] || [ "${lent:-0}" -gt 1 ] || [ "${inj:-0}" -gt 1 ] && echo true || echo false)
  lost=$([ "${fv:-0}" -lt 1 ] && echo true || echo false)

  RI="$i" RMODE="$mode" RTID="$tid" RUNIT="$unit" RKW="$killWindow" ROFF="$offdesc" \
  RLAK="$ledger_at_kill" RVAK="$av" RRC="$restart_rc" RCLASS="$cls" RIE="$inj" RFV="$fv" \
  RFT="$ft" RLE="$lent" REO="$eo" RDBL="$dbl" RLOST="$lost" emit_record
  printf '  att#%02d %-6s kill@%-20s ledgerAtKill=%-3s validAtKill=%s → class=%s inject=%s final_valid=%s exactlyOnce=%s\n' \
    "$i" "$mode" "$killWindow" "$ledger_at_kill" "$av" "$cls" "$inj" "$fv" "$eo"
  cleanup_unit "$unit"
  systemctl --user reset-failed "$unit" 2>/dev/null || true
}

if [ "${AGG_ONLY:-0}" != "1" ]; then
  echo "[criterion6] attempts $FROM..$TO of $TOTAL (random=$N_RANDOM window=$N_WINDOW)  C6_ROOT=$C6_ROOT"
  for ((i=FROM; i<=TO; i++)); do
    if [ "$i" -le "$N_RANDOM" ]; then run_attempt "$i" random; else run_attempt "$i" window; fi
  done
fi

if [ "$AGG" = "1" ] || [ "${AGG_ONLY:-0}" = "1" ]; then
  node - "$REC" "$STATE_ROOT/criterion6.json" "$TOTAL" "$N_RANDOM" "$N_WINDOW" <<'NODE'
const fs = require('fs');
const [rec, out, total, nRand, nWin] = process.argv.slice(2);
const rows = fs.existsSync(rec) ? fs.readFileSync(rec,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)) : [];
const deliveredExactlyOnce = rows.filter(r=>r.exactlyOnce).length;
const doubles = rows.filter(r=>r.doubles).length;
const lost = rows.filter(r=>r.lost).length;
const gapKills = rows.filter(r=>r.killWindow==='in-inject-ledger-gap').length;
const dist = {};
for (const r of rows) dist[r.killWindow] = (dist[r.killWindow]||0)+1;
const restarts = rows.length; // one kill+restart per attempt
const summary = { criterion: 6, attempts: rows.length, plannedTotal:+total, nRandom:+nRand, nWindow:+nWin,
  restarts, deliveredExactlyOnce, doubles, lost, injectLedgerGapKills: gapKills,
  killWindowDistribution: dist, records: rows };
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`[criterion6] attempts=${rows.length} exactlyOnce=${deliveredExactlyOnce}/${rows.length} doubles=${doubles} lost=${lost} gapKills=${gapKills} dist=${JSON.stringify(dist)}`);
NODE
fi
