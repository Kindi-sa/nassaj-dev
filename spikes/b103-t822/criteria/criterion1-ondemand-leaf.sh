#!/usr/bin/env bash
#
# Criterion 1 (§و م4-1) — an ON-DEMAND task injects ONE leaf-only turn ONLY after
# its trigger; the turn writes NO new intent and spawns NO background child.
# Uses the REAL supervisor Tier-B pass (deliverTierBOnce + DB-backed C2) + a real
# `claude -p --resume`.
CRIT_NAME=criterion1
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion1] on-demand: no trigger ⇒ no inject; trigger ⇒ one leaf-only turn (no intent/bg)"

TID="tod-$(date +%s)"
seed_task "$TID" "$SID" "on-demand" "أنجزتُ ترحيل قاعدة البيانات: 3 جداول، صفر أخطاء."
# also a card-only task that must NOT be touched by the Tier-B pass.
CARD="tcard-$(date +%s)"; seed_task "$CARD" "$SID" "card-only" "بطاقة فقط"

INTENTS0="$(intent_files_count)"; WF0="$(wf_units_count)"

# (a) No trigger ⇒ the on-demand task awaits; the Tier-B pass injects nothing.
R1="$(run_driver $TSX "$DRIVER" tierb-pass 2>/dev/null)"
INJ1="$("$NODE_BIN" -e 'try{console.log(JSON.parse(process.argv[1]).injected)}catch{console.log("x")}' "$R1")"
[ "$INJ1" = "0" ] && ok "no trigger ⇒ zero injected (awaits the hand-off)" || bad "expected 0 injected without trigger, got: $R1"
[ "$(ledger_entries "$SID")" = "0" ] && ok "no delivery recorded yet" || bad "ledger already has entries"

# (b) Trigger the hand-off ⇒ ONE leaf-only turn.
touch "$SHADOW_STATE/tasks/$TID/handoff-requested"
R2="$(run_driver $TSX "$DRIVER" tierb-pass 2>"$SHADOW_LOGS/c1.audit")"
INJ2="$("$NODE_BIN" -e 'try{console.log(JSON.parse(process.argv[1]).injected)}catch{console.log("x")}' "$R2")"
[ "$INJ2" = "1" ] && ok "trigger ⇒ exactly one task injected ($R2)" || bad "expected 1 injected after trigger, got: $R2"

REF="$(ref_for "$TID")"
[ "$(count_valid_needle "$TRANSCRIPT" "$REF")" -ge 1 ] && ok "the injected turn carries the exactly-once ref anchor" || bad "ref not found in the resumed transcript"
[ "$(ledger_entries "$SID")" = "1" ] && ok "ledger records the single delivery" || bad "ledger != 1"

# leaf-only proofs.
[ "$(intent_files_count)" = "$INTENTS0" ] && ok "leaf-only: ZERO new intent files written by the turn" || bad "the injected turn wrote a new intent (leaf-only VIOLATION)"
[ "$(wf_units_count)" = "$WF0" ] && ok "leaf-only: ZERO new wf-*.service spawned" || bad "the injected turn spawned a background unit"
grep -q '"newIntentFiles":0' "$SHADOW_STATE/tasks/$TID/audit.log" 2>/dev/null && ok "audit confirms newIntentFiles=0" || note "audit newIntentFiles line not found (see audit.log)"

# the card-only task was NOT injected (routing).
[ "$(count_valid_needle "$TRANSCRIPT" "$(ref_for "$CARD")")" = "0" ] && ok "card-only task NOT injected (owned by the card pass)" || bad "card-only task was injected"

read -r LINES BAD <<<"$(jsonl_health "$TRANSCRIPT")"
[ "$BAD" = "0" ] && ok "transcript fully parseable after injection ($LINES lines, 0 torn)" || bad "$BAD torn lines"

finish
