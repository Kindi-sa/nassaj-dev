# nassaj-dev — Change Log

## 2026-06-05 — Fix: bump service-worker cache to force clients to load new builds

**الملخص (AR):** كانت تحديثات الواجهة لا تظهر لبعض المستخدمين بعد النشر لأن نُسخ Service Worker قديمة في متصفّحاتهم كانت تحتفظ بكاش الأصول تحت اسم الكاش نفسه (`claude-ui-v2`) وتقدّمه بدل البناء الجديد. الإصلاح الجذري: ترقية اسم الكاش في ملف المصدر `public/sw.js` من `claude-ui-v2` إلى `claude-ui-v3`، ما يجعل حدث `activate` (الذي يحذف كل كاش لا يطابق `CACHE_NAME` الحالي) يُخلي الكاش القديم تلقائياً عند تفعيل الـSW الجديد. للتفعيل الفوري دون انتظار إغلاق كل التبويبات، الـSW يستخدم `self.skipWaiting()` في `install` و`self.clients.claim()` في `activate` (كلاهما كان موجوداً مسبقاً)، فتسري الترقية فوراً. لم نمسّ منطق الـfetch/التخزين (network-first للـHTML، cache-first للأصول المُجزّأة تحت `/assets/`) — التغيير اقتصر على اسم الكاش لإجبار إخلاء الكاش القديم.

**Fix:**
- Stale Service Worker instances in users' browsers kept serving cached assets
  under the same cache name (`claude-ui-v2`), hiding UI updates after deploy.
- Bumped `CACHE_NAME` in the source file `public/sw.js` from `claude-ui-v2` to
  `claude-ui-v3`. The existing `activate` handler deletes every cache whose name
  does not match the current `CACHE_NAME`, so the stale cache is now evicted
  automatically when the new SW activates.
- The SW already calls `self.skipWaiting()` (in `install`) and
  `self.clients.claim()` (in `activate`), so the new worker takes control
  immediately without waiting for all tabs to close — future bumps apply at once.
- No change to fetch/caching logic (network-first HTML, cache-first hashed
  `/assets/`); only the cache name changed to force eviction.

**Files Changed:**
- `public/sw.js`

## 2026-06-05 — Feature: toggle to show/hide the session participants bar + decouple it from multi-user

**الملخص (AR):** أضفنا تفضيل واجهة "إظهار شريط المشاركين" (Show participants bar) في تبويب المظهر (Appearance) بجوار مفتاح RTL تماماً، يتبع نفس نمطه: context موحّد (`ParticipantsBarProvider` + `useParticipantsBar`) يقرأ/يكتب القيمة في `localStorage` (مفتاح `showParticipantsBar`)، والافتراضي **ظاهر (on)** حتى لا يتغيّر سلوك المستخدمين الحاليين. في `ChatInterface` صار الشريط ملفوفاً بشرط `{showParticipantsBar && <SessionParticipantsBar/>}` يلفّ المكوّن نفسه — فعند الإخفاء لا يُركَّب المكوّن إطلاقاً، وبالتالي لا يُستدعى الـhook ولا الـpolling (كل 10 ثوانٍ) ولا أي طلب شبكي. أُضيفت مفاتيح الترجمة `appearanceSettings.participantsBar` لكل اللغات التسع، مع `aria-label` على المفتاح. كذلك فككنا ارتباط الشريط الخفيف عن الهوية الملغاة (multi-user): جوهر الشريط هو صف الوكلاء/الأدوار (model + subagents) المستخرج من الترانسكريبت وهو مستقل تماماً عن الهوية، ويُعرض طالما `agents.length > 0` وحده؛ أما كتلة المستخدمين البشر (كوم الصور + الأسماء) فأصبحت طبقة إضافية اختيارية تتدهور بأمان لمستخدم واحد أو لا شيء عند خواء قائمة participants، ولا تَحجُب الشريط وحدها. لم نلمس الخادم ولا schema قاعدة البيانات ولا الـAPI (جداول `session_participants` باقية كما هي) — تعديل واجهة فقط.

**Feature:**
- New Appearance-tab toggle "Show participants bar" next to the RTL toggle,
  following the exact same pattern: a unified context
  (`ParticipantsBarProvider` + `useParticipantsBar`) that reads/writes
  `localStorage` (key `showParticipantsBar`). Default is **on** so existing
  users see no behaviour change.
- In `ChatInterface` the bar is now wrapped as
  `{showParticipantsBar && <SessionParticipantsBar/>}` — the condition wraps the
  component itself, so when hidden the component never mounts and therefore the
  `useSessionParticipants` hook, its 10s polling, and all network requests are
  skipped entirely (network saving).
- Added `appearanceSettings.participantsBar` i18n keys to all nine locales;
  `aria-label` on the toggle. No hardcoded strings.

**Decouple from multi-user:**
- The bar's core is the agents/roles row (model + subagents) derived from the
  transcript — fully independent of identity/multi-user. It renders whenever
  `agents.length > 0` on its own.
- The human-participants block (avatar stack + names) is now an explicitly
  additive, optional layer that degrades safely to a single user (or nothing)
  when the identity layer returns no participants; it never gates the bar.
- Comment-only update to `participants/types.ts` reflecting that the agents/roles
  display is the core and the human piece is just a session owner/participants
  display. No server, DB schema, or API changes; `session_participants` tables
  remain untouched.

**Files Changed:**
- `src/contexts/ParticipantsBarContext.jsx` (new)
- `src/App.tsx`
- `src/components/chat/view/ChatInterface.tsx`
- `src/components/settings/view/tabs/AppearanceSettingsTab.tsx`
- `src/components/participants/SessionParticipantsBar.tsx`
- `src/components/participants/types.ts`
- `src/i18n/locales/{ar,de,en,it,ja,ko,ru,tr,zh-CN}/settings.json`

## 2026-06-05 — Change: point update checker to our own repo (independent fork channel)

**الملخص (AR):** كان مدقّق التحديث (`useVersionCheck`) يقارن نسختنا المحلية بأحدث إصدار في مستودع الأصل `siteboon/claudecodeui`. وبما أننا fork مستقل تقدّمنا فيه بميزات كثيرة لكننا متأخرون برقم نسخة الصيانة (patch) عن الأصل، كانت علامة "يتوفّر تحديث" تظهر دائماً كإزعاج كاذب لا يعكس واقعنا. الحل: توجيه المدقّق إلى قناتنا `Kindi-sa/nassaj-dev` بتغيير وسيطَي owner/repo في موضعَي الاستدعاء فقط. لم يُمَسّ منطق المدقّق (المقارنة، الفحص الدوري كل 5 دقائق، معالجة الأخطاء). حتى ننشئ releases على مستودعنا، يفشل الجلب (مستودع خاص → 404) فلا تظهر أي علامة — وهو السلوك المقصود والآمن. دمج تحديثات upstream يبقى عملية انتقائية يدوية مستقلة عن هذه العلامة.

**Problem:**
The update checker (`useVersionCheck`) compared our local version against the
latest GitHub release of the upstream repo `siteboon/claudecodeui`. As an
independent fork we are ahead on features but behind on the upstream maintenance
(patch) version number, so the "update available" badge was permanently shown —
a false alarm that did not reflect our actual state.

**Fix:**
- Pointed the checker at our own channel `Kindi-sa/nassaj-dev` by changing only
  the `owner` / `repo` arguments at the two call sites.
- The checker logic itself (version comparison, 5-minute periodic check, error
  handling) is left entirely unchanged.
- Until we publish releases on our repo, the fetch fails (private repo → 404),
  so no badge is shown — the intended, safe behavior. Merging upstream updates
  remains a separate, manual, selective process unrelated to this badge.

**Files Changed:**
- `src/components/sidebar/view/Sidebar.tsx`
- `src/components/settings/view/tabs/AboutTab.tsx`

## 2026-06-05 — Security: redact auth token from WebSocket logs (adopted from upstream #827)

**الملخص (AR):** كانت خدمة مصادقة WebSocket تسجّل عنوان طلب الترقية (`request.url`) خاماً عبر `console.log`، وبما أن توكن JWT يُمرَّر كـ query param (`?token=...`) في رابط الاتصال، كان التوكن يُسرَّب نصاً صريحاً في سجلّات السيرفر. الحل: قبل التسجيل نبني نسخة من الـURL ونستبدل قيمة `token` بـ`REDACTED`، ثم نسجّل المسار والاستعلام المحجوبَين فقط. لم يُمَسّ منطق التحقق/المصادقة/العزل إطلاقاً — تغيير تسجيل فقط. مقتبس حرفياً من إصلاح upstream في siteboon/claudecodeui#827 (ضمن v1.33.1).

**Problem:**
The WebSocket auth service logged the raw upgrade URL (`request.url`) via
`console.log`. Because the JWT auth token is passed as a query parameter
(`?token=...`) on the connection URL, the token was leaked in clear text into
the server logs on every WebSocket connection attempt.

**Fix:**
- Before logging, build a copy of the parsed upgrade URL and, if a `token`
  query param is present, replace its value with `REDACTED`. Only the redacted
  `pathname` + `search` is then logged.
- The token-extraction / authentication / per-user isolation logic is left
  entirely unchanged — this is a logging-only change. (The `upgradeUrl` parse
  was hoisted so it is shared between the redacted-log path and token reading.)
- Confirmed the sibling WS dispatcher (`websocket-server.service.ts`) only logs
  `pathname` (no query string), so no further redaction was needed there.
- Adopted verbatim from upstream siteboon/claudecodeui#827 (commit `14ddbc7`,
  part of v1.33.1); our file matched the upstream pre-fix version exactly.

**Files Changed:**
- `server/modules/websocket/services/websocket-auth.service.ts`

## 2026-06-05 — Feature: Select a linked GitHub repository when creating a project

**الملخص (AR):** كان حقل المستودع في حوار "إنشاء مشروع جديد" يقبل لصق رابط URL يدوياً فقط. الآن يمكن للمستخدم اختيار مستودع من حساب GitHub الخاص به مباشرة عبر قائمة قابلة للبحث (combobox)، باستخدام التوكن المخزّن لكل مستخدم. أُضيف endpoint جديد `GET /api/github/repos` يجلب المستودعات عبر octokit. الإبقاء على خيار لصق الرابط اليدوي ومسار الاستنساخ (clone) بلا تغيير، مع toggle بين "اختر من مستودعاتي" و"الصق رابط". لا يُسرَّب التوكن في الرد أو اللوغ، والوصول مقيَّد بـ `user_id`.

**Problem:**
The repository field in the "Create New Project" wizard accepted only a manually
pasted GitHub URL. Users with a stored GitHub token had no way to browse and pick
one of their own repositories — they had to copy the URL from GitHub by hand.

**Fix:**
- Added a new backend endpoint `GET /api/github/repos` (`server/routes/github.js`,
  mounted in `server/index.js`) that lists the authenticated user's repositories
  via octokit, using the GitHub token stored per-user.
- Added a searchable combobox (`GithubRepoPicker.tsx`) in step 2 of the wizard,
  driven by the `useGithubRepos` hook and the `workspaceApi` data layer.
- A toggle switches the repository source between "Choose from my repositories"
  and "Paste URL". The manual URL paste path and the underlying clone flow are
  unchanged; the picker simply fills the same repository URL field.
- Loading / empty / no-match / error / invalid-token / no-token states are all
  handled in the UI, with retry and "manage tokens in settings" affordances.
- i18n strings (`projectWizard.step2.repos`) added across 9 locales.

**Security:**
- The GitHub token is never returned in the response body or written to logs;
  only repository metadata (name, URL, visibility) is exposed.
- Repository listing is scoped to the requesting user via `user_id`; a user
  cannot read another user's token or repositories (IDOR protection).
- Covered by 4 security tests in `server/routes/tests/github.test.ts`:
  IDOR isolation, no-token handling, response-shape (no token leakage), and
  invalid-token handling. (Test script gains `--experimental-test-module-mocks`.)

**Files Changed:**
- `server/routes/github.js` (new)
- `server/index.js`
- `server/routes/tests/github.test.ts` (new)
- `package.json` (test script)
- `src/components/project-creation-wizard/types.ts`
- `src/components/project-creation-wizard/data/workspaceApi.ts`
- `src/components/project-creation-wizard/hooks/useGithubRepos.ts` (new)
- `src/components/project-creation-wizard/components/GithubRepoPicker.tsx` (new)
- `src/components/project-creation-wizard/components/StepConfiguration.tsx`
- `src/components/project-creation-wizard/ProjectCreationWizard.tsx`
- `src/i18n/locales/{ar,de,en,it,ja,ko,ru,tr,zh-CN}/common.json`

**Commit:** _(see git history for this feature)_

---

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
