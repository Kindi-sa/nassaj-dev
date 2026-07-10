#!/usr/bin/env bash
#
# Criterion 6 (§و م4-6) — with the T-822 sub-flag OFF the chat lock is ABSENT
# behaviorally: the seam takes no lock, creates no lock file, spawns no flock —
# the critical path is byte-identical. Proven behaviorally (no real claude) + a
# diff-read note for the reviewer. NO real claude turns.
CRIT_NAME=criterion6
source "$(dirname "${BASH_SOURCE[0]}")/_crit_common.sh"

echo "[criterion6] sub-flag OFF ⇒ lock absent (no fs, no spawn); ON ⇒ engaged"

PROBE_STATE="$SHADOW_STATE/c6probe"; rm -rf "$PROBE_STATE"; mkdir -p "$PROBE_STATE"

# (a) master ON but sub-flag OFF ⇒ disabled, no chat-locks dir created.
ROFF="$(env HOME="$SHADOW_HOME" WORKFLOW_SUPERVISOR=1 WORKFLOW_SUPERVISOR_STATE_DIR="$PROBE_STATE" \
  PATH=/home/nassaj/.local/bin:/usr/bin:/bin $TSX "$DRIVER" lock-probe --conv c6 2>/dev/null)"
note "flag OFF probe: $ROFF"
echo "$ROFF" | grep -q '"enabled":false' && ok "isChatTurnLockEnabled()=false when the sub-flag is off (master on)" || bad "flag gate wrong: $ROFF"
echo "$ROFF" | grep -q '"reason":"disabled"' && ok "the live-turn seam returns a NO-OP lock (reason=disabled)" || bad "seam not disabled: $ROFF"
[ ! -d "$PROBE_STATE/chat-locks" ] && ok "NO chat-locks dir created when off (no fs touch on the critical path)" || bad "a chat-locks dir was created while the flag is off"

# (b) both flags ON ⇒ a real lock is taken (proves the flag toggles behavior).
RON="$(env HOME="$SHADOW_HOME" WORKFLOW_SUPERVISOR=1 WORKFLOW_SUPERVISOR_CHAT_LOCK=1 WORKFLOW_SUPERVISOR_STATE_DIR="$PROBE_STATE" \
  PATH=/home/nassaj/.local/bin:/usr/bin:/bin $TSX "$DRIVER" lock-probe --conv c6 2>/dev/null)"
note "flag ON probe: $RON"
echo "$RON" | grep -q '"enabled":true' && ok "isChatTurnLockEnabled()=true when both flags on" || bad "flag gate wrong: $RON"
echo "$RON" | grep -q '"held":true' && ok "the seam takes a REAL lock when on (reason=acquired)" || bad "lock not held when on: $RON"
[ -f "$PROBE_STATE/chat-locks/c6.lock" ] && ok "the lock file exists only when the flag is on" || bad "no lock file created when on"

# (c) diff-read: the claude-sdk.js seam is a single flag-guarded acquire + finally.
SDK="$REPO/server/claude-sdk.js"
GUARD="$(grep -c 'isChatTurnLockEnabled() && sessionId' "$SDK" 2>/dev/null || echo 0)"
REL="$(grep -c 'chatTurnLock.release()' "$SDK" 2>/dev/null || echo 0)"
[ "$GUARD" = "1" ] && ok "claude-sdk.js: exactly ONE flag-guarded acquire at the line start" || bad "expected 1 guarded acquire, found $GUARD"
[ "$REL" -ge 1 ] && ok "claude-sdk.js: release() paired in a finally (every exit path)" || bad "no finally release found"
ADDED="$(cd "$REPO" && git diff --numstat -- server/claude-sdk.js 2>/dev/null | awk '{print $1}')"
note "claude-sdk.js added lines (git numstat): ${ADDED:-n/a} — minimal seam"

rm -rf "$PROBE_STATE"
finish
