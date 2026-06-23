# ADR-041 — Claude Live-Stream Replay على reconnect (إصلاح B-80)

> **سجلّ قرار معماري (ADR).** الصيغة: Context → Alternatives → Decision → Consequences → Status.
> الكود في `/home/nassaj/Project/nassaj-dev`. يمدّ ADR-021 إلى مزوّد claude بمسار **replay-only** لا يكسر فيتو no-swap.

| الحقل | القيمة |
|---|---|
| **Status** | 🟡 **Proposed** — تصميم جاهز للتنفيذ من backend-dev، بانتظار اعتماد المالك + بوابة qa-critic. |
| **التاريخ** | 2026-06-22 |
| **المالك** | i.rukhaimi |
| **يمدّ** | ADR-021 (Session Survival & Replay) — يفعّل ما كان «خارج النطاق: مسار claude» منه، **حصراً عبر replay-only** دون لمس البندين المحجوبين B-N1/B-N6. |
| **يعالج** | B-80 (تجمّد الواجهة عند انقطاع WS أثناء بثّ claude حيّ) + الأثر الجانبي: تسريب جلسات شبحية active. |

---

## Context (السياق)

عند انقطاع WebSocket أثناء بثّ جلسة claude حيّة (خصوصاً الورش الطويلة):

1. البثّ يجري عبر `WebSocketWriter.send` الذي يمسك `this.ws` (السوكِت الخام). عند موت السوكِت يصير `send` **no-op صامتاً** (حارس `readyState===WS_OPEN_STATE` في `websocket-writer.service.ts:99`) بينما حلقة `for await (const message of queryInstance)` في `claude-sdk.js:1250` **تستمر** تستهلك مخرَج الـSDK وترميه. **لا abort للـSDK عند موت السوكِت.**
2. عند reconnect، فرع claude في `check-session-status` يرى الجري `isActive===true` فيمنع **عمداً** `reconnectSessionWriter` (حارس `if(!isActive)` في `chat-websocket.service.ts:480`؛ تبديل الـwriter وسط tool_use يفسد تزامن الـSDK = regression `56d67f3`). السوكِت الجديد يُسجَّل **mirror قراءة-فقط** يستقبل المُبثّ **مستقبلاً فقط** عبر fan-out في `WebSocketWriter.send`.
3. ما بُثّ **بين موت السوكِت وتسجيل المرآة يُفقَد**؛ وإن توقّف الجري عند انتظار نتيجة tool_use تبقى الواجهة مجمّدة حتى تحديث يدوي. **لا آلية replay تفاضلية لـclaude** — موجودة لـagy فقط (`attachAntigravitySession` خلف علم `SESSION_REGISTRY_agy`، مُثبتة ومُختبَرة `chat-websocket.attach.test.ts`).

**الأثر الجانبي (مؤكَّد بسجل restart 11:12→11:15):** جلسة بقيت `active` تكتب على القرص رغم ظهورها متوقّفة بالواجهة (orphaned). عدم إجهاض الـstream عند موت آخر مستمع يُبقي الجلسة active أبداً = تسريب جلسات شبحية يُبطئ كل `pm2 restart` بـ`kill_timeout=5min`.

**القيد الحاكم من ADR-021:** فيتو qa-critic أبقى **مسار claude خارج النطاق** بسبب:
- **B-N1** — رفع `if(!isActive)` لتفعيل writer-swap لـclaude (يُعيد regression `56d67f3`).
- **B-N6** — تمرير المسار الحرج (الموافقات/complete) خلف flag واحد.

كلا البندين يخصّان **writer-swap** و**تمرير المسار الحرج خلف العلم**. مسار **replay-only** (إعادة بثّ نسخة قراءة-فقط من بفر، بلا swap وبلا abort وبلا اعتماد العلم على المسار الحرج) **لا يلمس أياً منهما** — وهو بالضبط ما رفع qa-critic الفيتو عنه لـagy (B-N-ATTACH).

---

## Alternatives (البدائل المدروسة)

| البديل | سبب القبول/الرفض |
|---|---|
| **(أ) Writer-swap لـclaude عند reconnect** (رفع `if(!isActive)`) | **مرفوض** — يكسر فيتو B-N1، يُعيد regression `56d67f3` (تبديل writer وسط tool_use يفسد تزامن SDK → «user doesn't want to proceed»). |
| **(ب) Replay تفاضلي قراءة-فقط (seq>lastSeq) بلا swap** (مطابق B-N-ATTACH لـagy) | **مقبول ومُختار** — يحترم الفيتو حرفياً (لا swap، لا abort، لا تمرير مسار حرج خلف العلم: الـwriter الأساسي يبقى مالك المسار الحرج، الـreplay مجرّد إعادة بثّ للمرآة). نمط مُثبَت ومُختبَر لـagy. |
| **(ج) إجهاض SDK فوراً عند موت السوكِت** | **مرفوض** — يقتل عمل الورشة الطويلة عند انقطاع شبكي عابر (Cloudflare idle/keepalive)؛ الانقطاع ليس نية إيقاف. |
| **(د) إجهاض SDK عند انعدام كل مستمع حيّ بعد grace-period، مع إبقاء كتابة jsonl** | **مقبول كنطاق منفصل (المرحلة 2)** — يعالج التسريب دون فقد عمل الورشة (الـjsonl يُكتب من SDK داخلياً، لا يعتمد على السوكِت). يُفصل عن إصلاح التجمّد لتقليل المخاطرة. |

---

## Decision (القرار)

### القرار 1 — replay تفاضلي قراءة-فقط لـclaude (المرحلة 1، إصلاح التجمّد)

تُنشأ **per-session RingBuffer لكل جلسة claude نشطة** عبر **مثيل `SessionRegistry` ثانٍ** (إعادة استخدام `server/session-registry.js` كما هو، بلا تعديل) خلف علم **`SESSION_REGISTRY_claude`**:

- **نقطة الحقن:** كل استدعاء `ws.send(...)` داخل حلقة البثّ في `claude-sdk.js` يُسبَق بـ`claudeSessionRegistry.record(sessionId, payload)` — **بثّ حيّ، لا `normalizeMessage`** (نفس درس ADR-021 §«ثلاثة تصحيحات»).
- **دورة الحياة:** `open` عند أول `addSession`/التقاط sessionId؛ `setActive(false)` + `scheduleBufferDrop` (نافذة `BUFFER_RETENTION_MS=120s`) عند complete/error؛ clean-buffer (drop+open) عند resume لـsessionId سابق منتهٍ — مطابق agy حرفياً.
- **reconnect:** فرع claude في `check-session-status` يستدعي `attachClaudeSDKSession(sessionId, lastSeq, send)` **قبل** فحص `isActive`/الفيتو، يعيد بثّ `seq>lastSeq` إلى السوكِت الجديد عبر `writer.send`. **`if(!isActive)` يبقى كما هو**؛ لا swap لـclaude النشط أبداً.
- **العلم مُطفأ افتراضياً** (تعايش قديم/جديد): عند الإطفاء كل دوال السجلّ no-op والسلوك بايت-بايت كالحالي.

### القرار 2 — عقد `lastSeq` على العميل + dedup بثّ deltas

- **الخادم** يُرفق `sequence` (الـseq من RingBuffer) على كل payload مبثوث **عند تفعيل العلم فقط** (الحقل `sequence?` موجود أصلاً في `NormalizedMessage`).
- **العميل** يتتبّع أعلى `sequence` رآه لكل جلسة، ويرسله `lastSeq` في `check-session-status`. (حالياً لا يُرسله — `useChatSessionState.ts:499`.)
- **الحرج (منع الازدواج):** مسار `stream_delta` على العرض النشط يراكم نصّاً خاماً في `accumulatedStreamRef` **بلا dedup** (`useChatRealtimeHandlers.ts:260`). الـreplay التفاضلي (`seq>lastSeq`) هو ما يمنع تكرار النص: ما رآه العميل (`lastSeq`) لا يُعاد. غياب `lastSeq` (علم مُطفأ أو عميل قديم) → `0` → إعادة بثّ التشغيل الحالي كاملاً (مقبول للـmirror/التحديث اليدوي، لكن **يُكرّر نصّاً على عرض نشط راكم deltas** — لذا إرسال `lastSeq` من العميل **شرط** لتفعيل العلم).

### القرار 3 — معالجة التسريب (المرحلة 2، منفصلة)

إجهاض SDK query **فقط** عند: انعدام كل مستمع حيّ (الـwriter الأساسي ميت **و**لا مرايا حيّة) **بعد grace-period** (مثل `BUFFER_RETENTION_MS`)، مع **الإبقاء على كتابة jsonl** (يكتبها SDK داخلياً، مستقلّة عن السوكِت). تُفصل لتقليل المخاطرة على الورش الطويلة وتُبوَّب ببوابة اختبار مستقلة.

### فيتو no-swap

**يُحترم صرفاً.** لا رفع لـ`if(!isActive)`؛ لا تبديل writer لـclaude النشط؛ الـreplay قراءة-فقط لا يطعم إدخالاً في الجري. البديل (أ) مرفوض صراحةً.

---

## Consequences (التبعات)

**مقبولة:**
- مثيل `SessionRegistry` ثانٍ لـclaude = ذاكرة إضافية محدودة (`RING_CAPACITY=2000` payload/جلسة، `MAX_LIVE_SESSIONS=200`). بفر claude قد يكون أكبر من agy (tool_use/tool_result أثقل من نصّ) — يُراقَب، وقد تُخفَّض السعة لـclaude.
- العلم لكل مزوّد يضاعف مسار اختبار claude مؤقتاً حتى إزالة العلم.
- المرحلة 1 وحدها **لا** تُنهي التسريب الشبحي؛ تُنهي **التجمّد** فقط. التسريب يبقى حتى المرحلة 2 (الورشة تكمل وتكتب jsonl، لكن الجلسة تبقى active حتى انتهاء الجري طبيعياً).

**خارج النطاق (مرحلة لاحقة):**
- إجهاض الجلسات الشبحية (القرار 3) — منفصل ببوابته.
- أي writer-swap لـclaude — يبقى محجوباً بفيتو ADR-021 B-N1.

---

## يمدّ ADR-021 (لا يناقضه)

ADR-021 أبقى «مسار claude بالكامل» خارج النطاق، لكن **بسبب B-N1 (writer-swap) وB-N6 (مسار حرج خلف علم)**. هذا الـADR **لا يفعّل أياً منهما**: الـreplay قراءة-فقط لا يبدّل writer (B-N1 سليم) ولا يمرّر المسار الحرج خلف العلم (الـwriter الأساسي يبقى مالكه؛ العلم يحكم إعادة البثّ للمرآة فقط — B-N6 سليم). إذن النطاق المُضاف هنا = **بالضبط** ما رُفع الفيتو عنه لـagy (B-N-ATTACH)، مطبَّقاً على claude بنفس البنية.
