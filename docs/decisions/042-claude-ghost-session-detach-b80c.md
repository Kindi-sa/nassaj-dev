# ADR-042 — معالجة الجلسات الشبحية في claude عبر Detach لا Abort (إصلاح B-80c / المرحلة 2 من B-80)

> **سجلّ قرار معماري (ADR).** الصيغة: Context → Alternatives → Decision → Consequences → Status.
> الكود في `/home/nassaj/Project/nassaj-dev`. ينفّذ «القرار 3» الذي بوّبه ADR-041 كنطاق منفصل (المرحلة 2)، **ويعكس توصيته الأولية** (abort-with-jsonl) إلى **detach** بعد قراءة دورة حياة الـSDK child.

| الحقل | القيمة |
|---|---|
| **Status** | 🟡 **Proposed** — تصميم جاهز للتنفيذ من backend-dev، بانتظار اعتماد المالك + بوابة qa-critic. **لا كود مُنفَّذ بعد** (هذا الـADR هو المخرج الوحيد). |
| **التاريخ** | 2026-06-22 |
| **المالك** | i.rukhaimi |
| **يُكمل** | ADR-041 (Claude Live-Stream Replay / B-80a) — المرحلة 1 عالجت **التجمّد** (replay-only)؛ هذا يعالج **التسريب الشبحي** (المرحلة 2). متعامد ولا يتقاطع. |
| **يمدّ** | ADR-021 (Session Survival & Replay) + ADR-022/B-23/B-41 (drain) — يضيف بُعد «detach من حساب الـdrain» دون لمس فيتو no-swap (B-N1) ولا منطق الـdrain نفسه. |
| **يعالج** | B-80c — جلسة claude تبقى محسوبة `active` في `activeSessions` أبداً بعد موت كل مستمعيها، فتدخل drain عند كل `pm2 restart` وتنتظر حتى `kill_timeout=5min`. |

---

## Context (السياق)

### العطل المؤكَّد سلوكياً (سجل restart 2026-06-22 11:12)

عند انقطاع WebSocket أثناء بثّ claude **حيّ ونشط**:

1. حلقة `for await (const message of queryInstance)` في `claude-sdk.js:1333` **تستمر بلا abort**. `WebSocketWriter.send` صار no-op صامتاً (حارس `readyState` في `websocket-writer.service.ts:99`) لكن الحلقة تستهلك مخرَج الـSDK وترميه.
2. الجلسة تبقى في `activeSessions` (`claude-sdk.js:94`) بحالة `active` حتى تنتهي **طبيعياً** — حتى لو أُغلقت كل تبويبات المستخدم (لا مستمع حيّ، لا مرآة).
3. `getActiveClaudeSDKSessions()` = `Array.from(activeSessions.keys())` (`claude-sdk.js:687-689`) هو **مصدر عدّ الـdrain** (`index.js:2043`: `claude: getActiveClaudeSDKSessions().length`).
4. النتيجة: «جلسات شبحية» تتراكم. كل `pm2 restart` يدخل `shutdown-drain.service.ts` الذي ينتظر `total > 0` (بلا سقف، `DRAIN_TIMEOUT_MS=0` — قرار B-N-DRAIN)، فيعلَق حتى يضرب PM2 سقف `kill_timeout=5min` (المُلاحَظ من المالك).

> **ملاحظة دقيقة:** ADR-041/B-80a (replay) **لا يحلّ هذا**. الـreplay يعيد ربط مستمع **عائد**؛ لكن الجلسة الشبحية **لا يعود لها أحد** — لا تبويب يفتح `check-session-status` لها فلا `addSessionMirror` ولا `attachClaudeSDKSession`. تبقى active في الذاكرة بلا متلقٍّ.

### السؤال الحاكم [الأخطر]: هل transcript JSONL مستقلّ عن البثّ؟ — **نعم، مؤكَّد**

دورة حياة الـSDK (الإصدار **0.3.152**، مقروء من `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

- **الـSDK يُشغِّل `claude` CLI كعملية ابنة** (subprocess) ويتواصل معها عبر stdio (stream-json). نصّ الـSDK الحرفي (سطر 5607–5614، توثيق `Options.abortController`): الإجهاض «calls `child.kill()`»؛ وتوثيق `query.close()` (سطر ~2381): «terminate the underlying process … **the CLI subprocess**».
- **الـCLI الابن يملك الجلسة ويكتب `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` بنفسه** بشكل تزايدي أثناء معالجة الـturn. حلقة `for await` في الخادم **مستهلِك لأحداث stdout**، **ليست محرّك** حلقة turn في الـCLI.
- **الدليل البنيوي:** الجلسة محسوبة `active` «تكتب على القرص» (نص ADR-041:24)؛ ومونيتور العمليات (`session-process-monitor.js`) يثبت أن لكل run **pid ابن** فعلي قابل للتجميد بـ`kill -STOP`. ابنٌ بـpid يكتب transcript = الكتابة لا تمرّ عبر السوكِت ولا عبر استهلاك الـgenerator.

**الخلاصة الحاسمة:** الـjsonl محفوظ بصرف النظر عن السوكِت. لكن هذا **لا يعني أن abort آمن بالكامل** — انظر التحليل التالي، فهو محور القرار.

### الفرق الدقيق بين «abort» و«detach» (لبّ القرار)

| | abort (`queryInstance.interrupt()`/`.close()` → `child.kill()`) | detach (ترك الحلقة تكمل طبيعياً + إخراجها من حساب الـdrain) |
|---|---|---|
| **العمل المكتوب سلفاً في jsonl** | محفوظ (الابن كتبه تزايدياً) | محفوظ |
| **بقيّة الـturn الجاري وقت القطع** | **يُفقَد** — `child.kill()` يقطع كل ما لم يُنتجه الابن بعد (سلسلة أدوات/توليد طويلة في الورشة قد تكون ضخمة) | **لا يُفقَد** — الابن يكمل الـturn حتى نهايته الطبيعية ويكتبه كاملاً |
| **عدّ الـdrain** | يخرج فوراً (أُزيل من `activeSessions`) | يخرج فوراً (يُعلَّم detached فلا يُحسب) — **نفس أثر إنهاء التسريب** |
| **العملية الابنة** | تموت | تبقى حتى تكمل (مثل سلوك الـdrain المقصود لـB-2: «الأبناء يكملون») |
| **التناسق مع فلسفة الخادم** | يناقض B-N-DRAIN («drain بلا سقف، الأدوار قد تعمل ساعات») | **يطابقها**: الـdrain أصلاً يترك الأبناء يكملون؛ نحن فقط نوقف **عدّهم** عندما لا متلقٍّ |

**الاستنتاج:** ما دام jsonl يُكتب من الابن، فإن **detach يحقق هدف B-80c (إخراج الشبح من عدّ الـdrain) بصفر فقد عمل**، بينما abort يحققه **بثمن فقد بقيّة الـturn** — وهو السيناريو الأخطر للورش الطويلة المذكور صراحةً في التكليف. لا مبرّر لدفع هذا الثمن: قتل العملية لا يوفّر شيئاً جوهرياً (الذاكرة التي تحرّرها ضئيلة مقابل خطر إتلاف ساعة عمل)، والمشكلة المُبلَّغ عنها هي **تأخّر الـrestart**، وحلّها هو **عدم عدّ الشبح**، لا قتله.

> هذا **يعكس عمداً** «القرار 3» في ADR-041 (الذي اقترح abort-with-jsonl). السبب: ADR-041 افترض أن «إبقاء كتابة jsonl» كافٍ للأمان، لكنه أغفل أن abort يقطع **بقيّة الـturn غير المكتوب بعد**. detach يرفع هذا الخطر كلياً.

### كشف «انعدام كل المستمعين»

المتلقّون الأحياء لجلسة هم اثنان فقط:
- **الـwriter الأساسي:** `session.writer.ws.readyState === WS_OPEN_STATE` (`websocket-writer.service.ts:99`، `WS_OPEN_STATE` من `websocket-state.service.ts`).
- **المرايا:** `sessionMirrors.get(sessionId)` — مجموعة سوكِتات قراءة-فقط (`websocket-writer.service.ts:20`)؛ حيّة = `mirror.readyState === WS_OPEN_STATE`.

لا يوجد حالياً API يكشف «هل لجلسة مرآة حيّة؟». نضيف seam صغيراً في `websocket-writer.service.ts` يحسب عدد المرايا الحيّة لـ`sid` (مع تقليم الميتة، كما يفعل `fanOutToMirrors`). «انعدام كل المستمعين» = الـwriter الأساسي غير OPEN **و** عدد المرايا الحيّة = 0.

### القيد الحاكم من ADR-021/041: فيتو no-swap (B-N1)

detach **لا يلمس** هذا الفيتو إطلاقاً: لا تبديل writer، لا رفع `if(!isActive)`، لا حقن إدخال. هو حصراً: (1) إيقاف عدّ الجلسة في الـdrain، (2) ترك الـgenerator يكمل ويُنظّف نفسه طبيعياً. والأهم: **detach يقع فقط عند انعدام كل المستمعين** — أي بعد إغلاق كل التبويبات فعلاً؛ ومع B-80a، أي reconnect يسجّل مرآة، فيمنع detach تلقائياً. التعايش بين B-80a وB-80c محكم: B-80a يُبقي الجلسة حيّة للعائدين، وB-80c يُنهيها فقط حين لا عائد.

---

## Alternatives (البدائل المدروسة)

| البديل | سبب القبول/الرفض |
|---|---|
| **(أ) إجهاض فوري عند حدث `close` للسوكِت الأساسي** | **مرفوض** — يقتل عمل الورشة عند انقطاع شبكي عابر (Cloudflare idle/keepalive، code 1006)؛ ولا يحترم المرايا (قد يكون مشاهد آخر حيّاً). نفس رفض البديل (ج) في ADR-041. |
| **(ب) إجهاض (abort) عند انعدام كل المستمعين بعد grace-period، مع إبقاء jsonl** (= «القرار 3» في ADR-041) | **مرفوض بعد التحليل** — يحقق الهدف لكن **يفقد بقيّة الـturn الجاري** (السيناريو الأخطر). الـjsonl المكتوب سلفاً محفوظ، لكن ما لم يُنتجه الابن بعد يُقطع بـ`child.kill()`. لا يُدفع هذا الثمن إذ detach يحقق نفس الهدف بلا فقد. |
| **(ج) Detach: عند انعدام كل المستمعين بعد grace-period، أخرِج الجلسة من عدّ الـdrain (علّمها `detached`) واترك الـgenerator يكمل طبيعياً ويكتب jsonl كاملاً** | **مقبول ومُختار** — يُنهي التسريب (الشبح لا يُحسب في الـdrain) **بصفر فقد عمل**. يطابق فلسفة B-N-DRAIN (الأبناء يكملون). لا يلمس فيتو no-swap. آمن عند إطفاء العلم (no-op). |
| **(د) تقليم زمني صرف (TTL على عمر الجلسة في activeSessions)** | **مرفوض** — يقتل/يُسقط جلسات شرعية طويلة (ورشة 3 ساعات) لمجرد طول عمرها، بلا علاقة بوجود مستمع. المعيار الصحيح = «لا متلقٍّ» لا «طويلة». |
| **(هـ) جعل عدّ الـdrain يقرأ registry `active` بدل `activeSessions`** | **مرفوض كحل مستقل** — لا يكفي وحده: registry `active` يبقى true حتى الـterminal الطبيعي أيضاً (نفس مشكلة `activeSessions`). والأخطر: يربط الـdrain بعلم `SESSION_REGISTRY_claude` (يُعطّل الـdrain لـclaude كلياً عند إطفاء العلم). detach يعمل في طبقة `activeSessions` المستقلة عن العلم. |

---

## Decision (القرار)

### القرار 1 — آلية الكشف: «انعدام كل المستمعين» في طبقة الـwriter

أضف في `websocket-writer.service.ts` دالة مُصدَّرة:

```ts
// عدد المرايا الحيّة لجلسة (يقلّم الميتة كما يفعل fanOutToMirrors).
export function countLiveMirrors(sessionId: string): number {
  const mirrors = sessionMirrors.get(sessionId);
  if (!mirrors || mirrors.size === 0) return 0;
  let live = 0;
  for (const mirror of mirrors) {
    if (mirror.readyState !== WS_OPEN_STATE) { mirrors.delete(mirror); continue; }
    live += 1;
  }
  if (mirrors.size === 0) sessionMirrors.delete(sessionId);
  return live;
}
```

وفي `WebSocketWriter` أضف فحص حياة السوكِت الأساسي (يُقرأ من `claude-sdk.js` عبر `session.writer`):

```ts
isPrimarySocketAlive(): boolean {
  return this.ws?.readyState === WS_OPEN_STATE;
}
```

«انعدام كل المستمعين» لجلسة `sid` =
`!session.writer.isPrimarySocketAlive() && countLiveMirrors(sid) === 0`.

### القرار 2 — مكان الفحص: مؤقّت دوري كسول في `claude-sdk.js` (لا حدث close)

**لماذا لا حدث `close`؟** حدث `close` للسوكِت في `chat-websocket.service.ts:563` لا يعرف أي جلسة كانت تُبثّ إليه عبر المرايا (المرآة سوكِت لا writer)، والـwriter الأساسي قد يموت دون حدث close نظيف (1006). الأنظف: مؤقّت دوري يفحص `activeSessions` (مثل نمط `session-process-monitor.js` الموجود).

أضف في `claude-sdk.js`:

```js
// خلف علم detach: كل كم ثانية، افحص الجلسات النشطة؛ من فقدت كل مستمعيها
// منذ مدة تتجاوز grace-period تُعلَّم detached فلا تُحسب في الـdrain.
const GHOST_DETACH_SWEEP_MS = 30000;          // دورية الفحص (كسول مثل المونيتور)
const GHOST_DETACH_GRACE_MS = parseInt(process.env.CLAUDE_GHOST_DETACH_GRACE_MS, 10) || 180000;
let ghostSweepTimer = null;

function startGhostSweep() {
  if (ghostSweepTimer || !ghostDetachEnabled()) return;
  ghostSweepTimer = setInterval(sweepGhostSessions, GHOST_DETACH_SWEEP_MS);
  ghostSweepTimer.unref?.();              // لا يُبقي event loop حياً عند الإيقاف
}

function sweepGhostSessions() {
  if (activeSessions.size === 0) { stopGhostSweep(); return; }
  const now = Date.now();
  for (const [sid, session] of activeSessions) {
    if (session.detached) continue;        // عُلِّمت سلفاً
    const writerAlive = session.writer?.isPrimarySocketAlive?.() === true;
    const liveMirrors = countLiveMirrors(sid);   // مستورد من writer service
    if (writerAlive || liveMirrors > 0) {
      session.lastListenerSeenAt = now;    // ما زال له متلقٍّ — صفّر العدّاد
      continue;
    }
    // لا متلقٍّ. ابدأ/استمر عدّ grace.
    if (!session.noListenerSince) session.noListenerSince = now;
    if (now - session.noListenerSince >= GHOST_DETACH_GRACE_MS) {
      session.detached = true;             // ← يخرجها من عدّ الـdrain (القرار 3)
      console.log(`[GHOST-DETACH] session=${sid} detached after no-listener grace; `
        + `generator left to complete and write jsonl (no abort)`);
    }
  }
}
```

ويُستدعى `startGhostSweep()` داخل `addSession` (بعد تسجيل الجلسة)، و`stopGhostSweep()` عندما تفرغ `activeSessions` (في `removeSession` إن `size===0`). الحقول `detached`/`noListenerSince`/`lastListenerSeenAt` تُضاف لكائن الجلسة في `addSession` (`claude-sdk.js:638`).

> **لا abort.** الـgenerator يبقى يعمل؛ عند انتهائه طبيعياً يمرّ على `removeSession` المعتاد (`claude-sdk.js:1439`) فيُنظَّف. detach يغيّر **فقط** هل يُحسب في الـdrain.

### القرار 3 — إخراج الجلسات detached من عدّ الـdrain

عدّ الـdrain يجب أن يستثني `detached`. خياران (يُختار الأبسط أثرَ تماس):

أضف في `claude-sdk.js` دالة مُصدَّرة جديدة تُستهلك **حصراً** من الـdrain:

```js
// عدد جلسات claude التي ما زالت يجب أن ينتظرها الـdrain: النشطة غير المُنفصلة.
// الجلسات detached (فقدت كل مستمعيها وتجاوزت grace) تكمل بالخلفية وتكتب jsonl،
// فلا يجب أن تُبقي restart عالقاً حتى kill_timeout.
function getDrainBlockingClaudeSessions() {
  const out = [];
  for (const [sid, session] of activeSessions) {
    if (!session.detached) out.push(sid);
  }
  return out;
}
```

وفي `index.js:2042-2043` يُبدَّل مصدر عدّ claude في الـdrain فقط:

```js
countActiveSessionsByProvider: () => ({
  claude: getDrainBlockingClaudeSessions().length,   // كان getActiveClaudeSDKSessions().length
  // ... بقية المزوّدات دون مساس
}),
```

> **`getActiveClaudeSDKSessions()` يبقى دون تغيير** (تستهلكه الواجهة/`get-active-sessions`/الـWS-DIAG): الجلسة detached ما زالت «نشطة» منطقياً للعرض، لكنها ليست «حاجزة للـdrain». فصلٌ نظيف بين المفهومين.

### القرار 4 — العلم/البوابة

**علم منفصل: `CLAUDE_GHOST_DETACH`** (لا إعادة استخدام `SESSION_REGISTRY_claude`).

التبرير:
- `SESSION_REGISTRY_claude` يحكم **replay/buffer** (B-80a) — مفهوم مستقل تماماً عن detach. ربطهما يمنع تفعيل/إطفاء أحدهما دون الآخر، ويخلط مساري اختبار.
- **عند إطفاء `CLAUDE_GHOST_DETACH`** (الافتراضي): `ghostDetachEnabled()` يعيد false، `startGhostSweep` لا يبدأ، `getDrainBlockingClaudeSessions` لا يُستدعى من الـdrain إلا إن أردنا — **والأنظف**: عند إطفاء العلم، `index.js` يستخدم `getActiveClaudeSDKSessions().length` كما هو الآن (بايت-بايت). أي السلوك القديم محفوظ حرفياً عند الإطفاء.

```js
function ghostDetachEnabled() {
  const raw = process.env.CLAUDE_GHOST_DETACH;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
```

وفي `index.js` يُحرَس مصدر العدّ بالعلم:

```js
claude: (ghostDetachEnabled()
  ? getDrainBlockingClaudeSessions()
  : getActiveClaudeSDKSessions()).length,
```

(يُصدَّر `ghostDetachEnabled` من `claude-sdk.js`.)

**هل يلزم تعديل الـdrain نفسه (`shutdown-drain.service.ts`)؟ لا.** الـdrain يستهلك `countActiveSessionsByProvider()` كصندوق أسود؛ يكفي أن يُرجع المصدرُ المحقونُ في `index.js` العددَ الصحيح (غير الحاجز). صفر تغيير في منطق الـdrain، صفر خطر على B-23/B-41.

### القرار 5 — مقارنة بآلية agy المناظرة

agy (`agy-cli.js`) يُشغّل **عملية ابنة حقيقية** (PTY) فله `session.process` و`abortAntigravitySession` يقتلها بـSIGTERM→SIGKILL. **لا آلية detach مناظرة في agy** — وله **نفس الثغرة الشبحية** (عدّ الـdrain لـagy = `getActiveAntigravitySessions()` = `activeSessions.keys()`، لا يستثني شبحاً). هذا الـADR **لا يعالج agy** (نطاق B-80c = claude حصراً)، لكن البنية المُختارة (علم + `getDrainBlocking*` + sweep) **قابلة للنقل حرفياً إلى agy لاحقاً** ببند منفصل. يُسجَّل كدَين معروف لا كنطاق.

> **فرق جوهري عن agy:** abort في agy آمن نسبياً لأن ابن PTY يكتب transcript بنفسه أيضاً، لكن **نفس خطر فقد بقيّة الـturn قائم**. لذا لو نُقل لاحقاً، يُفضَّل detach لـagy أيضاً لا abort.

### فيتو no-swap

**يُحترم صرفاً.** detach لا يبدّل writer، لا يرفع `if(!isActive)`، لا يطعم إدخالاً. يقع فقط حين لا مستمع حيّ (كل التبويبات مغلقة)، فلا يتقاطع مع أي reconnect (الذي يسجّل مرآة فيمنع detach).

---

## grace-period: القيمة والمبرّر

**`GHOST_DETACH_GRACE_MS = 180000` (3 دقائق)، قابل للتجاوز بـ`CLAUDE_GHOST_DETACH_GRACE_MS`.**

المبرّر (يجب أن يتجاوز نافذة reconnect المعتادة بأمان):
- **نافذة reconnect العميل:** عند موت السوكِت يحاول العميل إعادة الاتصال خلال ثوانٍ، فيرسل `check-session-status` → `addSessionMirror` → الجلسة تستعيد متلقّياً. grace يجب أن يتجاوز أسوأ حالة reconnect (شبكة سيئة/Cloudflare).
- **مواءمة استبقاء B-80a:** `CLAUDE_BUFFER_RETENTION_MS = 120000` (`claude-sdk.js:63`) هو نافذة استبقاء البفر بعد الـterminal. grace للـdetach يجب أن يكون **أطول** من هذه (180s > 120s): ما دام البفر قائماً، عودة العميل تستعيده فوراً؛ نمنح هامشاً فوق نافذة الاستبقاء قبل أي detach.
- **3 دقائق ≪ 5 دقائق (`kill_timeout`):** الهدف أن يقع detach **قبل** أن يصبح الشبح مشكلة restart. لو بقي الشبح غير محسوب بعد 3 دقائق من فقد كل متلقٍّ، فأي restart بعدها لا ينتظره. وحتى لو حدث restart خلال الـ3 دقائق، فالأسوأ هو سلوك اليوم (انتظار محدود)، لا تدهور.
- **detach ليس قتلاً:** بما أن detach لا يفقد عملاً، فحتى لو كانت 3 دقائق «مبكرة قليلاً» لجلسة كانت ستعود، لا ضرر: الجلسة تكمل بالخلفية وتكتب jsonl، والعميل العائد بعدها يقرأ الـtranscript المكتمل من القرص (مسار history العادي). الخطأ في اتجاه detach **غير مكلف**، بخلاف abort.

> **حساسية القيمة منخفضة بفضل اختيار detach:** لو كان القرار abort لكانت grace حرجة (قِصَرها = فقد عمل). مع detach، grace مجرّد «متى نتوقف عن العدّ»، وكلا طرفيه آمن. هذا بُعد إضافي يرجّح detach.

---

## خطة التنفيذ الملموسة (file:line + شبه كود)

> backend-dev ينفّذها بعد اعتماد المالك + qa-critic. **لا تُنفَّذ مع ADR**.

### 1) `server/modules/websocket/services/websocket-writer.service.ts`
- **بعد سطر 78** (بعد `fanOutToMirrors`): أضف `export function countLiveMirrors(sessionId): number` (شبه الكود في القرار 1) — يقلّم الميتة ويعيد عدد الحيّة.
- **داخل `class WebSocketWriter` (بعد سطر 112)**: أضف `isPrimarySocketAlive(): boolean { return this.ws?.readyState === WS_OPEN_STATE; }`.

### 2) `server/claude-sdk.js`
- **بعد سطر 99** (بعد ثوابت `recentlyEndedSessions`): أضف ثوابت `GHOST_DETACH_*` ودالة `ghostDetachEnabled()` (القرار 4) و`ghostSweepTimer` + `startGhostSweep`/`stopGhostSweep`/`sweepGhostSessions` (القرار 2). استورد `countLiveMirrors` من `./modules/websocket/services/websocket-writer.service.js`.
- **`addSession` (سطر 638)**: أضف للحقول `detached: false, noListenerSince: null, lastListenerSeenAt: Date.now()`؛ وفي نهايتها `startGhostSweep()`.
- **`removeSession` (سطر 665)**: بعد `activeSessions.delete(sessionId)` أضف `if (activeSessions.size === 0) stopGhostSweep();`.
- **بعد `getAllSessions` (سطر 689)**: أضف `getDrainBlockingClaudeSessions()` (القرار 3).
- **تصدير (سطر 1753)**: أضف `getDrainBlockingClaudeSessions, ghostDetachEnabled`.

### 3) `server/index.js`
- **استيراد claude-sdk (سطر ~21)**: أضف `getDrainBlockingClaudeSessions, ghostDetachEnabled`.
- **سطر 2042-2043**: بدّل قيمة `claude` بالتعبير المحروس بالعلم (القرار 4).

### 4) لا تغيير في `shutdown-drain.service.ts` ولا `session-registry.js` ولا `agy-cli.js`.

### العلم في `.env`/`.env.example`
- وثّق `CLAUDE_GHOST_DETACH` (افتراضي معطّل) و`CLAUDE_GHOST_DETACH_GRACE_MS=180000` في `.env.example` مع شرح: «detach جلسة claude الشبحية من عدّ الـdrain بعد فقد كل مستمعيها grace ثانية؛ لا يجهض العمل».

---

## تحليل المخاطر — مُركَّز على فقد عمل الورشة الطويلة (السيناريو الأخطر)

| المخاطرة | الاحتمال/الأثر | المعالجة في التصميم |
|---|---|---|
| **[الأخطر] فقد بقيّة turn ورشة طويلة** | **مُلغى بنيوياً** — detach لا يستدعي `interrupt/close/kill`؛ الـgenerator يكمل، الابن يكتب jsonl كاملاً | اختيار detach بدل abort هو جوهر هذا الـADR؛ صفر مسار يقتل العملية |
| **detach مبكر لجلسة كانت ستعود** | منخفض الأثر — الجلسة تكمل بالخلفية، العميل العائد يقرأ transcript مكتمل من القرص | grace 180s > نافذة reconnect + > BUFFER_RETENTION 120s؛ والخطأ في اتجاه detach غير مكلف |
| **سباق: detach يُعلَّم ثم يعود العميل قبل انتهاء الـgenerator** | منخفض — الجلسة detached لكنها لا تزال في `activeSessions` وحيّة؛ العميل العائد يسجّل مرآة ويستقبل البثّ المتبقّي عبر fan-out **طبيعياً** (الـwriter.send يفنّ للمرايا بصرف النظر عن detached) | detached يؤثر **فقط** على عدّ الـdrain، لا على البثّ؛ ولا يلزم «إلغاء detach» — لو أردنا تحسيناً لاحقاً يمكن مسح `detached` عند عودة مرآة، لكنه غير ضروري للصحة |
| **تسريب timer (المؤقّت الدوري لا يُنظَّف)** | منخفض | `stopGhostSweep()` عند فراغ `activeSessions`؛ و`.unref()` يمنع إبقاء event loop حياً عند الإيقاف/الـdrain |
| **استيراد دائري claude-sdk ↔ writer service** | متوسط (claude-sdk.js يستورد من writer service لأول مرة) | `websocket-writer.service.ts` لا يستورد `claude-sdk.js` (تحقّقت: يستورد فقط `websocket-state` و`types`)؛ الاتجاه أحادي، لا دائرية. backend-dev يؤكّد بـbuild |
| **detached يخفي جلسة معلّقة فعلاً (مثلاً عالقة بانتظار tool_use بلا متلقٍّ)** | منخفض — إن كانت بلا متلقٍّ فلا أحد ليجيب الموافقة أصلاً؛ تركها تنتظر تستهلك slot لكن لا تُبقي restart عالقاً (الهدف) | grace + عدم العدّ يحلّ مشكلة الـrestart؛ تنظيف الجلسات العالقة-بلا-موافقة خارج نطاق B-80c (بند منفصل إن لزم) |
| **كسر B-23/B-41 (drain/EADDRINUSE)** | منخفض جداً | صفر تغيير في `shutdown-drain.service.ts`؛ التغيير في **قيمة** يُرجعها العدّ فقط، والعلم مطفأ افتراضياً (سلوك اليوم محفوظ) |
| **agy يبقى يسرّب شبحياً** | معروف ومقبول كدَين | نطاق B-80c = claude؛ النقل لـagy ببند منفصل (القرار 5) |

**السيناريو الأخطر محسوم:** لا يوجد في هذا التصميم أي مسار يقتل عملية claude ابنة. الورشة الطويلة، عند فقد كل مستمعيها، **تكمل عملها وتكتبه**؛ كل ما يتغيّر أنها لا تُبقي `pm2 restart` منتظراً.

---

## خطة الاختبار

> tester ينفّذها (node:test، نمط suite الموجود). **لا تُكتب مع ADR.**

### وحدة — `claude-sdk` (sweep + detach)
1. **detach بعد grace بلا مستمع:** جلسة في `activeSessions`، writer بـ`readyState=CLOSED`، `countLiveMirrors=0`؛ بعد تجاوز grace (حقن `now`/`Date.now` أو استدعاء `sweepGhostSessions` مباشرة بعد ضبط `noListenerSince`) → `session.detached===true` و`getDrainBlockingClaudeSessions()` لا تتضمنها.
2. **لا detach مع مرآة حيّة:** writer ميت لكن `countLiveMirrors=1` → `noListenerSince` يبقى null، `detached===false` حتى بعد grace.
3. **لا detach مع writer حيّ:** `isPrimarySocketAlive()===true` → لا detach.
4. **استعادة المتلقّي تصفّر العدّاد:** writer ميت دورةً (يُضبط `noListenerSince`)، ثم مرآة حيّة الدورة التالية → `noListenerSince` يُصفَّر، لا detach.
5. **العلم مطفأ = no-op:** `CLAUDE_GHOST_DETACH` غير مضبوط → `startGhostSweep` لا يبدأ، `ghostDetachEnabled()===false`، و(في index) العدّ يساوي `getActiveClaudeSDKSessions().length`.
6. **`getActiveClaudeSDKSessions()` لا يتأثر:** الجلسة detached ما زالت تظهر فيها (للعرض)، بينما `getDrainBlockingClaudeSessions()` تستثنيها.
7. **تنظيف timer:** بعد `removeSession` لآخر جلسة → `stopGhostSweep` يُستدعى (لا timer متبقٍّ).

### وحدة — `websocket-writer`
8. **`countLiveMirrors`** يقلّم الميتة ويعيد عدد الحيّة الصحيح؛ يحذف مجموعة فارغة من `sessionMirrors`.
9. **`isPrimarySocketAlive`** يعكس `readyState` بدقة (OPEN→true، غيره→false).

### تكامل — drain
10. **drain لا ينتظر شبحاً:** محاكاة `countActiveSessionsByProvider` بجلسة detached واحدة فقط → `total===0` → `shutdownNow` فوري (لا انتظار حتى deadline). (يعاد استخدام نمط `shutdown-drain.service.test.ts`.)
11. **drain ينتظر جلسة شرعية:** جلسة غير detached → الـdrain ينتظرها (السلوك الحالي محفوظ).

### دخان حيّ (المالك/devops بعد النشر، اختياري)
12. بعد تفعيل العلم: ابدأ ورشة claude، أغلق كل التبويبات، انتظر >3 دقائق، نفّذ `pm2 restart` (طرفية المالك) → يجب أن يخرج فوراً لا أن ينتظر 5 دقائق؛ وبعد عودة الجلسة (تكمل) يظهر transcript مكتمل في history.

---

## Consequences (التبعات)

**مقبولة:**
- مؤقّت دوري إضافي (`GHOST_DETACH_SWEEP_MS=30s`، `.unref()`) — حِمل ضئيل (تكرار نمط `session-process-monitor.js`).
- `getActiveClaudeSDKSessions` و`getDrainBlockingClaudeSessions` ينفصلان مفهومياً — يُوثَّق بوضوح أيهما للعرض وأيهما للـdrain.
- الجلسة detached تبقى تستهلك slot في `activeSessions` حتى تكمل طبيعياً (قد يطول للورش) — مقبول: لا تُبقي restart عالقاً (الهدف)، والذاكرة محدودة بعدد الجلسات المتزامنة.
- علم لكل مزوّد يضاعف مسار اختبار claude مؤقتاً حتى إزالة العلم.

**خارج النطاق (بند منفصل):**
- detach لـagy (نفس الثغرة، نفس الحل) — القرار 5.
- تنظيف الجلسات العالقة-بانتظار-موافقة-بلا-متلقٍّ (إن ثبت أنها مشكلة مستقلة).
- إلغاء `detached` عند عودة مرآة (تحسين غير ضروري للصحة).

**أثر صفري حتى التفعيل:** العلم `CLAUDE_GHOST_DETACH` مطفأ افتراضياً؛ عند الإطفاء العدّ بايت-بايت كالحالي (`getActiveClaudeSDKSessions().length`) والـsweep لا يبدأ.

---

## يُكمل ADR-041 ويعكس «القرار 3» فيه (بتبرير)

ADR-041 بوّب المرحلة 2 كـ**abort**-with-jsonl («القرار 3»، البديل (د) فيه). هذا الـADR **يعكسها إلى detach** بعد قراءة دورة حياة الـSDK child التي أثبتت: jsonl يُكتب من الابن (فالعمل المكتوب محفوظ في كلا المسارين)، **لكن abort يقطع بقيّة الـturn غير المكتوب بعد** — وهو فقد عمل حقيقي للورش الطويلة. detach يحقق نفس هدف إنهاء التسريب (إخراج الشبح من عدّ الـdrain) **بصفر فقد**، ويطابق فلسفة B-N-DRAIN (الأبناء يكملون)، ولا يلمس فيتو no-swap. التماس مع B-80a محكم: B-80a يُبقي الجلسة للعائدين، B-80c يُنهي عدّها فقط حين لا عائد.
