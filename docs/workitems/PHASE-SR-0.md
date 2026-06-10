# PHASE-SR-0 — Session Recovery (non-claude)

> **القرار المرجعي:** [ADR-021 — Session Survival & Replay](../decisions/021-session-survival-and-replay.md) + [ADR-022 — PM2 + SIGTERM Drain](../decisions/022-process-supervisor-pm2-sigterm-drain.md).
> **الحالة:** 🟢 **شريحة الترميز + التحصينات مكتملة، فيتو qa-critic مرفوع (202/0)**. slice الترميز مدموج (B-N5/B-N7/B-N-ATTACH، commit 1631f87)؛ تحصينات ما بعد المراجعة (B-N-DROP + B-N7-fallback + اختبار تكامل agy↔registry الحقيقي) مكتملة ومجتازة عبر commitَي 423f2b8 (backend-dev) + 42d0b46 (tester). **فيتو qa-critic مرفوع 2026-06-06** بعد إعادة المراجعة (البنود الخمسة مغلقة). العلم `SESSION_REGISTRY_agy` **مُطفأ افتراضياً**؛ **التفعيل الإنتاجي مسموح بعد بوابة B-N-DRAIN فقط** (البوابة الوحيدة المتبقية الحاجبة للتفعيل).
> **المالك:** i.rukhaimi
> **النطاق:** استرداد الجلسات + بثّ الحالة push للمزوّدين **غير-claude فقط** (agy رائداً ثم codex).
> **⚠️ تمييز:** هذا **ليس** `PHASE-0.md` (Foundation المكتمل). مرحلة مستقلة.

---

## مبادئ غير قابلة للتفاوض

- **non-claude فقط:** claude خارج النطاق (فيتو qa-critic باقٍ — B-N1/B-N6). الترتيب: **agy → codex**.
- **علم لكل مزوّد:** كل المنطق الجديد خلف `SESSION_REGISTRY_<P>` (تعايش قديم/جديد).
- **attach للقراءة فقط:** لا swap للـ writer (احترام `if(!isActive)` في `chat-websocket.service.ts:319-326`).
- **نقطة حقن RingBuffer = بثّ agy الحيّ** `safeSend(stream_delta)` في `server/agy-cli.js:461` — **لا** `normalizeMessage` (طبقة ميتة تُرجع `[]`).
- **بوابة اختبارات قبل الدمج** + **بوابة نشر** (B-N-DRAIN حدّ أدنى) قبل أول `pm2 restart` يحمل الـ slice.

---

## Work Items

### B-N5 — connectionId مؤقت ثم rekey لـ sessionId  ✅ مكتمل (فيتو مرفوع، commit 1631f87)

- **الوصف:** عند بدء جلسة قبل توفّر `sessionId` الحقيقي (التقاط متأخّر معروف في كل مزوّد)، يُسجَّل buffer/حالة الجلسة تحت **`connectionId` مؤقت**، ثم **rekey** إلى `sessionId` فور وصوله — دون فقدان الرسائل المُلتقَطة قبل المعرّف.
- **معيار القبول:** رسالة مبثوثة قبل توفّر `sessionId` تظهر في الـ replay بعد الـ rekey (لا تُفقد ولا تُكرَّر). rekey إلى sessionId قائم لا يخلط جلستين.
- **الملفات المتأثّرة:** `server/agy-cli.js` (نقطة البثّ ~461 + التقاط sessionId)، طبقة `SessionRegistry` الجديدة، `server/modules/websocket/services/chat-websocket.service.ts`.
- **التبعيات:** لا شيء (أساس الـ slice). يسبق B-N7 وB-N-ATTACH.

---

### B-N7 — توحيد مصدر حالة active  ✅ مكتمل (فيتو مرفوع، commit 1631f87؛ إتمام fallback في 423f2b8)

- **الوصف:** توحيد **مصدر الحقيقة الوحيد** لحالة «الجلسة نشطة/processing» الذي يقرأه `attach`/`drain` لاحقاً. اليوم تتعدّد دوال `is<Provider>SessionActive` لكل مزوّد (راجع `chat-websocket.service.ts:303-335`)؛ يلزم seam واحد لـ non-claude يستهلكه attach وdrain معاً.
- **معيار القبول:** `attach` وdrain يقرآن الحالة من **مصدر واحد**؛ تغيير الحالة (start/end) ينعكس فوراً في كليهما. لا تباعد بين ما يراه `check-session-status` وما يراه drain.
- **الملفات المتأثّرة:** `server/modules/websocket/services/chat-websocket.service.ts:303-335`، `server/agy-cli.js` (`activeSessions` map ~420)، طبقة `SessionRegistry`.
- **التبعيات:** B-N5. يسبق B-N-ATTACH وB-N-DRAIN.

---

### B-N-ATTACH — attach للقراءة فقط (replay تفاضلي)  ✅ مكتمل (فيتو مرفوع، commit 1631f87)

- **الوصف:** `attach` للقراءة فقط يعيد بثّ الرسائل المفقودة (**replay تفاضلي: `seq > lastSeq`**) من per-session RingBuffer، **فوق البدائيّتين القائمتين** دون استبدالهما:
  - `reconnectSessionWriter` في `server/claude-sdk.js:1181`
  - `check-session-status` في `server/modules/websocket/services/chat-websocket.service.ts:303-335`
- **قيد صريح:** **دون swap الـ writer** — يُحترم `if(!isActive)` في `chat-websocket.service.ts:319-326`. attach يقرأ الـ buffer ويُعيد البثّ للسوكت الجديد فقط؛ لا يلمس الـ writer النشط للجلسة الجارية.
- **معيار القبول:** عميل يعيد الاتصال أثناء جلسة agy نشطة يستلم فقط الرسائل ذات `seq > lastSeq` (لا تكرار، لا فجوة)؛ والـ writer الأصلي يبقى دون تبديل؛ ولا يحدث abort في الجلسة الجارية.
- **الملفات المتأثّرة:** `server/agy-cli.js` (نقطة الحقن ~461)، طبقة `SessionRegistry`/`RingBuffer`، `chat-websocket.service.ts`.
- **التبعيات:** B-N5 + B-N7.

---

### B-N-DRAIN — drain موقوت (حدّ أدنى من B-N2)  🟢 منفَّذ ومُفعَّل (2026-06-09) — يتبقى التحقق الميداني فقط

> **إغلاق التفعيل 2026-06-09:** `treekill: false` + `kill_timeout: 86400000` أُضيفا إلى `ecosystem.config.cjs` وتأكد سريانهما في PM2 الحيّ (`pm2 jlist`: treekill=False, kill_timeout=86400000)، والبناء الحامل للـdrain محمَّل. **بهذا تُرفع بوابة التفعيل الإنتاجي لـ`SESSION_REGISTRY_agy`** (قرار تفعيل العلم منفصل). المتبقي: التحقق الميداني (دور حيّ + restart + مراقبة سطور `[DRAIN]`)، وقبل تفعيل العلم: حسم قراءة drain لخريطة agy القديمة بدل الـregistry (ملاحظة qa-critic رقم 5).

> **تحديث تنفيذ 2026-06-09:** استُبدل `process.exit(0)` الفوري في `server/index.js` بـdrain موقوت على SIGTERM **وSIGINT معاً** (إشارة الإيقاف الافتراضية لدى PM2 في fork هي SIGINT): انتظار الجلسات النشطة عبر دوال `getActive*Sessions` للمزوّدين الستة (claude ضمن العدّ — drain الانتظار لا يمسّ نطاق replay non-claude)، والانتظار **بلا سقف افتراضياً** (`DRAIN_TIMEOUT_MS=0`؛ قرار المستخدم 2026-06-09: أدوار العمل قد تمتد ساعة فأكثر — يمكن فرض سقف بضبط المتغير لقيمة >0)، وإشارة ثانية = خروج فوري. **المتبقي لإغلاق البند (مراجعة qa-critic 2026-06-09):** في `ecosystem.config.cjs` لتطبيق nassaj-dev: **`treekill: false`** (حاجب — الافتراضي true يجعل PM2 يرسل الإشارة للأبناء أولاً فيقتل الوكلاء قبل أن يبدأ drain أصلاً؛ ثغرة كانت غائبة عن ADR-022 وهذا البند) + **`kill_timeout: 86400000`** (24h — يجب أن يفوق أطول دور متوقع لأن drain بلا سقف) + التحقق الميداني لأول restart مع جلسة نشطة (معيار القبول أدناه). ملاحظات qa-critic غير الحاجبة مدوَّنة في تقريره: لا حجب لأدوار جديدة أثناء drain، موافقات معلّقة تحجز الانتظار، جلسات PTY خارج العدّ، drain يقرأ خريطة agy القديمة لا الـregistry (خرق B-N7 يلزم حسمه قبل تفعيل العلم)، نافذة عمياء لجلسات claude قبل أول رسالة SDK.

- **الوصف:** استبدال `process.exit(0)` الفوري في `server/index.js:1789` بـ **drain موقوت مُحفَّز بـ SIGTERM** + `kill_timeout` في PM2 (ADR-022). المعالج الحالي يخرج فوراً بلا انتظار الجلسات النشطة:
  ```js
  const shutdownPlugins = async () => { await stopAllPlugins(); process.exit(0); };
  process.on('SIGTERM', () => void shutdownPlugins());
  ```
- **معيار القبول:** عند SIGTERM، تُمهَل الجلسات النشطة فترة drain موقوتة قبل الخروج (لا قتل فوري)؛ تجاوز `kill_timeout` يقود إلى SIGKILL من PM2. أول `pm2 restart` يحمل الـ slice لا يقتل جلسة agy نشطة قتلاً صلباً ضمن نافذة الـ drain.
- **الملفات المتأثّرة:** `server/index.js:1789-1794`. **`ecosystem.config.cjs` لا يُعدَّل في بوابة التوثيق** — ضبط `kill_timeout` يجري ضمن تنفيذ هذا البند (جلسة متوازية محتملة على الملف).
- **التبعيات:** B-N7 (مصدر حالة active موحَّد ليعرف drain أي جلسات نشطة). **بوابة نشر:** قبل أول نشر يلزم هذا البند أو نشر يدوي في نافذة بلا جلسات نشطة من instance منفصل.

---

### B-N-DROP — دورة حياة الـ RingBuffer (طرد + resume)  ✅ مكتمل (فيتو مرفوع، commit 423f2b8)

> **توحيد ما بعد المراجعة (architect + qa-critic، 2026-06-06):** B-N-EVICT وB-N-RESUME صارا **حالتين من جذر واحد** هو دورة حياة البفر، فدُمجا تحت **B-N-DROP**. القرار المرجعي: قسم Amendment في [ADR-021](../decisions/021-session-survival-and-replay.md#amendment--تحصينات-ما-بعد-المراجعة-2026-06-06).

- **القيم المُعرَّفة:**

  | المعامل | القيمة | السلوك |
  |---|---|---|
  | `BUFFER_RETENTION_MS` | `120000` | **drop مؤجَّل** عند `close`/`error` عبر `setTimeout(...).unref()` — لا فوري. |
  | `MAX_LIVE_SESSIONS` | `200` | سقف بطرد **LRU للإدخالات غير النشطة فقط** — لا طرد لنشطة. |
  | `RING_CAPACITY` | `2000` | كما هو. |

- **الحالة (أ) — الطرد (كانت B-N-EVICT):** `SessionRegistry.drop()` لا يُستدعى حالياً → خريطة `entries` تنمو بلا حدّ عبر الجلسات المتمايزة (محدودة لكل-جلسة بـ2000، غير محدودة في العدد). تعليق `server/agy-cli.js:524-526` «reclaimed on the next run» **غير صحيح**. **الإصلاح:** drop مؤجَّل بـ `BUFFER_RETENTION_MS` + سقف `MAX_LIVE_SESSIONS` بطرد LRU لغير النشطة فقط.
- **الحالة (ب) — resume/clean-buffer (كانت B-N-RESUME):** spawn لـ`sessionId` منتهٍ يفعل **`drop` ثم `open`** (بفر نظيف) → البفر **لا يَعبُر حدّ تشغيل جديد**. عقد `lastSeq`: غياب/غير رقمي → `0` = إعادة بثّ **التشغيل الحالي فقط** (لا ترانسكربت سابق). يُحسَم بذلك سؤال resume لصالح **مسح البفر عند بدء تشغيل جديد**.
- **معيار القبول:** (أ) لا نمو غير محدود لـ`entries` تحت تشغيل طويل؛ مؤقّت الـ drop `.unref()` لا يعيق الخروج؛ لا طرد لجلسة نشطة. (ب) `lastSeq=0` على sessionId أُعيد تشغيله لا يستلم ترانسكربت التشغيل السابق — فقط بثّ التشغيل الجاري.
- **الملفات المتأثّرة:** طبقة `SessionRegistry`/`RingBuffer`، `server/agy-cli.js:524-526` (تصحيح التعليق + ربط `drop` + مسار drop-then-open عند resume).
- **التبعيات:** B-N5 (rekey) + B-N-ATTACH (replay التفاضلي). **بوابة نشر حرجة:** يلزم قبل تفعيل `SESSION_REGISTRY_agy` إنتاجياً.

---

### B-N7 (إتمام) — إسقاط الـ fallback عند تفعيل العلم  ✅ مكتمل (فيتو مرفوع، commit 423f2b8)

- **الوصف:** عند **تفعيل العلم** يُسقَط fallback `|| activeSessions.has()` في `isAntigravitySessionActive` → «المصدر الوحيد» (B-N7) يُحقَّق حرفياً وتبسيط مسار drain. السلوك القديم (الـ fallback) يبقى **عند إطفاء العلم فقط**.
- **حذف فرع rekey-onto-existing:** فرع rekey إلى sessionId قائم صار **كوداً ميتاً** بعد قرار RESUME clean-buffer → **يُحذف ويُستبدل بـ `throw` صريح**.
- **التبعيات:** B-N-DROP (قرار clean-buffer هو ما يقتل فرع rekey-onto-existing).

---

### B-N-PORT — استخراج `ProviderSessionPort` [بوابة قبل codex — مؤجَّل]

- **الوصف:** تجريد **نقطة الحقن** (stdout/PID لـ `agy` مقابل SDK لـ `codex`) في seam واحد `ProviderSessionPort`. **مؤجَّل عمداً** — لا يُستخرَج تجريد مزوّد واحد قبل وجود المزوّد الثاني (codex).
- **بوابة:** **شرط مسبق إلزامي لأي عمل codex** — يمنع نسخ فرع antigravity **مرة رابعة عبر 3 ملفات**. لا يُبدأ أي slice codex قبل اجتياز B-N-PORT.
- **الملفات المتأثّرة:** طبقة `SessionRegistry`، نقطة الحقن في `server/agy-cli.js`، seam مزوّد جديد.
- **التبعيات:** Phase SR-0 (agy) مكتمل ومُفعَّل. **حالة:** backlog (لا يُنفَّذ في هذه الجولة).

---

### بوابة اختبارات (Test Gate — قبل الدمج)

اختبارات إلزامية قبل دمج أي slice:

| الاختبار | يغطّي |
|---|---|
| **B-N5 rekey** | رسالة قبل sessionId تُحفظ تحت connectionId ثم تنتقل للـ replay بعد rekey (لا فقد/تكرار). |
| **B-N7 single source** | attach وdrain يقرآن نفس مصدر حالة active؛ start/end ينعكس في كليهما. |
| **attach-replay التفاضلي** | إعادة اتصال تستلم فقط `seq > lastSeq`؛ لا تكرار، لا فجوة، لا swap للـ writer، لا abort. |
| **✅ اختبار التكامل agy↔registry الحقيقي** | تكامل فعلي بين spawn agy والـ `SessionRegistry` (لا mock) — التقاط البثّ الحيّ، rekey، drop-then-open عند resume. كان شرط فيتو؛ **منفَّذ ومجتاز (commit 42d0b46)؛ الفيتو مرفوع**. |

**قاعدة عدم الانحدار:** لا اختبار قائم ينتقل من ناجح → فاشل (متسق مع gate مزامنة upstream).

---

## ترتيب التنفيذ

```
B-N5 (connectionId → rekey)
   ↓
B-N7 (توحيد مصدر حالة active)
   ↓
B-N-ATTACH (replay تفاضلي، قراءة فقط)  ──►  بوابة اختبارات  ──►  ✅ دمج (خلف SESSION_REGISTRY_agy، 1631f87)
   ↓
─── تحصينات ما بعد المراجعة (2026-06-06) ✅ مكتملة، فيتو مرفوع ───
B-N-DROP   ✅ (دورة حياة البفر: drop مؤجَّل + LRU + clean-buffer عند resume) — 423f2b8
B-N7-fb    ✅ (إسقاط fallback + حذف rekey-onto-existing → throw) — 423f2b8
اختبار التكامل agy↔registry الحقيقي ✅ — 42d0b46
   ↓
إعادة مراجعة qa-critic ✅ الفيتو مرفوع (202/0، 2026-06-06)
   ↓
B-N-DRAIN  🟠 (drain موقوت + kill_timeout) — البوابة الوحيدة الحاجبة للتفعيل
   ↓
تفعيل العلم SESSION_REGISTRY_agy + أول pm2 restart آمن
   ↓
B-N-PORT (استخراج ProviderSessionPort) [بوابة إلزامية قبل codex]
   ↓
تكرار المسار لـ codex خلف SESSION_REGISTRY_codex
```

---

## بوابة نشر مقابل تسجيل (محدَّثة 2026-06-06)

| المرحلة | البنود |
|---|---|
| **✅ مكتمل + فيتو مرفوع (202/0)** | B-N5 + B-N7 + B-N-ATTACH (1631f87) + **B-N-DROP** + **B-N-RESUME** (clean-buffer، ضمن DROP) + **B-N7 fallback** (423f2b8) + **اختبار التكامل agy↔registry الحقيقي** (42d0b46). **فيتو qa-critic مرفوع 2026-06-06.** |
| **🟠 البوابة الوحيدة الحاجبة للتفعيل** | **B-N-DRAIN** (drain موقوت + `kill_timeout`). بعدها يُسمح تفعيل `SESSION_REGISTRY_agy` إنتاجياً. |
| **🗂️ backlog (بعد التفعيل)** | **B-N-PORT** (استخراج `ProviderSessionPort`) — بوابة إلزامية قبل codex — ثم مسار **codex**. |
| **🗒️ تحسينات غير حاجبة (backlog)** | (1) تسرّب مؤقّت drop ثانوي عند طرد `_enforceCap`؛ (2) فرع rekey المملوء ميت إنتاجياً. (التفصيل أدناه.) |

---

## تحسينات غير حاجبة (Backlog — مرصودة في إعادة مراجعة qa-critic 2026-06-06)

بندان [تحسين] **لا يحجبان** التفعيل الإنتاجي (لم يمنعا رفع الفيتو):

1. **تسرّب مؤقّت drop ثانوي عند `_enforceCap`:** طرد LRU لإدخال **غير نشط** عبر `_enforceCap` قد يترك مؤقّت الـ drop المؤجَّل قائماً (سقفه ≤200 مؤقّت، كلٌّ `.unref` وذاتي التنظيف فلا يعيق الخروج ولا يُراكم بلا حدّ). **التحسين:** ربط طرد السجل بإلغاء المؤقّت المرتبط صراحةً.
2. **فرع rekey المملوء ميت إنتاجياً:** بعد قرار RESUME clean-buffer صار فرع rekey-onto-existing غير قابل للوصول إنتاجياً؛ يبقى **حارساً دفاعياً مقبولاً** (`throw` يكشف الحالة المستحيلة). لا إجراء مطلوب — مرصود للتوثيق فقط.

---

## خارج النطاق (فيتو qa-critic باقٍ — لا يُنفَّذ هنا)

- **claude:** B-N1 (رفع `if(!isActive)` — قد يُعيد regression `56d67f3`) + B-N6.
- **drain-lock الكامل:** B-N3/B-N4 (drain لا يكتمل مع `timeoutMs:0` وjobs الساعات؛ سباق drained↔restart).
