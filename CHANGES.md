# nassaj-dev — Change Log

## 2026-05-27 — Fix: Race condition in writer swap causes SDK abort (v2)

**Problem:**
Even with the `if (!isActive)` guard, a race window existed: between
`removeSession()` and the next `addSession()` for the same sessionId, the session
briefly doesn't exist → `isActive = false` → writer swap happens → next query
starts with mismatched WS reference → SDK abort.

**Root Cause:**
`recentlyEndedSessions` was missing. After `removeSession()`, incoming
`check-session-status` messages could still trigger `reconnectSessionWriter`
in the ~2s window before the next query registered.

**Fix (`server/claude-sdk.js`):**
- Added `recentlyEndedSessions` Map and `RECENTLY_ENDED_GRACE_MS = 2000`
- `removeSession()` marks the sessionId as recently ended for 2 seconds
- `reconnectSessionWriter()` skips swap and logs `[RECONNECT] Skipped — in grace period`

---

## 2026-05-27 — Fix: Writer swap during active tool_use causes SDK abort

**Problem:**
When a Claude SDK query is active (tool_use in progress), `check-session-status`
messages from the frontend triggered `reconnectSessionWriter`, which swapped the
writer reference while the SDK was still streaming. This desynchronised the SDK
from the WebSocket connection, causing the SDK to abort with:
"The user doesn't want to proceed with this tool use."

**Root Cause:**
In `chat-websocket.service.ts`, the `check-session-status` handler called
`reconnectSessionWriter` whenever `isClaudeSDKSessionActive` returned `true` —
i.e., exactly when a query was in progress.

**Fix (Option A — guard in chat-websocket.service.ts):**
Inverted the condition: `reconnectSessionWriter` is now called only when
`isActive === false` (session exists in map but is idle). When `isActive === true`
(query running), the handler returns the status response without touching the writer.

**File Changed:**
`server/modules/websocket/services/chat-websocket.service.ts`
Lines ~304-309: condition changed from `if (isActive)` to `if (!isActive)`
