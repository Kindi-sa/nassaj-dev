#!/usr/bin/env bash
#
# Criterion 2 (§و م2 / §ز الشرط 1) — GATE2 fail-closed: userId empty / "abc" /
# a valid non-owner ⇒ ZERO launch (no unit, no task dir, intent consumed as
# denied) and NO touch of the owner credential/subscription.
CRIT_NAME=criterion2
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion2] GATE2 fail-closed — three denials, zero launch"
creds_before="$(sha256sum "$HOME/.claude/.credentials.json" 2>/dev/null | awk '{print $1}')"

# (a) ROUTE denies a valid NON-OWNER (403), writing NOTHING to disk.
CONV="conv2str$(date +%s)"
BODY="{\"projectPath\":\"$PROJECT_PATH\",\"scriptOrPrompt\":\"x\",\"conversationId\":\"$CONV\",\"originMessageId\":\"m\",\"model\":\"haiku\"}"
OUT="$(launch_post "$STRANGER_TOKEN" "$BODY")"; CODE="${OUT%%$'\t'*}"
[ "$CODE" = "403" ] && ok "route: non-owner → 403" || bad "route: non-owner → $CODE (expected 403)"
if grep -rqs "$CONV" "$SHADOW_STATE/intents" 2>/dev/null; then bad "non-owner wrote an intent (should be zero)"; else ok "route: non-owner wrote ZERO intent"; fi

# (b/c/d) PLANT malformed intents directly on disk and let the supervisor deny
# them. Each must be REMOVED (denied), never launched.
mkdir -p "$SHADOW_STATE/intents/planted"
declare -A PLANTED   # taskId -> label
plant() { # <taskId> <userId-json> <label>
  local tid="$1" uid="$2" label="$3"
  cat > "$SHADOW_STATE/intents/planted/$tid.json" <<EOF
{"schema_version":"2","taskId":"$tid","userId":$uid,"projectPath":"$PROJECT_PATH","conversationId":"c","originMessageId":"m","spec":{"scriptOrPrompt":"should never run","model":"haiku","effort":null,"handoffPolicy":"card-only","leafOnly":true},"requestedAt":"2026-07-10T00:00:00.000Z"}
EOF
  PLANTED[$tid]="$label"
}
TS="$(date +%s)"
plant "tabc$TS"  "\"abc\""       "userId=\"abc\""
plant "tempty$TS" "\"\""          "userId=\"\" (empty)"
plant "tnown$TS" "$STRANGER_ID"   "valid non-owner userId=$STRANGER_ID"
note "planted ${#PLANTED[@]} malformed/denied intents"

# Give the supervisor several poll cycles to process + deny them.
sleep 3

for tid in "${!PLANTED[@]}"; do
  label="${PLANTED[$tid]}"
  launched=""
  unit_exists "wf-$tid.service" && launched="unit"
  [ -d "$SHADOW_STATE/tasks/$tid" ] && launched="${launched:+$launched+}taskdir"
  if [ -z "$launched" ]; then ok "denied [$label]: zero launch (no unit, no task dir)"; else bad "denied [$label] LAUNCHED something: $launched"; fi
  if [ -f "$SHADOW_STATE/intents/planted/$tid.json" ]; then
    bad "denied [$label]: intent still on disk (not processed?)"
  else
    ok "denied [$label]: intent consumed (processed as denied)"
  fi
done

# No owner credential / subscription touched by any denial.
creds_after="$(sha256sum "$HOME/.claude/.credentials.json" 2>/dev/null | awk '{print $1}')"
[ "$creds_before" = "$creds_after" ] && ok "owner credential untouched by all denials" || bad "owner credential CHANGED during denials"

# No shadow claude child spawned for any denied task (structurally: no unit ⇒ no
# claude). Confirm no wf unit for the planted ids remains in ANY state.
leftover=""
for tid in "${!PLANTED[@]}"; do unit_exists "wf-$tid.service" && leftover="$leftover wf-$tid.service"; done
[ -z "$leftover" ] && ok "no transient unit exists for any denied task" || bad "unexpected units:$leftover"

# cleanup any planted residue.
rm -f "$SHADOW_STATE"/intents/planted/*.json 2>/dev/null || true
finish
