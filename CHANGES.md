# nassaj-dev — Change Log

## 2026-06-05 — Feature: Show all safe built-in Claude commands in slash menu (`71c2fb3`)

**الملخص (AR):** كانت قائمة `/` تعرض 6 أوامر مدمجة فقط؛ وُسِّعت لتشمل كل أوامر Claude Code الآمنة. الأوامر بلا واجهة مخصّصة تُمرَّر خاماً للـ CLI، واستُثنيت الأوامر الحسّاسة/التفاعلية.

**Problem:**
The `/` slash menu listed only 6 built-in commands (a hardcoded manual list).
The remaining Claude Code commands never appeared, even though they work fine
when typed manually (they are passed raw to the CLI). This was a discovery gap,
not a capability gap.

**Fix:**
- `server/routes/commands.js` — expanded `builtInCommands` with 13 commands:
  `/clear`, `/compact`, `/agents`, `/init`, `/review`, `/resume`, `/mcp`,
  `/permissions`, `/export`, `/doctor`, `/add-dir`, `/hooks`, `/vim`.
  Added a `metadata.hasHandler` field to distinguish commands with a UI handler
  from passthrough ones.
- Commands without a UI handler (`hasHandler: false`) are passed raw via
  `dispatchProviderCommand` instead of `/api/commands/execute`, through the new
  `isPassthroughBuiltInCommand` helper in
  `src/components/chat/hooks/useSlashCommands.ts`, plus an interception-condition
  change in `src/components/chat/hooks/useChatComposerState.ts`.
- Selecting a command from the menu inserts it into the input (like skills) so
  arguments can be completed.
- Sensitive/interactive commands are excluded: `login`, `logout`,
  `terminal-setup`, `bug`, `quit`, `exit`.

**Files Changed:**
- `server/routes/commands.js`
- `src/components/chat/hooks/useSlashCommands.ts`
- `src/components/chat/hooks/useChatComposerState.ts`

**Commit:** `71c2fb3`

---

## 2026-06-05 — Feature: Raise image attachment limit from 5 to 15 (`52257b4`)

**الملخص (AR):** لم يكن المستخدم يستطيع إرسال أكثر من 5 صور؛ كانت الصورة السادسة تُحذف بصمت. رُفع الحد إلى 15 صورة في الواجهة والخادم، مع رسالة خطأ واضحة بدل الحذف الصامت. حد 5MB لكل صورة باقٍ.

**Problem:**
Users could not attach more than 5 images. The 6th image was silently dropped
via `.slice(0, 5)`, with no feedback.

**Fix:**
- Introduced a `MAX_IMAGES = 15` constant in
  `src/components/chat/hooks/useChatComposerState.ts`, applied to both the slice
  (~line 487) and the dropzone `maxFiles` (~line 521).
- Raised the server-side multer limits in `server/index.js`:
  `files: 15` (~line 1167) and `upload.array('images', 15)` (~line 1172).
- Added a `You can attach at most 15 images` error via the existing `imageErrors`
  mechanism (shown on the last accepted image thumbnail) instead of the silent drop.

**Notes:**
- Each base64 image consumes vision tokens.
- `express.json` cap remains 50mb; multipart uploads are not bound by it, and the
  per-image 5MB limit still applies.

**Files Changed:**
- `src/components/chat/hooks/useChatComposerState.ts`
- `server/index.js`

**Commit:** `52257b4`

---

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
