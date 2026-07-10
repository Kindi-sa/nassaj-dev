#!/usr/bin/env bash
#
# Criterion 5 (§و م4-5, §د) — over the daily token budget OR under the kill switch,
# a Tier-B delivery DEGRADES to a card-only notification (NO LLM turn, ~0 tokens)
# with an audit line; the result is still surfaced. NO real claude is needed (the
# whole point is that the expensive turn does not run). Uses a fresh EMPTY conv.
CRIT_NAME=criterion5
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion5] budget exceeded / kill switch ⇒ card-only fallback (no turn)"

# Fresh conversation with an EMPTY seeded transcript (no real claude — card append).
CONV="c5conv$(date +%s)"
JSONL="$SHADOW_STATE/c5-$CONV.jsonl"; : > "$JSONL"
env $(shadow_env_common) $TSX "$DB_DRIVER" seed-session "$CONV" "$PROJECT_PATH" "$JSONL" >/dev/null 2>&1 || true

# --- (a) BUDGET: a tiny per-conversation cap trips the pre-charge estimate ---
TID="tbud-$(date +%s)"; seed_task "$TID" "$CONV" "auto-turn" "نتيجة يجب أن تُسلَّم كبطاقة"
R="$(env $(shadow_env_common) WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_CONV_MAX=100 \
  $TSX "$DRIVER" inject --conv "$CONV" --project "$PROJECT_PATH" --jsonl "$JSONL" --tasks "$TID" 2>/dev/null)"
echo "$R" | grep -q '"event":"card-fallback"' && ok "over budget ⇒ card-fallback ($R)" || bad "expected card-fallback, got: $R"
# a task_reconcile CARD was written (not a resume turn); no ref anchor.
CARDS="$(count_valid_needle "$JSONL" '"kind":"task_reconcile"')"
[ "$CARDS" -ge 1 ] && ok "the result is surfaced as a non-LLM card (~0 tokens)" || bad "no card written"
[ "$(count_valid_needle "$JSONL" "$(ref_for "$TID")")" = "0" ] && ok "NO injected turn ref (the expensive turn did not run)" || bad "an injection turn ran despite the budget"
[ "$(ledger_entries "$CONV")" = "1" ] && ok "delivered exactly once (via the card ledger)" || bad "ledger != 1"
grep -q 'tierb-card-fallback' "$SHADOW_STATE/tasks/$TID/audit.log" 2>/dev/null && ok "audit records the budget fallback + reason" || bad "no fallback audit line"

# --- (b) KILL SWITCH: the kill file forces card-only regardless of budget ---
touch "$SHADOW_STATE/HANDOFF_KILL"
TID2="tkill-$(date +%s)"; seed_task "$TID2" "$CONV" "auto-turn" "نتيجة أخرى"
R2="$(env $(shadow_env_common) $TSX "$DRIVER" inject --conv "$CONV" --project "$PROJECT_PATH" --jsonl "$JSONL" --tasks "$TID2" 2>/dev/null)"
echo "$R2" | grep -q '"event":"card-fallback"' && ok "kill switch (file) ⇒ card-fallback ($R2)" || bad "kill switch did not fall back: $R2"
grep -q 'kill-switch' "$SHADOW_STATE/tasks/$TID2/audit.log" 2>/dev/null && ok "audit records the kill-switch reason" || bad "no kill-switch audit line"
rm -f "$SHADOW_STATE/HANDOFF_KILL"

read -r LINES BAD <<<"$(jsonl_health "$JSONL")"
[ "$BAD" = "0" ] && ok "fallback jsonl fully parseable ($LINES lines, 0 torn)" || bad "$BAD torn lines"

finish
