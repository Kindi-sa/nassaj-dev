# تقييم جاهزية PM2 Cluster-Mode — nassaj-dev

**التاريخ:** 2026-06-12
**المؤلف:** architect
**مرتبط بـ:** ADR-028 · B-35 · B-24 · ADR-021

---

## الهدف

هذه الوثيقة تُقيِّم جاهزية الانتقال من `exec_mode: 'fork'` (نسخة واحدة) إلى `exec_mode: 'cluster'` في PM2 كحلٍّ جذري لعاصفة EADDRINUSE المتكررة، مع الأخذ في الحسبان الافتراضات المعمارية القائمة. لا تُنفِّذ أي تغيير تشغيلي.

---

## 1. هل WAL المُضاف كافٍ لتزامن نسختين على SQLite؟

### الحالة الفعلية

`server/modules/database/connection.ts` (السطران 153–154) يُفعِّل:

```
instance.pragma('journal_mode = WAL');
instance.pragma('busy_timeout = 5000');
```

هذا يعني أن WAL وbusy_timeout **مُفعَّلان بالفعل** في الكود الحالي — وليس مطلباً مسبقاً لـ cluster-mode كما أشار ADR-028 مشيراً إلى غيابهما، بل أُضيفا ضمن إصلاح B-38 في S-2.

### ما يُعالجه WAL

- قارئون متزامنون بلا حجب بين بعضهم.
- كاتب واحد بلا حجب للقارئين.
- `busy_timeout = 5000ms` يُحاول إعادة المحاولة عند تنافس الكتاب.

### ما لا يُعالجه WAL في سياق cluster-mode

| السيناريو | الوضع |
|---|---|
| نسختان تُنشئان جلسة جديدة في نفس الوقت (`createSession` غير ذرّية — 5.1 من تقرير المسح) | خطر تعارض. WAL يُقلِّل الاحتمال لكن لا يُلغيه بلا `db.transaction()`. |
| نسخة تصفّي (drain) تُعدِّل صفوف الجلسات بينما النسخة الجديدة تقرأها | آمن مع WAL — القراءة لا تنتظر الكتابة. |
| نافذة تداخل drain: الكتابة على صف مشترك (مثل تحديث حالة الجلسة) | WAL + busy_timeout يكفيان لمعظم الحالات؛ الحالة النادرة (كتابتان متزامنتان) تُصحَّح بـ `db.transaction()`. |
| ملف DB واحد مشترك بين نسختين | SQLite WAL مُصمَّم لهذا السيناريو — صحيح. |

### الحكم

WAL المُفعَّل حالياً **كافٍ** للتعايش بين نسختين خلال نافذة drain، مع استثناء `createSession` غير الذرّية (B-38 من تقرير المسح — مطلوب تغليفها بـ transaction بصرف النظر عن cluster-mode). لا يُشترط الانتقال لخادم DB مستقل لمجرد cluster-mode مع نسخة واحدة.

---

## 2. افتراضات fork-mode التي يكسرها cluster-mode

### أ. ملكية جلسات PTY

**الافتراض الحالي:** كل جلسة PTY (`/shell`) وكل جلسة `agy`/`claude`/`codex` مُنشَأة في عملية `nassaj-dev` الواحدة. مقبض العملية الابن (`agProcess` في `agy-cli.js:400`) والـ SDK الذي يملك `claude/codex` محجوزان داخل نفس عملية Node.

**ما يحدث في cluster-mode:** كل worker عملية مستقلة. جلسة تُنشأ في worker A تعيش فيه حصراً. Worker B لا يملك مقابضها وأعداد `activeSessions` فيه تعكس جلساته فقط.

**الأثر:** طالما النسخة `instances: 1`، يوجد worker واحد في أي وقت (القديم يُصفَّى، الجديد يُشغَّل). المشكلة تنشأ **فقط خلال نافذة overlap** عند `pm2 reload`: القديم والجديد يعملان معاً. الجلسات المفتوحة تبقى ملكاً للقديم وتُكمل drain فيه، والجديد يستقبل اتصالات جديدة فقط. هذا التوزيع **هو بالضبط ما تحتاجه** منظومة drain — ليس كسراً.

**الشرط:** يجب أن يحترم PM2 `treekill: false` عند قتل workers أيضاً (لا فقط في fork-mode). هذا مطلب التحقق رقم 3 في ADR-028.

### ب. توجيه WebSocket ولصاقة الجلسات (Sticky Sessions)

**الافتراض الحالي:** كل WebSocket يصل نفس العملية حيث تعيش الجلسة. `sessionMirrors` و`WebSocketWriter` كلاهما Maps محلية في الذاكرة — لا قناة بين عمليات.

**ما يحدث في cluster-mode مع instances > 1:** master يُوزِّع الاتصالات الجديدة بين workers. اتصال WebSocket لمشاهدة جلسة مفتوحة في worker A قد يصل worker B الذي لا يملكها. `sessionMirrors.get(sessionId)` تُعيد `undefined` في worker B → صمت تام.

**ما يحدث مع `instances: 1`:** worker واحد فقط، لا توزيع، لا مشكلة توجيه. هذا القيد **يلغي خطر sticky sessions كلياً** طالما النسخة مقيَّدة بـ 1.

**الخطر الكامن:** رفع `instances` مستقبلاً إلى 2+ يُحيي هذه المشكلة فوراً. أي تغيير مستقبلي لـ instances يستلزم مراجعة معمارية كاملة لطبقة WebSocket والـ in-memory state.

### ج. drain لكل worker

**الافتراض الحالي:** drain مُنفَّذ في `shutdown-drain.service.ts` يستمع لـ SIGINT/SIGTERM، يُحرِّر المنفذ فوراً، ويُغلق اتصالات WebSocket، ثم ينتظر `activeSessions` حتى تصفر. هذا المنطق مناسب لعملية واحدة.

**في cluster-mode:** عند `pm2 reload`، PM2 يُرسل `shutdown` event للـ worker القديم (لا SIGTERM مباشرة في المرحلة الأولى). الـ drain يجب أن يُحرِّر المنفذ — لكن في cluster-mode الـ master يملك socket الاستماع، **لا الـ worker**. استدعاء `server.close()` في الـ worker يُوقف توجيه اتصالات جديدة إليه من master، لكنه لا يُحرِّر المنفذ 3004 (Master لا يزال يملكه).

**الأثر:** منطق B-23 (تحرير المنفذ الفوري لمنع EADDRINUSE) **لا ينطبق في cluster-mode** لأن EADDRINUSE مستحيل أصلاً — Master يملك المنفذ طوال الوقت. هذا يُبسِّط الأمور: `server.close()` في الـ worker تعني «لا تُرسل اتصالات جديدة لهذا الـ worker» وهو الهدف الصحيح.

### د. `process.send('ready')` ومتطلب `wait_ready`

**الافتراض الحالي:** لا يوجد استدعاء `process.send('ready')` في كود الخادم. PM2 يفترض الجاهزية بمجرد بدء العملية.

**في cluster-mode مع `wait_ready: true`:** Master ينتظر `process.send('ready')` قبل توجيه أي طلب للـ worker الجديد. بدونه مع `wait_ready: true`: PM2 قد يعتبر الـ worker فاشلاً. أو بدون `wait_ready` يُرسل طلبات للـ worker قبل جاهزيته.

**الحل:** إضافة `process.send?.('ready')` بعد `server.listen` callback مع علم `CLUSTER_WAIT_READY`. هذا التعديل في `server/index.js` ضروري للـ cluster-mode الآمن.

### هـ. `cluster-entry.cjs` لمعالجة ESM

**الافتراض الحالي:** `package.json` يحوي `"type": "module"`. PM2 cluster يُحمِّل script بـ `require()` (CJS).

**الأثر:** `dist-server/server/index.js` كوحدة ESM لا تقبل `require()` — سيفشل الإقلاع فوراً.

**الحل:** shim إقلاع CJS صغير (`dist-server/cluster-entry.cjs`) ينفّذ:
```js
import('./server/index.js').catch(e => { console.error(e); process.exit(1); });
```
هذا الملف هو نقطة دخول cluster-mode ولا يمس منطق الخادم.

---

## 3. البدائل الأقل جذرية لكسر دورة العاصفة

### المرحلة 0 من ADR-028: معالجة exit(0) كموت متوقَّع

**الفكرة:** تدريب PM2 على أن خروج النسخة القديمة بعد drain ليس موتاً يستوجب respawn. يتحقق ذلك بإحدى طريقتين:

**الطريقة الأولى — `stop_exit_codes`:** إضافة `stop_exit_codes: [0]` في `ecosystem.config.cjs`. PM2 لا يُطلق respawn عند الخروج بالكود 0. الـ drain ينتهي بـ `exit(0)` في `shutdownNow()` — مما يجعل هذا الخروج خروجاً «صحياً» لا «موتاً».

**التقييم الدقيق:**
- يحل القصور (1) المذكور في ADR-028 مباشرة: خروج النسخة القديمة بـ exit(0) بعد drain لن يُطلق respawn.
- **لكنه يخلق مشكلة جديدة:** إذا مات الخادم الحيّ بـ exit(0) نتيجة bug (لا restart مقصود)، PM2 لن يُعيد تشغيله أيضاً. Autorestart يعتمد تاريخياً على أن الموت غير المتوقع = exit(0) أو exit غير صفر.
- **القصور (2) يبقى:** السلوك العرضي لـ `_tree_pids` القديمة ما زال قائماً. بعد `pm2 delete`+start نظيف، restart مع جلسات نشطة = توقف حتى `kill_timeout`.

**الطريقة الثانية — `autorestart: false` + هجرة إلى pm2 reload يدوي:** توقف الـ autorestart كلياً والاعتماد على الـ operator فقط لإعادة التشغيل. يحل respawn الزائف لكنه يُلغي الحماية من الانهيار غير المتوقع.

**الحكم على كفاية المرحلة 0 وحدها:**

المرحلة 0 (قواعد runbook) **تُقلِّل** احتمال العاصفة لكنها لا تحلّها. القصور البنيوي في fork-mode (respawn زائف + `_tree_pids`) لا يزال قائماً. `stop_exit_codes: [0]` تُعالج أعراض القصور (1) وتُضعف الأعراض لكنها تُنشئ استثناء سلوكي يصعب اختباره. المرحلة 0 مناسبة كحارس مؤقت لا كحلٍّ نهائي.

---

## 4. توصية go/no-go

### الحكم: **GO مشروط — بعد استيفاء ثلاثة متطلبات مسبقة**

### المسوّغ

1. **WAL جاهز بالفعل** (مُفعَّل في connection.ts) — هذا يُزيل أكبر مطلب مسبق كان محجِباً.
2. **instances: 1 يُلغي خطر sticky sessions** — المشكلة المعمارية الأكبر (توجيه WebSocket بين workers متعددين) غير موجودة بنسخة واحدة.
3. **cluster-mode يحل القصورين البنيويين من المصدر** (master يملك socket الاستماع → EADDRINUSE مستحيل؛ `pm2 reload` يُحاسب خروج القديم كمتوقَّع → لا respawn زائف).
4. **drain المُنفَّذ يتكيَّف** بطبيعته مع cluster — `server.close()` تعني «أوقف التوجيه لهذا الـ worker» وهو الهدف الصحيح.
5. **العائق التقني الوحيد المتبقي** (ESM + CJS shim) واضح ومحدود النطاق.

### المتطلبات المسبقة الثلاثة (كل منها بوابة)

| المتطلب | الملف/الكود | الخطر إن أُغفل |
|---|---|---|
| **1. cluster-entry.cjs** — shim CJS/ESM | ملف جديد `dist-server/cluster-entry.cjs` | الإقلاع يفشل فوراً مع ESM |
| **2. process.send('ready')** بعد `server.listen` | `server/index.js` خلف علم | PM2 يُرسل طلبات قبل الجاهزية أو يعتبر الـ worker فاشلاً |
| **3. التحقق من treekill: false على workers** | اختبار pilot: SIGKILL بعد kill_timeout لا يطال الأبناء | جلسات claude/agy تُقتل وسط التشغيل |

### خطة هجرة مرحلية

**المرحلة 1 — تحضير الكود (غير تشغيلي، لا restart):**
- إنشاء `dist-server/cluster-entry.cjs` (shim).
- إضافة `process.send?.('ready')` خلف `CLUSTER_WAIT_READY` env في `server/index.js`.
- تغليف `createSession` بـ `db.transaction()` (إصلاح مستقل مطلوب بصرف النظر).
- إضافة `server.on('error', ...)` handler صريح (توصية 7.6 من تقرير المسح).

**المرحلة 2 — pilot على منفذ بديل (معزول):**
- instance جديد في PM2 على منفذ 3005 وDB منفصل بإعداد cluster.
- سيناريوهات إلزامية:
  - `pm2 reload` أثناء جلسة agy نشطة: التحقق من إكمال الدrain وبقاء الأبناء.
  - drain يتجاوز `kill_timeout`: SIGKILL للـ worker لا يطال أبناء agy.
  - استئناف WebSocket بعد reload: الـ reconnect يصل الـ worker الجديد والجلسة القديمة (من transcript/registry).
  - تداخل SQLite أثناء نافذة overlap: لا SQLITE_BUSY.
- مقاييس نجاح الـ pilot:
  - صفر EADDRINUSE.
  - صفر خسائر جلسات agy نشطة عبر reload.
  - صفر SQLITE_BUSY.
  - `pm2 list` يُظهر نسخة واحدة فقط بعد اكتمال reload.

**المرحلة 3 — اعتماد (يتطلب إذن المالك):**
- تحديث `ecosystem.config.cjs`: تغيير `exec_mode` إلى `'cluster'`، تغيير `script` إلى `cluster-entry.cjs`، إضافة `wait_ready: true`، `listen_timeout: 10000`.
- أول `pm2 reload nassaj-dev` بيد المالك.
- مراقبة أول drain طويل.
- تحديث ADR-028 إلى Accepted أو الارتداد إلى systemd (الخيار ج) إذا فشل الـ pilot.

### Fallback

إن فشل الـ pilot (في أي بند): systemd user unit + socket activation (الخيار ج من ADR-028) — يزيل EADDRINUSE بالكامل ويحفظ B-2 بقبول توقف بطول الـ drain (مقبول لمنصة dev).

---

## 5. أهم المخاطر

| الرتبة | الخطر | الاحتمال | الأثر | المعالجة |
|---|---|---|---|---|
| **1** | **رفع instances إلى 2+ مستقبلاً يُفعِّل خطر sticky sessions** — WebSocketWriter وsessionMirrors وsession-registry كلها in-memory لا تُشارَك بين workers. أي worker لا يجد الجلسة في ذاكرته يتصرف كأنها غير موجودة. | منخفض الآن (instances:1)، مرتفع جداً إن رُفع دون مراجعة | انهيار fan-out وreplay كلياً | قيد وثائقي صريح في ecosystem.config.cjs + ADR يمنع instances > 1 بلا مراجعة طبقة WebSocket |
| **2** | **treekill: false لا يُحترم في مسار قتل workers** — غير موثَّق صراحةً في PM2 للـ cluster workers (موثَّق لـ fork). SIGKILL للـ worker بعد kill_timeout قد يطال أبناء agy/claude. | متوسط (سلوك PM2 غير مؤكد للـ cluster workers) | خسارة جلسات agy/claude نشطة عند انتهاء kill_timeout | اختبار إلزامي في الـ pilot قبل أي اعتماد |
| **3** | **`pm2 reload` يُرسل `disconnect` لا SIGTERM مباشرة** — الـ drain مُكتوب للاستماع لـ SIGINT/SIGTERM. في cluster-mode PM2 قد يُرسل `disconnect` event أو `shutdown` message قبل SIGTERM، وتسلسل الإشارات مختلف. إن لم يستجب الـ drain للإشارة الصحيحة فالـ worker ينتظر حتى kill_timeout (5 دقائق) قبل موته. | متوسط | drain لا يبدأ فوراً = تأخر 5 دقائق في كل reload | اختبار تسلسل الإشارات في الـ pilot؛ تعديل handler للـ `process.on('message')` إذا لزم |

---

## 6. القيود والاعتبارات الدائمة

- **instances: 1 دائماً** طالما لم تُحسم مشكلة WebSocket في-الذاكرة بين workers. هذا القيد يجب توثيقه في `ecosystem.config.cjs` نفسه لا فقط في وثائق منفصلة.
- **WAL موجود وكافٍ** — لا حاجة لقرار DB مستقل طالما instances = 1.
- **مرايا الجلسة اللحظية** (`WebSocketWriter` + `sessionMirrors`) تعمل بلا تغيير في cluster مع نسخة واحدة، لأن كل الاتصالات تصل نفس العملية.
- **SESSION_REGISTRY** في session-registry.js يعيش في-الذاكرة أيضاً — نفس القيد، نفس الأمان مع instances = 1.
- **خطر التراجع:** إن أُظهر pilot نتائج مقبولة ثم رُفعت instances لاحقاً بلا مراجعة معمارية، ينهار كل شيء صامتاً. البوابة الأكثر أهمية هي منع هذا التغيير غير المُراجَع.

---

*لا تنفيذ — وثيقة تقييم فقط. كل تغيير تشغيلي مشروط بموافقة المالك وبوابات الـ pilot المذكورة.*
