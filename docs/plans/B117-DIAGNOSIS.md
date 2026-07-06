# B-117 — تشخيص «Tool permission request failed: Stream closed»

> **البند ج من `docs/plans/FIX-PLAN-2026-07-03.md` (§5). تشخيص فقط — لا إصلاح، لا تعديل كود منتج.**
> المنفّذ: backend-dev. التاريخ: 2026-07-06. المخرج يرفع/يعدّل فيتو qa-critic على *الإصلاح*.
> الأدوات: SDK `@anthropic-ai/claude-agent-sdk@0.3.152`، ثنائية CLI المدموجة `cc_version=2.1.152` (من `x-anthropic-billing-header`).

---

## 0. الخلاصة (اقرأ أولاً)

1. **أرشيف `sdk-*.txt` لا يحوي أي توقيع عطل حقيقي — كل الظهور فخّ إيجابيات كاذبة.** `grep "Tool permission request failed"` يعطي 45 مطابقة و`"Stream closed"` يعطي 47، **لكن 100% منها إما (أ) صدى نصّ وثيقة `FIX-PLAN-2026-07-03.md` نفسها** (التي تصف العَرَض حرفياً) وهي تُكتب/تُقرأ عبر hooks فتُطبع في السجل، **أو (ب) مدخلات allowlist** تُسمّي الأداتين كأدوات مسموحة (`Adding 100 allow rule(s)`). **صفر انبعاث خطأ حقيقي.** أي تحليل سلبي ساذج يقع في هذا الفخّ ويستنتج زوراً أن التوقيع حاضر.
2. **الجلسات المؤرشفة تعمل في `permission_mode: bypassPermissions`** (مؤكَّد في سطر hook) — وهذا **يتخطّى مسار `canUseTool` بنيوياً**، فيستحيل أن تُنتج B-117 أصلاً بصرف النظر عن الصدى.
3. **إعادة الإنتاج الموجَّهة (المسار الاحتياطي الإلزامي) نُفِّذت — 4 سيناريوهات — ولم تُعِد إنتاج العطل على النسخة المنشورة حالياً.** السبب مثبت بالكود: SDK الحالي **يُبقي stdin مفتوحاً حتى يُحسم `canUseTool`** في الحالة البسيطة، فلا يقع السباق الذي وصفته الخطة.
4. **الجذر الكامن مؤكَّد حاضراً في الكود المنشور:** `endInput()` يُستدعى **بلا شرط** عند أول `result` في وضع single-turn، **دون أي حارس للأذونات المعلّقة** — أي الثغرة قائمة، والذي يمنع تفجّرها حالياً هو ترتيب رسائل CLI فحسب، لا حارس مقصود.
5. **موقع انبعاث الخطأ محسوم من ثنائية CLI (اتجاه CLI → SDK).**

---

## 1. السلسلة السببية المثبتة بالأدلة

### 1.1 موقع انبعاث السلسلة النصّية (ثنائية CLI المدموجة)
`grep -a` على `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`:

```
Yq$({behavior:"deny",message:`Tool permission request failed: ${D}`,toolUseID:z},...)
...
_id:K,request:H};if(this.inputClosed)throw Error("Stream closed");if(q?.a...
```

**التفسير:** حين تحتاج الـ CLI أن **تُرسِل** طلب إذن `can_use_tool` (control_request) إلى SDK، تفحص `this.inputClosed`. إن كانت قناتها نحو SDK مغلقة → `throw Error("Stream closed")`. هذا الخطأ `D` يُلتقط ويُلَفّ في `{behavior:"deny", message:"Tool permission request failed: Stream closed"}` فيُرفض استخدام الأداة. **الاتجاه: CLI → SDK**، والشرط: **قناة CLI↔SDK مغلقة لحظة احتياج الـ CLI طلبَ الإذن.**

### 1.2 مَن يُغلق القناة ومتى (SDK — الجذر الكامن)
`sdk.mjs` (`Query.readMessages`) عند قراءة رسالة `result`:

```js
this.firstResultReceivedResolve();
if (this.isSingleUserTurn)
  X$("[Query.readMessages] First result received for single-turn query, closing stdin"),
  this.transport.endInput();     // ← بلا أي فحص pendingToolApprovals
```

- `isSingleUserTurn=true` يُضبط لأن نسّاج يمرّر `prompt` **نصّاً** لا AsyncIterable (`server/claude-sdk.js:1452` `finalCommand`) — سلوك مطابق لإعادة الإنتاج.
- `endInput()` **غير مشروط بأي حارس للأذونات المعلّقة** ⇒ إن وصل `result` بينما طلب `can_use_tool` لم يُرسَل/يُكمَل بعد على جانب CLI، تُغلق stdin ثم يرتطم الـ CLI بـ `inputClosed` → «Stream closed».

### 1.3 الترياق القديم ميت بنيوياً (تأكيد ادعاء الخطة)
`grep -c "CLAUDE_CODE_STREAM_CLOSE_TIMEOUT" sdk.mjs` = **0**. المتغيّر الذي يضبطه نسّاج (`server/claude-sdk.js:1563` إلى `300000`) **لا يُقرأ إطلاقاً** في SDK الحالي ⇒ لا أثر له على منطق `endInput`.

---

## 2. إعادة الإنتاج الموجَّهة — 4 سيناريوهات (جلسات cwd مؤقت، بلا تلوث قائمة نسّاج)

سكربت يحاكي نداء نسّاج: `query({prompt:<نصّ>, options:{cwd:/tmp/..., permissionMode:'default', canUseTool}})` مع `canUseTool` يحاكي `waitForToolApproval({timeoutMs:0})` بتأخير يمثّل مستخدم WS بطيء. `DEBUG_CLAUDE_AGENT_SDK=1` + `CLAUDE_CODE_DEBUG_LOGS_DIR` معزول. الـ cwd من `mktemp -d` خارج مسارات المشاريع (تفادي تلوث الجلسات اليتيمة).

| # | السيناريو | التأخير | النتيجة | الدليل |
|---|-----------|---------|---------|--------|
| 1 | AskUserQuestion، `maxTurns:1` | 12s | **نظيف** — الإذن كُتب قبل الإغلاق | CLI log: `Writing to stdin: control_response subtype:success` ثم `tool_dispatch_start tool=AskUserQuestion` |
| 2 | AskUserQuestion، single-turn نقي (بلا maxTurns) | 15s | **نظيف** — `result: success` | wrapper: `First result received ... closing stdin` يقع **بعد** حسم الإذن والنتيجة |
| 3 | AskUserQuestion + **abort وسط الإذن** (محاكاة B-80 reconnect) | 20s، abort@4s | **رمى `Claude Code process aborted by user`** — **ليس** «Stream closed»؛ إغلاق CLI نظيف (SessionEnd)؛ الكتابة المتأخرة بُلعت صامتة | CLI log ينتهي بـ `SessionEnd:other ... completed status 0` |
| 4 | **ExitPlanMode** (أداة تُنهي الدور) | 15s | **نظيف** — `result: success` | نفس نمط 2: `closing stdin` بعد الحسم |

**الاستنتاج من الأدلة:** على النسخة المنشورة حالياً، SDK **يُسلسِل**: إذن → نتيجة → إغلاق stdin. في كل الحالات البسيطة (أداة تفاعلية واحدة معلّقة) يقع `endInput` **بعد** حسم الإذن، فلا يرتطم الـ CLI بـ `inputClosed`. **السباق الذي وصفته الخطة (نهاية دور طبيعية تسبق قرار الإذن) لم يقع في أيٍّ من السيناريوهات الأربعة.**

---

## 3. ما استُبعد بالدليل

- **«نهاية الدور الطبيعية تسبق قرار الإذن» (فرضية الخطة الأولى):** مُستبعدة على النسخة الحالية للأداة الواحدة المعلّقة — 3 تشغيلات نظيفة (1،2،4). SDK لا يُصدر `result` قبل حسم `canUseTool` في هذه الحالة.
- **«abort/cancel من عاصفة reconnect (B-80) يُنتج التوقيع نفسه»:** **مُستبعد جزئياً** — abort نظيف عبر `AbortController` يُنتج `Claude Code process aborted by user` (رسالة مختلفة، مسار `decision.cancelled` في `server/claude-sdk.js:1544`)، **لا** «Stream closed». أي أن الزناد لو كان B-80 فهو **قطع سوكِت غير رشيق** لا abort مُنسّق.
- **«الأرشيف يثبت العطل»:** مُستبعد — كل مطابقات الأرشيف صدى وثيقة/allowlist (§0.1)، والجلسات في `bypassPermissions` أصلاً (§0.2).

---

## 4. الفرضية الأرجح (مبنية على الأدلة)

**B-117 كما وُصف (سباق نهاية الدور) إمّا خُفِّف فعلاً في ترقية SDK/CLI الحالية، أو يتطلّب ترتيب رسائل CLI أضيق من الحالة البسيطة.** الأدلة:
- الجذر الكامن (`endInput` بلا حارس للأذونات المعلّقة) **قائم في الكود** — الثغرة حقيقية غير مُصلَحة.
- لكن ترتيب رسائل CLI الحالي (`cc 2.1.152`) لا يُطلق `result` قبل جولة الإذن للأداة الواحدة ⇒ لا تفجّر عملي في الحالة البسيطة.
- الشروط المتبقّية غير المُستبعَدة لتفجيره: **(أ)** أدوات إذن **متعدّدة/مصفوفة** بحيث يُصدر CLI `result` لإحداها بينما أخرى تنتظر؛ **(ب)** **قطع قناة CLI↔SDK غير رشيق** (سوكِت WS يسقط ⇒ تُغلق stdin) وطلب `can_use_tool` بعده — نمط B-80 لكن بقطع خام لا abort؛ **(ج)** نسخة SDK/CLI **أقدم** كانت فاعلة وقت بلاغات B-117 الأصلية ثم رُقّيت (انحسار مُصلَح ضمناً).

---

## 5. خطوة التشخيص التالية المحدّدة (لـ architect / الجولة القادمة)

1. **فحص انحسار النسخة (الأرخص، أولاً):** قارن نسخة `@anthropic-ai/claude-agent-sdk` وثنائية CLI المستخدمة وقت بلاغات B-117 الأصلية مقابل `0.3.152`/`cc 2.1.152` الحالية. إن كانت أقدم ⇒ رجّح انحساراً مُصلَحاً ضمناً؛ يبقى تصليب الحارس وقائياً لا علاجياً.
2. **رصد فعّال موجَّه (لالتقاط الظهور الحيّ التالي):** أَضِف في `server/claude-sdk.js` — عند رجوع `canUseTool` بـ`behavior:'deny'` — تسجيلاً مهيكلاً يلتقط نصّ `message` (`Tool permission request failed: *`) + `toolName` + `capturedSessionId` + حالة السوكِت. السجلّات الحالية لا تلتقط العطل لأنه إمّا لا يقع، أو يقع في جلسات permission-mode غير مُغطّاة بهذا الرصد.
3. **إعادة إنتاج المتغيّر الحاسم (قطع خام):** كرّر السيناريو مع **إسقاط سوكِت SDK↔CLI مباشرةً** (لا `AbortController`) وسط `can_use_tool` معلّق — إغلاق transport تحت الأداة لا abort مُنسّق — لتأكيد/نفي المسار (ب) من §4.
4. **تأكيد الجذر بحقن مصفوفة:** إعادة إنتاج بأداتين تفاعليتين متتاليتين/متزامنتين لاختبار ما إن كان `result` لإحداها يُغلق stdin تحت الأخرى.

---

## 6. أثر ذلك على تصميم الإصلاح (T-250 — لـ architect، ليس تنفيذاً هنا)

- **توصية architect في الخطة (الخيار 1: تأجيل `endInput` بينما `pendingToolApprovals` غير فارغة) تبقى الأصحّ وأضيق أثراً** — وهي تُعالج الجذر الكامن المؤكَّد في §1.2 مباشرةً، بصرف النظر عن أي انحسار نسخة، فتُصلّبه وقائياً.
- **لا يجوز حقن كود يدوياً في `node_modules`/`sdk.mjs`** (فيتو qa-critic — هشّ). الحارس الصحيح في طبقة نسّاج: تأجيل الإشارة التي تجعل SDK يرى «single-turn result» ما دام هناك إذن معلّق، أو تحييد الأداتين عن مسار single-turn الحيّ (الخيار 2).
- **فيتو qa-critic على الإصلاح:** يبقى قائماً حتى **التقاط ظهور حيّ واحد** عبر رصد §5.2 **أو** إعادة إنتاج المتغيّر الحاسم §5.3 — إذ لم تُثبِت هذه الجولة الزناد الفعلي على النسخة المنشورة، بل أثبتت **حضور الجذر الكامن** و**استبعاد فرضيتين** و**حسم موقع الانبعاث واتجاهه**.

---

## ملحق: أوامر/مواضع الأدلة

- أرشيف SDK: `~/.claude/debug/sdk-ff730b17-*.txt` (5.1MB, 07-06)، `sdk-4d184031-*.txt` (2MB) — كلاهما `bypassPermissions`، صفر توقيع حقيقي.
- سطر hook يثبت وضع الأرشيف: `sdk-ff730b17...:2388` → `"permission_mode":"bypassPermissions"..."tool_name":"Write"..."file_path":".../FIX-PLAN-2026-07-03.md"` (صدى الوثيقة).
- سجلّات إعادة الإنتاج (per-user debug): `~/.nassaj-users/1/.claude/debug/sdk-6a6787ee-*` (run1)، `sdk-e1abf763-*` (run2)، `sdk-7e517606-*` (run3، abort)، `sdk-0bdccfaa-*` (run4، ExitPlanMode).
- موقع الجذر: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` — `Query.readMessages` (`isSingleUserTurn ... endInput()`).
- موقع الانبعاث: `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` — `if(this.inputClosed)throw Error("Stream closed")` ← `{behavior:"deny",message:"Tool permission request failed: ${D}"}`.
- مسار نسّاج ذو الصلة (لا يُعدَّل هنا): `server/claude-sdk.js:227` (TOOLS_REQUIRING_INTERACTION)، `:1452` (finalCommand نصّ)، `:1522` (`timeoutMs: requiresInteraction ? 0 : undefined`)، `:1544` (مسار cancelled)، `:1563` (STREAM_CLOSE_TIMEOUT الميت).
