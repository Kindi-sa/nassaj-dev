#!/usr/bin/env bash
#
# Criterion 8 (FIELD soak, §و/المرحلة 1 بند 8): a full launch→complete→deliver cycle, LIVE, for
# >=10 real tasks spread across the three producer classes (SUCCEEDED / PARTIAL / CRASHED), through
# the SAME proven pipeline — but the delivery target is now a REAL claude transcript on disk (not a
# fixture), and every claude -p is real (haiku, tiny prompt, /tmp cwd).
#
# Per task:  create task → wf-<taskId>.service runs real claude -p → the PERMANENT supervisor
# (lib/supervisor.mjs, drain-exit) detects + classifies (§أ-3) → finalizeDelivery delivers:
#   SUCCEEDED → injects a background_task_handoff line into the REAL <conversationId>.jsonl
#               (auto-turn delivery record), attributed task-notification (NOT the user).
#   PARTIAL/CRASHED → card-only ledger entry, NO jsonl injection (no LLM burned on a failure).
#
# Verified on the REAL transcript (not a fixture): the injected line carries
# subtype=background_task_handoff + untrusted wrapper (attribution seam, §ح-2/§ج-1), is NOT a plain
# user turn, exactly-once per task (a 2nd drain pass must be a no-op), and the three classes yield
# semantically correct deliveries.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_soak_common.sh"

NSUCC="${NSUCC:-4}"; NPART="${NPART:-3}"; NCRASH="${NCRASH:-3}"; NCONV="${NCONV:-3}"
TOTAL=$((NSUCC + NPART + NCRASH))
REC="$STATE_ROOT/criterion8.records.jsonl"; : > "$REC"
CONVMETA="$STATE_ROOT/criterion8.convs.jsonl"; : > "$CONVMETA"
ACT="$STATE_ROOT/actions.jsonl"; : > "$ACT"
LOG="$STATE_ROOT/sup.log"; : > "$LOG"
LOCK="$STATE_ROOT/supervisor.lock"
GRACE_MS="${GRACE_MS:-1500}"

# fresh task/handoff state (transcripts persist in CLAUDE_CONFIG_DIR; that is the field artifact).
rm -rf "$STATE_ROOT/tasks" "$STATE_ROOT/handoffs"; mkdir -p "$STATE_ROOT/tasks" "$STATE_ROOT/handoffs"

echo "[criterion8] SOAK_BASE=$SOAK_BASE STATE_ROOT=$STATE_ROOT total=$TOTAL (succ=$NSUCC part=$NPART crash=$NCRASH) convs=$NCONV"
echo "[criterion8] CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"

# ---- 1) create NCONV REAL target conversations (the "orchestrator chats") ------------------------
declare -a CSID CTF CBASE
for ((k=1; k<=NCONV; k++)); do
  echo "  seeding target conversation $k/$NCONV …"
  IFS='|' read -r sid tf < <(seed_real_conversation "$SOAK_BASE" \
      "You are a coordinator. Acknowledge task $k briefly; reply with exactly: ready")
  [ -n "$sid" ] && [ -n "$tf" ] || { echo "  [FATAL] could not seed conversation $k"; exit 3; }
  CSID[$k]="$sid"; CTF[$k]="$tf"; CBASE[$k]="$(count_lines "$tf")"
  printf '{"k":%d,"sessionId":"%s","transcript":"%s","baseLines":%d}\n' "$k" "$sid" "$tf" "${CBASE[$k]}" >> "$CONVMETA"
  echo "    conv$k sid=${sid:0:8} lines=${CBASE[$k]} tf=$tf"
done

# ---- 2) launch all tasks, round-robin across the conversations -----------------------------------
declare -a TID CLASS UNIT CONVK HID
idx=0
launch_one () { # class convK
  local cls="$1" ck="$2" tid unit
  tid="t819-soak-$(date +%s)-$((++idx))-$RANDOM"
  local out="$STATE_ROOT/tasks/$tid"; mkdir -p "$out"
  case "$cls" in
    succ)  PROMPT="Reply with exactly: done" launch "$tid" >/dev/null; unit="wf-${tid}.service";;
    part)  PROMPT="Write five short lines about the sea, then reply ok" \
             launch "$tid" --claude-kill-after-sec "0.$((3 + RANDOM % 3))" >/dev/null; unit="wf-${tid}.service";;
    crash) PROMPT="Write five short lines about the sea, then reply ok" launch "$tid" >/dev/null; unit="wf-${tid}.service";;
  esac
  seed_task_json "$out" "$tid" "${CSID[$ck]}" "${CTF[$ck]}" "$unit"
  TID[$idx]="$tid"; CLASS[$idx]="$cls"; UNIT[$idx]="$unit"; CONVK[$idx]="$ck"; HID[$idx]="$(hid_of "$tid")"
  echo "  launched #$idx $cls tid=${tid##*-} conv$ck unit=$unit"
}

n=0
for ((j=0; j<NSUCC;  j++)); do n=$((n+1)); launch_one succ  $(( (n % NCONV) + 1 )); done
for ((j=0; j<NPART;  j++)); do n=$((n+1)); launch_one part  $(( (n % NCONV) + 1 )); done
for ((j=0; j<NCRASH; j++)); do n=$((n+1)); launch_one crash $(( (n % NCONV) + 1 )); done

# crash the CRASHED units mid-run (kill -9 whole unit before DONE) — real interruption.
for ((i=1; i<=idx; i++)); do
  if [ "${CLASS[$i]}" = "crash" ]; then
    ( sleep "0.$((4 + RANDOM % 4))"; systemctl --user kill --kill-whom=all -s KILL "${UNIT[$i]}" 2>/dev/null ) &
  fi
done
wait 2>/dev/null || true

# ---- 3) wait for all units to settle -------------------------------------------------------------
echo "[criterion8] waiting for ${idx} units to settle …"
for ((i=1; i<=idx; i++)); do wait_settle "${UNIT[$i]}" "$STATE_ROOT/tasks/${TID[$i]}" 120 || echo "  [warn] ${TID[$i]} did not settle"; done

# ---- 4) run the PERMANENT supervisor, drain-exit (detect → classify → deliver) --------------------
echo "[criterion8] draining via supervisor (pass 1) …"
timeout 240 bash "$SUP_RUN" "$LOCK" -- --state-root "$STATE_ROOT" --mode drain-exit \
  --grace-ms "$GRACE_MS" --poll-ms 200 --log "$LOG" --actions "$ACT" >/dev/null 2>&1
echo "  pass1 rc=$?"

# snapshot exactly-once state after pass 1
declare -a V1 L1
for ((i=1; i<=idx; i++)); do
  read -r v r t < <(scan_counts "${CTF[${CONVK[$i]}]}" "${HID[$i]}"); V1[$i]="$v"
  L1[$i]="$(ledger_entries_for "$STATE_ROOT" "${CSID[${CONVK[$i]}]}" "${TID[$i]}")"
done

# ---- 5) SECOND drain pass — must be a no-op (exactly-once on the REAL transcript) -----------------
ACT2="$STATE_ROOT/actions.pass2.jsonl"; : > "$ACT2"
echo "[criterion8] draining via supervisor (pass 2, idempotency) …"
timeout 120 bash "$SUP_RUN" "$LOCK" -- --state-root "$STATE_ROOT" --mode drain-exit \
  --grace-ms "$GRACE_MS" --poll-ms 200 --log "$LOG" --actions "$ACT2" >/dev/null 2>&1
echo "  pass2 rc=$?"

action_for () { # actionsFile taskId  → "event|classification"
  ACT="$1" TID="$2" node -e 'const fs=require("fs");const p=process.env.ACT;let e="none",c="?";
    if(fs.existsSync(p))for(const l of fs.readFileSync(p,"utf8").split("\n")){if(!l)continue;
      try{const o=JSON.parse(l);if(o.taskId===process.env.TID){e=o.event||e;if(o.classification)c=o.classification;}}catch{}}
    process.stdout.write(e+"|"+c)'
}

# ---- 6) verify per task + emit records -----------------------------------------------------------
echo "[criterion8] verifying …"
for ((i=1; i<=idx; i++)); do
  cls="${CLASS[$i]}"; tid="${TID[$i]}"; ck="${CONVK[$i]}"; tf="${CTF[$ck]}"; hid="${HID[$i]}"; sid="${CSID[$ck]}"
  IFS='|' read -r ev1 class1 < <(action_for "$ACT" "$tid")
  IFS='|' read -r ev2 _c2   < <(action_for "$ACT2" "$tid")
  read -r fv fr ft < <(scan_counts "$tf" "$hid")
  lent="$(ledger_entries_for "$STATE_ROOT" "$sid" "$tid")"
  lout="$(ledger_outcome_for "$STATE_ROOT" "$sid" "$tid")"
  chk="$(check_injected_line "$tf" "$hid")"
  expected_class=$([ "$cls" = succ ] && echo SUCCEEDED || { [ "$cls" = part ] && echo PARTIAL || echo CRASHED; })
  if [ "$cls" = succ ]; then expected_event=inject+ledger; expect_valid=1; else expected_event=card-only; expect_valid=0; fi

  # verdicts
  class_ok=$([ "$class1" = "$expected_class" ] && echo true || echo false)
  event_ok=$([ "$ev1" = "$expected_event" ] && echo true || echo false)
  valid_ok=$([ "${fv:-0}" = "$expect_valid" ] && echo true || echo false)
  ledger_ok=$([ "${lent:-0}" = "1" ] && [ "$lout" = "$expected_class" ] && echo true || echo false)
  # idempotency: pass 2 must NOT re-deliver. The supervisor's cheap ledger pre-check returns
  # 'already' and logs NOTHING (event 'none') — the expected no-op. Assert no re-delivery event
  # AND counts unchanged from the pass-1 snapshot (V1/L1).
  redeliv=false; { [ "$ev2" = "inject+ledger" ] || [ "$ev2" = "card-only" ]; } && redeliv=true
  idem_ok=$([ "$redeliv" = false ] && [ "${fv:-0}" = "${V1[$i]:-x}" ] && [ "${lent:-0}" = "${L1[$i]:-x}" ] \
    && echo true || echo false)
  attrib_ok=true
  if [ "$cls" = succ ]; then
    attrib_ok=$(ATTR="$chk" node -pe 'const o=JSON.parse(process.env.ATTR);(o.found&&o.attributedToTaskNotification&&!o.isPlainUser&&o.untrustedWrapped&&o.count===1)?"true":"false"')
  else
    # failure classes must NOT inject a handoff line at all
    attrib_ok=$(ATTR="$chk" node -pe 'const o=JSON.parse(process.env.ATTR);(!o.found&&o.count===0)?"true":"false"')
  fi
  exactly_once=$([ "$class_ok" = true ] && [ "$event_ok" = true ] && [ "$valid_ok" = true ] \
    && [ "$ledger_ok" = true ] && [ "$idem_ok" = true ] && [ "$attrib_ok" = true ] && echo true || echo false)

  RI="$i" RTID="$tid" RCLS="$cls" REC_EXP="$expected_class" RGOT="$class1" REV1="$ev1" REV2="$ev2" \
  RSID="$sid" RCK="$ck" RHID="$hid" RFV="${fv:-0}" RLENT="${lent:-0}" RLOUT="$lout" RCHK="$chk" \
  RCLSOK="$class_ok" REVOK="$event_ok" RVOK="$valid_ok" RLOK="$ledger_ok" RIDEM="$idem_ok" \
  RATTR="$attrib_ok" REO="$exactly_once" REC_FILE="$REC" node -e '
    const fs=require("fs");const e=process.env;
    const r={i:+e.RI,taskId:e.RTID,class:e.RCLS,expectedClass:e.REC_EXP,classification:e.RGOT,
      event:e.REV1,pass2Event:e.REV2,conversationId:e.RSID,convK:+e.RCK,handoffId:e.RHID,
      validHandoffLines:+e.RFV,ledgerEntries:+e.RLENT,ledgerOutcome:e.RLOUT,
      injectedLine:JSON.parse(e.RCHK),classOk:e.RCLSOK==="true",eventOk:e.REVOK==="true",
      validOk:e.RVOK==="true",ledgerOk:e.RLOK==="true",idempotentOk:e.RIDEM==="true",
      attributionOk:e.RATTR==="true",exactlyOnce:e.REO==="true"};
    fs.appendFileSync(e.REC_FILE,JSON.stringify(r)+"\n");'
  printf '  #%02d %-5s class=%-9s event=%-14s valid=%s ledger=%s(%s) attrib=%s idem(%s) → exactlyOnce=%s\n' \
    "$i" "$cls" "$class1" "$ev1" "${fv:-0}" "${lent:-0}" "$lout" "$attrib_ok" "$ev2" "$exactly_once"
  cleanup_unit "${UNIT[$i]}"
done

# ---- 7) aggregate → criterion8.json --------------------------------------------------------------
node - "$REC" "$CONVMETA" "$STATE_ROOT/criterion8.json" "$NSUCC" "$NPART" "$NCRASH" <<'NODE'
const fs=require('fs');
const [rec,convs,out,ns,np,nc]=process.argv.slice(2);
const rows=fs.existsSync(rec)?fs.readFileSync(rec,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
const cm=fs.existsSync(convs)?fs.readFileSync(convs,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
const by=c=>rows.filter(r=>r.class===c);
const okc=c=>by(c).filter(r=>r.exactlyOnce).length;
const summary={criterion:8,total:rows.length,exactlyOnce:rows.filter(r=>r.exactlyOnce).length,
  byClass:{succ:{total:by('succ').length,exactlyOnce:okc('succ')},
           part:{total:by('part').length,exactlyOnce:okc('part')},
           crash:{total:by('crash').length,exactlyOnce:okc('crash')}},
  attributionAllOk:rows.every(r=>r.attributionOk),
  idempotentAllOk:rows.every(r=>r.idempotentOk),
  classifierAllOk:rows.every(r=>r.classOk),
  conversations:cm, records:rows};
fs.writeFileSync(out,JSON.stringify(summary,null,2));
console.log(`[criterion8] exactlyOnce=${summary.exactlyOnce}/${summary.total} `+
  `succ=${summary.byClass.succ.exactlyOnce}/${summary.byClass.succ.total} `+
  `part=${summary.byClass.part.exactlyOnce}/${summary.byClass.part.total} `+
  `crash=${summary.byClass.crash.exactlyOnce}/${summary.byClass.crash.total} `+
  `attribution=${summary.attributionAllOk} idempotent=${summary.idempotentAllOk}`);
NODE
