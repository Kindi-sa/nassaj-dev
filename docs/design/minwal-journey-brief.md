# Design Brief — «مسار المِنوال عبر المراحل» (Minwal Journey Across Phases)

> عنصر عرض جديد في لوحة مشروع nassaj-dev. يُظهر للمالك أين تحرّك المُنفِّذ الذاتي
> (المِنوال) وأين وصل بين مراحل المشروع.
> **سؤال واحد يجب أن يجيبه بنظرة:** «المِنوال في أي مرحلة الآن، وكم دورة أنجز، وما التالي».
>
> الحالة: مسوّدة بانتظار اعتماد المالك. لا يُمرَّر لـ frontend-dev/backend-dev قبل الاعتماد.
> Source of truth visual: `RunnerControlBar.tsx` + `BoardOverview.tsx` (PhaseTimeline) — **امتداد، لا نظام جديد.**

---

## 0. القرار البصري الجوهري — فصل المفهومين الذي خلط فيه المالك

مفهومان متداخلان يجب أن **يُميَّزا بصرياً بلا لبس**، وهذا هو السبب الأول لوجود العنصر:

| المفهوم | ما هو | المصدر | التمثيل البصري المختار |
|---|---|---|---|
| **مرحلة (phase)** | معلَم كبير (S0…S5، BETA). عدة مهام. | `docs/project-state.json` → `phases[]` (متوفّر) | **عقدة كبيرة على المسار** (node) — دائرة 20px بأيقونة حالة، نفس عقد PhaseTimeline القائمة. |
| **دورة (cycle)** | تعالج ~مهمة واحدة. 4 أطوار: build→verify→verdict→gate. عدة دورات داخل المرحلة. | **غير مسجَّل تاريخياً** — يجب إنشاء عقد `cycle-history` (القسم 2). | **شريحة صغيرة (chip)** تحت/داخل عقدة المرحلة — مربّع 14–16px بحالة لون. |

**لماذا هذا الفصل بصرياً:** المرحلة ثقيلة وثابتة ونادرة التغيّر (معلَم)، فتأخذ الوزن البصري الأكبر
(عقدة + عنوان + شريط تقدّم). الدورة خفيفة وكثيرة ومتكرّرة (وحدة عمل)، فتأخذ أصغر تمثيل ممكن
(شريحة) — وإلا غرق المالك في تفاصيل الدورات وفقد «المرحلة». الهرمية البصرية = الهرمية المفاهيمية.

**القاعدة الذهبية للعنصر:** المرحلة هي الحاوية، الدورة هي المحتوى، الطور هو تفصيل الدورة (مطويّ افتراضياً).

---

## 1. Visual tone

**Utilitarian** (نفعي، لوحة تحكّم تشغيلية) — سطران للتبرير:
1. هذه لوحة مراقبة لمالك يريد جواباً فورياً عن حالة آلة تعمل، لا تجربة سردية — الوضوح والكثافة المعلوماتية أهمّ من الزخرفة.
2. النظام البصري القائم (`RunnerControlBar` + `PhaseTimeline`) نفعي بالفعل: شارات صغيرة، نقاط حالة، نبض للنشاط — أي نبرة أخرى ستخلق تنافراً داخل نفس اللوحة.

---

## 2. عقد البيانات المطلوب (الأهم — يُسلَّم لـ backend-dev)

### 2.1 الموجود اليوم (لا يكفي)

`cycle-state.json` (الحالي، مسار `STATE_DIR/<project>/cycle-state.json`):
```jsonc
{ "stage": "awaiting_approval", "cycle": 1, "status": "idle",
  "fix_loops": 0, "exit2_count": 0, "interrupted_count": 0, "last_error": "" }
```
عدّاد `cycle` واحد فقط، **بلا تاريخ، بلا وسم مرحلة، بلا نتائج أطوار سابقة.** لا يمكن رسم «المسار»
من هذا — يعطي الحاضر فقط، لا الرحلة.

`activity.json` (مرآة الحيّ، موجود): يعطي `active_phase_id` + `stage` + `last_verdict` + `heartbeat_at`
— يكفي لمؤشّر «المِنوال هنا» الحيّ، لكن **لا يعطي التاريخ**.

### 2.2 المطلوب إنشاؤه: `cycle-history.json` (ملف جديد، append-only)

ملف مستقل بجوار `cycle-state.json` (نفس `STATE_DIR/<project>/`). السبب لملف منفصل لا توسيع
`cycle-state.json`: الأخير حالة فورية تُكتب ذرّياً كثيراً (heartbeat/transition)؛ خلط سجلّ متنامٍ
معها يكبّر كل كتابة ذرّية ويخاطر بالفقد. ملف append-only منفصل أنظف ويتبع نفس نمط atomic write القائم.

**الشكل المقترح:**
```jsonc
{
  "$version": 1,
  "project": "diwan",
  "updated": "2026-06-13T18:48:08+03:00",   // آخر كتابة (لتمييز التحديث الحيّ)

  // الموضع الحالي — مصدر مؤشّر «المِنوال هنا». مرآة لـ cycle-state + activity،
  // مكرّر هنا عمداً ليكون للعنصر مصدر واحد (single fetch) بدل دمج ملفين.
  "current": {
    "cycle": 4,                 // رقم الدورة الجارية (= cycle-state.cycle)
    "phase_id": "S1",           // = activity.active_phase_id
    "task_id": "T-12" ,         // = activity.active_task_id (قد يكون null)
    "stage": "build",           // الطور الجاري ضمن الدورة: build|verify|verdict|gate|awaiting_approval
    "status": "running",        // running|idle|interrupted|failed
    "started_at": "2026-06-13T18:45:01+03:00",
    "heartbeat_at": "2026-06-13T18:48:08+03:00"   // لكشف «حيّ vs متجمّد»
  },

  // السجلّ — دورة لكل عنصر، append عند إغلاق الدورة (راجع 2.3).
  "cycles": [
    {
      "cycle": 1,                       // رقم الدورة (تسلسلي عبر المشروع)
      "phase_id": "S0",                 // المرحلة التي جرت ضمنها
      "task_id": "T-03",                // المهمة التي عالجتها (من activity وقت البناء)
      "task_title": "إعداد القاعدة",     // اختياري: لقطة عنوان المهمة (للـ tooltip)
      "status": "succeeded",            // succeeded | failed | interrupted
      "started_at": "2026-06-12T09:00:00+03:00",
      "ended_at":   "2026-06-12T11:30:00+03:00",
      "fix_loops": 0,                   // عدد دورات build المتكرّرة (verdict unclean)
      "stages": {                       // نتيجة كل طور من الأربعة
        "build":   { "status": "ok",     "model": "fable",  "duration_s": 5400 },
        "verify":  { "status": "ok",     "model": "sonnet", "duration_s": 1800 },
        "verdict": { "status": "clean",  "model": "fable",  "duration_s": 1200 },
        "gate":    { "status": "approved","model": "fable",  "duration_s": 900,
                     "approved_at": "2026-06-12T11:30:00+03:00", "approved_by": "owner" }
      }
    }
    // … دورة 2، 3 …
  ]
}
```

**قاموس قيم `stages.*.status` (للون البصري — القسم 5):**
- `build`: `ok` | `failed` | `running` | `pending`
- `verify`: `ok` | `failed` | `running` | `pending`
- `verdict`: `clean` | `unclean` | `running` | `pending`  ← `unclean` يعيد للـ build (loop)
- `gate`: `awaiting` | `approved` | `pending` | `skipped` (دورة وسط المرحلة لا تعبر = `skipped`/غائب)

**ملاحظة لـ backend-dev:** `gate` لا يجري إلا على حدّ المرحلة. أغلب الدورات تنتهي عند `awaiting_approval`
ثم اعتماد المالك ثم `gate` → `cycle++`. لذا دورة وسط مرحلة قد لا تملك `gate` فعلياً؛ مثّلها بـ
`gate: { status: "skipped" }` أو احذف المفتاح. العنصر يعرض 3 أطوار لها و4 للدورة الأخيرة في المرحلة.

### 2.3 نقطة الكتابة في المحرّك (للـ backend-dev — دقيق)

`lib/state.sh::advance_stage` هي نقطة الالتقاط الطبيعية — تُستدعى عند **كل انتقال طور ناجح**:
- في `build`/`verify`/`verdict`/`gate` cases: حدّث `current.stage` + (اختياري) أضِف `stages.<stage>` للدورة الجارية في عنصر مؤقّت.
- عند `verdict` clean → `awaiting_approval`: ثبّت نتيجة `verdict`.
- عند `gate` (نهاية الدورة): **append عنصر الدورة المكتمل إلى `cycles[]`** ثم `cycle++` و`current.cycle++`.
- في `fail_project`: أغلق الدورة الجارية بـ `status:"failed"` وألحقها.
- عند interrupt (rc=75): سجّل `status:"interrupted"` على الطور الجاري دون إغلاق الدورة (تُستأنف).

**حدّ السجلّ:** احتفظ بكل الدورات (مشروع نموذجي عشرات الدورات — حجم تافه). إن تجاوز 500 دورة،
اقتطع الأقدم مع الإبقاء على عدّاد إجمالي `total_cycles` في الجذر (لعرض «… +N دورة سابقة»).

### 2.4 الجسر والـ API (للـ backend-dev)

- جسر `runner-bridge.service` يراقب الملفات بـ chokidar ويبثّ `runner-updated`. **أضِف `cycle-history.json` لقائمة المراقبة** وضمّن محتواه في استجابة `GET /api/runner/:id` تحت مفتاح جديد `history` على `RunnerStatus`.
- توسيع نوع الواجهة (للـ frontend-dev): أضِف لـ `RunnerStatus` (في `useRunner.ts`) الحقل:
  `history: { current: {...}, cycles: [...], total_cycles?: number } | null`.
- `null` عندما لا يوجد الملف بعد (مشروع بلا دورات) → العنصر يعرض الحالة الفارغة (القسم 4).
- **قاعدة ADR-RUNNER-BRIDGE-001 محفوظة:** الواجهة تقرأ فقط؛ لا تكتب الملف أبداً. الاعتماد (`approve`) يبقى عبر POST control الموجود؛ المحرّك من يكتب `gate.approved`.

---

## 3. التخطيط البصري (Layout)

### 3.1 الموضع داخل اللوحة

قسم جديد في **تبويب «نظرة عامة» (overview)** أسفل `PhaseTimeline` القائمة وقبل `SprintsSection`،
أو — الأفضل — **يحلّ محلّ/يدمج** PhaseTimeline حين يكون المشروع مسجَّلاً بالمِنوال (registered)، لأن
المِنوال يضيف بُعد الدورات فوق نفس المراحل. القرار للمنسّق؛ التوصية: **قسم مستقل تحت PhaseTimeline**
بعنوان `runner.journey.title` ليُعرض فقط عند `registered && history != null` (additive، اللوحة بلا
مِنوال تبقى byte-for-byte كما هي — نفس فلسفة RunnerControlBar).

عنوان القسم: «مسار المِنوال» (`runner.journey.title`) بنفس نمط `h3` القائم
(`text-sm font-semibold text-foreground mb-3`).

### 3.2 الاتجاه: مسار عمودي (vertical timeline) — لا أفقي

**القرار: عمودي، بمحاذاة `PhaseTimeline` القائمة بالضبط** (`<ol>` مع `border-s-2 ps-5`، عقدة
`-start-[...]`). لماذا عمودي لا أفقي:
1. التطابق البصري: PhaseTimeline القائمة عمودية أصلاً — مسار أفقي بجوارها = نظامان متنافران.
2. RTL: المسار العمودي محايد اتجاهياً (يتدفّق أعلى→أسفل)، يتجنّب لبس «يسار=ماضٍ أم مستقبل» في العربية.
3. الدورات: مرحلة بعشرات الدورات تتمدّد أفقياً بلا حدود (scroll أفقي بغيض)؛ عمودياً تُطوى وتُلَفّ رأسياً بسلاسة.

### 3.3 التخطيط التفصيلي (ASCII — RTL، اقرأ من اليمين)

```
مسار المِنوال                                        ● المِنوال هنا · الدورة 4
─────────────────────────────────────────────────────────────────────────
│
●  S0  إعداد القاعدة                                    ✅ منجزة   100%
│   ▸ الدورات (2)   [✓][✓]
│
●  S1  نواة المنتج                          🟢 الحالية · المِنوال هنا   90%
│   ▾ الدورات (3)
│      ┌──────────────────────────────────────────────────┐
│      │ [✓ د1]  T-08 · نظيف                                │
│      │ [✓ د2]  T-10 · نظيف                                │
│      │ [⏳ د4]  T-12 · جارٍ  ◀ هنا                          │  ← ينبض
│      │    ▾ الأطوار:  ●build  ○verify  ○verdict  ○gate    │
│      │        build جارٍ ينبض · النموذج fable               │
│      └──────────────────────────────────────────────────┘
│
●  S2  ميزات موسّعة                                     ⏸ بانتظار   95%
│   (لا دورات بعد)
│
○  BETA  إطلاق تجريبي                                   ⏸ بانتظار
│
○  S3  …                                                ⏸ بانتظار
─────────────────────────────────────────────────────────────────────────
```

- **عقدة المرحلة (●/○):** نفس عقد PhaseTimeline حرفياً — `CheckCircle2` (done/أخضر)،
  `CircleDot` (current/primary)، `Circle` (pending/border). يُضاف للحالية حلقة نبض.
- **صفّ الدورات داخل كل مرحلة:** `<details>` قابل للطيّ (نفس نمط `SprintsSection`):
  - **مطويّ افتراضياً** للمراحل المنجزة والمعلّقة → يعرض شريحات مصغّرة فقط `[✓][✓]` + العدّ.
  - **مفتوح افتراضياً للمرحلة الحالية** (حيث المِنوال) → يعرض بطاقات الدورات.
- **بطاقة الدورة (cycle chip/card):** `rounded-lg border bg-card` (نفس TaskCard): رقم الدورة + المهمة + الحالة. قابلة للنقر لتوسيع **صفّ الأطوار الأربعة**.
- **صفّ الأطوار الأربعة:** 4 نقاط/شارات متسلسلة build→verify→verdict→gate، كلّ منها بحالة لون. الطور الجاري ينبض (`animate-pulse`، نفس `RunnerTaskDot`).

### 3.4 مؤشّر «المِنوال هنا»

ثلاث طبقات (وضوح متدرّج):
1. **شارة علوية** بجوار عنوان القسم: `● المِنوال هنا · الدورة N` — نقطة نابضة + نص (نفس status pill في RunnerControlBar، لون حسب `deriveRunnerUiState`).
2. **على عقدة المرحلة الحالية:** نفس `RunnerPhaseBadge` القائمة (شارة «قيد التشغيل» نابضة) — إعادة استخدام مباشر.
3. **على بطاقة الدورة الجارية:** سهم/وسم `◀ هنا` + نبض على الطور الجاري. هذا أدقّ مستوى («المِنوال في طور build من الدورة 4 من المرحلة S1»).

---

## 4. الحالات الحدّية

| الحالة | السلوك البصري |
|---|---|
| **لا دورات بعد** (`history.cycles` فارغ، `current.cycle`=1 لم يبدأ) | المسار يعرض المراحل فقط (= PhaseTimeline العادية) + سطر خافت تحت القسم: «لم يبدأ المِنوال أي دورة بعد» (`runner.journey.noCycles`). لا تعرض صفوف دورات فارغة. |
| **`history`=null** (مشروع غير مسجَّل/الملف غائب) | لا يُعرض القسم إطلاقاً (additive). اللوحة بلا تغيير. |
| **مرحلة بدورة واحدة** | شريحة واحدة `[✓]` + «الدورات (1)». لا طيّ مبالغ. |
| **مرحلة بعشرات الدورات** | الطيّ مغلق افتراضياً؛ عند الفتح: شبكة شريحات مصغّرة `wrap` (flex-wrap، كل شريحة 14px) بدل بطاقات كاملة — البطاقة الكاملة فقط للدورة المختارة/الجارية. زرّ «عرض الكل (N)» إن تجاوزت ~20 (راجع القسم 6). |
| **فشل دورة** (`status:"failed"`) | شريحة/بطاقة حمراء (`destructive`)؛ الطور الذي فشل بأيقونة `XCircle`. tooltip = `last_error`. لا نبض (متوقّفة). |
| **توقّف (interrupted/حصة)** | لون أصفر (`yellow-500`، نفس `interrupted` في UI_STATE_STYLES) + أيقونة pause؛ نص «متوقّف (حصة)». الطور الجاري لا ينبض (متجمّد). |
| **بانتظار موافقة بشرية (gate / awaiting_approval)** | بطاقة الدورة الجارية بإطار أزرق (`blue-500`, نفس `awaiting_approval`) + شارة «بانتظار الاعتماد»؛ الطور `gate` بحالة `awaiting` نابض بهدوء. زرّ «اعتمد المرحلة» يبقى في RunnerControlBar (لا تكرّره) — يكفي توجيه بصري للمستخدم نحوه. |
| **heartbeat قديم** (`now - heartbeat_at > ~3×tick`) | الطور الجاري يتوقّف عن النبض ويظهر وسم خافت «قد يكون متجمّداً» (`runner.journey.stale`). لا تدّعِ نشاطاً غير موجود. |
| **`task_id`=null** (دورة بلا مهمة محدّدة، شائع في activity) | اعرض المرحلة فقط على الشريحة: «دورة N · S1» بلا معرّف مهمة. |

---

## 5. design tokens (من النظام القائم — لا جديد)

كل القيم مأخوذة من `UI_STATE_STYLES`، `KIND_STYLES`، `SEVERITY_STYLES`، وعقد PhaseTimeline.
**لا لون/مقاس/أيقونة جديدة.**

### 5.1 ألوان الحالة (Tailwind tokens موجودة)

| الحالة | token (نفس UI_STATE_STYLES/PhaseTimeline) | الاستخدام |
|---|---|---|
| منجزة / نظيف / ok | `green-500` + `bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400` | عقدة مرحلة done، شريحة دورة ناجحة، verdict clean |
| الحالية / running | `primary` (عقدة) + `amber-500/10…` (نشاط build/running) | عقدة المرحلة الحالية + بطاقة الدورة الجارية |
| تحقّق (verify) | `sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30` | طور verify جارٍ |
| بانتظار اعتماد (gate) | `blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30` | دورة awaiting + طور gate |
| توقّف (حصة) | `yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30` | interrupted |
| محجوب (paused) | `orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30` | paused |
| فشل / unclean | `destructive/10 text-destructive border-destructive/30` | دورة/طور فشل، verdict unclean |
| معلّقة / pending | `bg-muted text-muted-foreground border-border` | مرحلة/دورة/طور لم يبدأ |

> **تباين:** كل أزواج النصّ/الخلفية أعلاه مستعملة بالفعل في RunnerControlBar وBoardOverview وتمرّ
> معايير اللوحة الحالية (نصّ ملوّن 600/dark:400 على خلفية /10). لا نُدخل زوجاً جديداً، فلا نخاطر بتباين دون AA.
> النقاط الصغيرة (`bg-current`/`bg-amber-500`) **زخرفية مصحوبة دائماً بنصّ** — التباين غير حرج عليها (تُستثنى بـ aria-hidden).

### 5.2 الأيقونات (lucide-react، كلها مستعملة في اللوحة)

`CheckCircle2` (done/clean) · `CircleDot` (current) · `Circle` (pending) · `XCircle` (failed/unclean) ·
`Bot` (المِنوال) · `CheckCheck` (verdict/approve) · `Pause` (interrupted/paused) · `Gauge` (حصة) ·
`Activity` (running). الطور الأربعة يمكن تمثيلها بنقاط ملوّنة بسيطة + tooltip بالاسم (أبسط من 4 أيقونات).

### 5.3 المقاسات والمسافات (4/8 base، من القائم)

- عقدة المرحلة: `h-5 w-5` (20px) — مطابقة PhaseTimeline.
- شريحة الدورة المصغّرة: `h-3.5 w-3.5`→`h-4 w-4` (14–16px).
- نقطة الطور: `h-1.5 w-1.5` (نبض) / `h-2 w-2`.
- بطاقة الدورة: `rounded-lg border p-2.5` (= TaskCard).
- نصوص: عنوان قسم `text-sm font-semibold`؛ معرّف `font-mono text-xs/[10px]`؛ شارات `text-[10px]/[11px]` — كلها من النظام.
- المسافة بين المراحل: `pb-5` (= PhaseTimeline `space-y` ضمن `<li>`).
- radius: `rounded-full` (عقد/نقاط)، `rounded-lg` (بطاقات)، `rounded-md`/`rounded` (شارات) — من القائم.
- motion: `animate-pulse` فقط (الطور/الدورة الجارية) — نفس اللوحة، لا حركة جديدة.

---

## 6. التجاوب وRTL وإمكانية الوصول

### 6.1 التجاوب + اختصار المراحل الطويلة

- **الطيّ هو آلية الاختصار الأساسية:** كل مرحلة `<details>`؛ مطويّ افتراضياً عدا الحالية. المالك يرى المسار كاملاً (المراحل) دائماً، ويفتح دورات مرحلة بعينها عند الحاجة.
- **مرحلة بعشرات الدورات:** داخل `<details>` المفتوح، الشريحات `flex-wrap` (صفّ ينكسر) لا scroll أفقي. حدّ عرض ~20 شريحة ثم «عرض الكل (N)» (`<details>` متداخل أو زرّ يكشف الباقي).
- **scroll:** القسم داخل `overflow-y-auto` القائم في BoardOverview — لا scroll مستقل. الطول الإجمالي يُدار بالطيّ لا بالتمرير.
- **mobile (`< sm`):** بطاقات الدورة عرض كامل (`grid-cols-1`)؛ صفّ الأطوار الأربعة `flex-wrap`. لا جدول أفقي.

### 6.2 RTL (إلزامي)

- الحاوية `dir="rtl"` (نفس RunnerControlBar).
- المسار العمودي يستعمل `border-s-2 ps-5` و`-start-[...]` (logical properties) — يعمل RTL تلقائياً كـ PhaseTimeline القائمة. **لا `left/right` صريحة.**
- المعرّفات والنماذج (`T-12`, `fable`, `S1`) بـ `dir="ltr"` + `font-mono` داخل سياق عربي (نفس نمط اللوحة للأكواد).
- ترتيب صفّ الأطوار build→verify→verdict→gate يتدفّق من اليمين لليسار بصرياً (طبيعي في RTL، الأول يميناً) — يطابق التسلسل الزمني للقارئ العربي.

### 6.3 إمكانية الوصول (a11y)

- **اللون ليس الناقل الوحيد:** كل حالة مصحوبة بأيقونة + نص (✓/✗/⏳ + كلمة) — مكفوف الألوان يميّز done/failed/running بالأيقونة لا اللون فقط.
- النقاط الزخرفية (نبض، نقطة الطور) `aria-hidden="true"` (نفس RunnerTaskDot القائم).
- بطاقة الدورة القابلة للتوسّع = `<button>`/`<summary>` حقيقي (keyboard + focus). `<details>` يعطي طيّ مدعوم native بلا JS لإمكانية الوصول.
- شارة «المِنوال هنا» العلوية: `aria-live="polite"` لإعلان قارئ الشاشة بتغيّر الموضع (المِنوال انتقل لدورة/مرحلة جديدة) دون إزعاج.
- focus states: نفس `focus-visible` ring المستعمل في اللوحة (لا تخصيص جديد).
- كل عنصر تفاعلي بـ `aria-label` وصفي عربي: «دورة 4، مرحلة S1، طور البناء، جارٍ» — يجمع المفاهيم الثلاثة في تسمية واحدة مفهومة.
- النبض: من يفعّل `prefers-reduced-motion` لا يرى الوميض — `animate-pulse` يجب أن يُلَفّ بـ `motion-safe:` (تحسين على القائم؛ يُذكر لـ frontend-dev لأن RunnerControlBar الحالي لا يفعله — فرصة رفع جودة، لا قيد مانع).

---

## 7. مفاتيح i18n الجديدة (تحت `runner.journey.*` — تمتدّ على `runner.*` القائم)

للـ frontend-dev، تُضاف في `src/i18n/locales/{ar,en}/projectBoard.json`:
```
runner.journey.title          = "مسار المِنوال"
runner.journey.here           = "المِنوال هنا"
runner.journey.cyclesCount    = "الدورات ({{n}})"
runner.journey.noCycles       = "لم يبدأ المِنوال أي دورة بعد"
runner.journey.cycleN         = "دورة {{n}}"        // موجود مقارب: runner.cycle
runner.journey.showAll        = "عرض الكل ({{n}})"
runner.journey.stale          = "قد يكون متجمّداً"
runner.journey.phasesLabel    = "أطوار الدورة"
runner.journey.stage.build    = "بناء"             // متّسق مع runner.status.building
runner.journey.stage.verify   = "تحقّق"
runner.journey.stage.verdict  = "حكم"
runner.journey.stage.gate     = "عبور المرحلة"
runner.journey.cycleStatus.succeeded = "ناجحة"
runner.journey.cycleStatus.failed    = "فشلت"
runner.journey.cycleStatus.interrupted = "متوقّفة"
```
> أعِد استخدام `runner.stages.*`, `runner.status.*`, `runner.clean/unclean` الموجودة حيثما تطابق
> بدل تكرارها (التزام بمبدأ منع الحشو). أضِف فقط ما لا مقابل له.

---

## 8. تسليم وبوابات

- **مخرجات هذا الـ brief:** هذا الملف + عقد `cycle-history.json` (القسم 2) + توسيع `RunnerStatus.history` (القسم 2.4).
- **لـ backend-dev:** بناء `cycle-history.json` (كتابة في `lib/state.sh`/`launch.sh`)، إضافته لمراقبة الجسر، وتضمينه في `GET /api/runner/:id`. ADR-RUNNER-BRIDGE-001 محفوظ (قراءة فقط من الواجهة).
- **لـ frontend-dev:** عنصر `MinwalJourney` تحت overview، additive، يُعرض فقط عند `registered && history`، يعيد استخدام tokens/أيقونات/أنماط القسم 5 — لا نظام جديد.
- **مراجعة لاحقة:** `design-reviewer` (نقد المنفّذ مقابل هذا الـ brief) + `a11y-architect` (تدقيق WCAG على القسم 6.3) بعد التنفيذ.
- **بوابة:** لا تنفيذ قبل اعتماد المالك لهذا الـ brief.
```
