# المنوال: المُنفِّذ الذاتي لمشاريع نسّاج

المنوال هو نظام تنفيذ ذاتي مبني بداخل نسّاج — يعمل **بلا تدخل يدوي** كل عشر دقائق، ينظر في لوحة المشروع، يختار مهمة، يشغّل جلسة Claude مستقلة، ويسجّل النتيجة. فكّر فيه كموظف ليلي ذكي يعمل وحده. الاسم مستوحى من «منوال النول» — أداة النسيج التي تنسج الخيوط بصبر وانتظام. هنا المنوال ينسج تنفيذ المشروع ذاتياً دورةً بعد دورة.

> **ملاحظة مهمة:** لا تخلط المنوال (هذه الصفحة) مع **منتقي مستوى الجهد** في صندوق الكتابة — ذاك أداة محادثة تختار عمق تفكير الوكيل (auto/low/high) في جلسة تفاعلية. **المنوال هنا نظام تنفيذ ليلي مستقل تماماً** يُطلق جلسات من تلقاء نفسه. مفهومان مختلفان، أدوار مختلفة.

---

## ما هو المنوال ولماذا؟

### التعريف الكامل

**المنوال (nassaj-runner)** هو أوركستريتر تنفيذ ذاتي:

- **المشرف:** سكربت bash في `/home/nassaj/Project/nassaj-ops/scripts/runner/bin/minwal-supervisor.sh` — نقطة دخول cron
- **المحرّك الداخلي:** `nassaj-runner.sh` في نفس المجلد — آلة حالات يستدعيها المشرف (لا يُستدعى من cron مباشرة)
- **التشغيل:** عبر cron النظام كل ١٠ دقائق
- **المهمة:** قراءة ملفات حالة المشروع، اختيار مهمة من لوحة المشروع، تشغيل جلسة `claude -p` headless، كتابة النتائج

### البنية الثلاثية الطبقات

| الطبقة | المسار | الدور |
|--------|--------|--------|
| **مشرف cron (minwal-supervisor.sh)** | `nassaj-ops/scripts/runner/bin/` | نقطة دخول cron، يستدعي nassaj-runner.sh |
| **محرّك الحالات (nassaj-runner.sh)** | `nassaj-ops/scripts/runner/bin/` | آلة حالات، أمان، flock، حصص |
| **جسر TypeScript** | `nassaj-dev/server/modules/runner/` | قراءة ملفات الحالة، بث WebSocket، معالجة التحكّم من الجسر |
| **overlay الواجهة** | `nassaj-dev/src/components/runner/` | عرض حي (RunnerControlBar، RunnerJourney)، أفعال ابدأ/أوقِف/استأنف/اعتمد |

### الفائدة الحقيقية

بدون المنوال: تُرسل طلباً كل مرة وتنتظر.

مع المنوال:
- **جدول يومي:** المشروع يعمل بلا أن تستيقظ
- **حداثة مستمرة:** كل مهمة منتهية تُرفع للمرحلة التالية
- **فحص جودة آلي:** كل تغيير يُراجَع خصومياً قبل العبور
- **آمان مدمج:** قواعد أمان صارمة بناء الكود

---

## كيف يعمل: نموذج الدورة الرباعية

كل دورة cron (كل ١٠ دقائق)، المنوال ينفّذ **خطوة واحدة** فقط من رحلة طويلة متعددة الأطوار.

### الأطوار الأربعة

```
BUILD (جلسة بناء)
    ↓
VERIFY (مراجعة خصومية)
    ↓
VERDICT (حكم النظافة الملزِم)
    ↓
GATE (بوابة المرحلة)
    ↓
[دورة جديدة أو خمول]
```

#### 1️⃣ **BUILD — البناء (جلسة بناء كاملة)**

- **المهمة:** قراءة `docs/project-state.json`، اختيار أول مهمة مفتوحة (status: `in_progress`)، تشغيل جلسة Claude لتنفيذها
- **النموذج:** يختاره المنوال بناءً على نوع المهمة (انظر جدول النماذج أدناه)
- **الملف المكتوب:** `build-signal.json` — يقول "built" أو "no_available_task"
- **المهلة الزمنية:** ٤ ساعات
- **الانتقال التالي:** إذا نجحت → VERIFY | إذا لم توجد مهمة → مباشرة GATE

#### 2️⃣ **VERIFY — التحقق الخصومي (مراجعة diff دورة البناء)**

- **المهمة:** قراءة `build-signal.json` والـ diff، كتابة مراجعة غير ملزِمة (نقد ودودي)
- **النموذج:** دائماً **sonnet** (توازن سرعة وجودة)
- **الملف المكتوب:** `critique-review.json` — نقاط تحسين اختيارية
- **المهلة الزمنية:** ساعتان
- **الانتقال التالي:** دائماً → VERDICT

#### 3️⃣ **VERDICT — الحكم الملزِم (هل الكود نظيف؟)**

- **المهمة:** قراءة `critique-review.json`، حكم نهائي: هل الكود {clean: true/false}؟
- **النموذج:** **opus** (الأقوى) — أو **fable** إن غاب opus
- **الملف المكتوب:** `critique-verdict.json` — `{clean: true, notes}` أو `{clean: false, notes}`
- **المهلة الزمنية:** ساعتان
- **الانتقال التالي:**
  - إذا clean=true → GATE (عبور فوراً) أو awaiting_approval (انتظار موافقة بشرية)
  - إذا clean=false → رجوع البناء (build جديد) — لكن بحد أقصى ٣ محاولات unclean ثم فشل

#### 4️⃣ **GATE — بوابة المرحلة (حدود المرحلة فقط)**

- **المهمة:** تقييم نهاية المرحلة الحالية — هل نعبرها للمرحلة التالية؟
- **النموذج:** دائماً **fable** (الأقوى للقرارات الحرجة)
- **الملف المكتوب:** `gate-signal.json` — "crossed" (عبرنا) أو "drained" (انتظار)
- **المهلة الزمنية:** ساعتان
- **الانتقال التالي:**
  - crossed → مرحلة جديدة ابدأ BUILD
  - drained → خمول (pause) — حتى يستأنف المالك يدوياً

---

### اختيار النموذج (rule-based — قاعدة ثابتة، لا يختاره LLM)

المنوال **لا يترك** للوكيل اختيار النموذج. القاعدة جاهزة مسبقاً:

| نوع المهمة | الشدة | النموذج للـ BUILD |
|-----------|------|---------|
| docs, chore, style | low | **haiku** (سريع، خفيف) |
| feat, refactor, bug | medium | **opus** (متوازن) |
| bug-critical | critical | **fable** (أقوى) |
| غير معروف | — | **opus** (محافظ — انحياز للجودة) |

**الـ verify دائماً:** sonnet  
**الـ verdict دائماً:** opus (أو fable إن غاب opus)  
**الـ gate دائماً:** fable (في القالب الموصى به)

> **ملاحظة — ديوان الفعلي:** قيم نماذج `diwan.json` الحالية: build/build_critical/verdict/gate **كلها opus** — خفض مقصود لترشيد الحصة. القالب أعلاه هو التوصية الافتراضية للمشاريع الجديدة، لكن المالك يضبط `models` في ملف المشروع حسب احتياجه.

---

## البوابات الأمنية (مدمجة بنيوياً)

المنوال **لا يثق** بأي جلسة — كل جلسة محاطة بحواجز:

### ١. بوابة الحصة المزدوجة
- **الفحص:** قبل كل إطلاق جلسة، المنوال يفحص نسبتي الحصة:
  - جلسة واحدة: ٠–٥ ساعات (عتبة تحذير ٨٠%)
  - أسبوعي: حصة محدودة (عتبة ٨٠%)
- **الإجراء:** إذا بلغت الحصة ٨٠% أو أعلى → **لا إطلاق**، سجّل وتوقّف

### ٢. Flock عالمي
- **جلسة واحدة فقط** عبر **كل المشاريع** في نفس الوقت
- باستخدام `flock` على ملف قفل موحد

### ٣. Prompt عبر stdin حصراً
- الـ prompt يُمرَّر عبر stdin، **ليس argv** (لا تظهر في `ps`)
- أمان + خصوصية

### ٤. Git push ممنوع بنيوياً
- كل جلسة تشتغل بـ `--disallowedTools` يضم "git push"
- **غير قابل للاستثناء أبداً**

### ٥. `--dangerously-skip-permissions` محظور
- المنوال **أبداً** لا يصدر هذه الراية
- كل إذن يُفحص

### ٦. Resource Leash
- جلسة واحدة محاطة بـ `systemd-run --scope`:
  - `MemoryMax=1500M` (حد أقصى للذاكرة)
  - `MemorySwapMax=0` (لا swap، منع OOM)
  - `CPUWeight=60` (وزن CPU منخفض، لا تُجفِّف النظام)

### ٧. حارس الشجرة المتسخة
- قبل العمل: افحص حالة git
- إذا توجد تغييرات من جلسة سابقة ماتت: تخطّ الدورة + إشعار

### ٨. حجب قواعد البيانات
- كل جلسة تُطلق بـ `--disallowedTools` يضم:
  - "prisma migrate" (لا هجرات)
  - "db:seed" (لا بذر بيانات)
  - "db:reset" (لا حذف)

---

## الوضعان: Manual vs. Auto

### **وضع Manual (الافتراضي)**

- **الموافقة البشرية حاجبة:** بعد أن تنتهي VERIFY و VERDICT بـ clean=true
- **حالة الانتقال:** تتوقف الدورة عند `awaiting_approval`
- **الاستئناف:** المالك يكتب أمر (أو يضغط زر في الواجهة) = استئناف GATE

### **وضع Auto (ADR-RUNNER-AUTO-001 — ديوان فقط)**

- **بلا موافقة:** VERDICT clean=true → GATE فوراً
- **الصمامات التلقائية:**
  - `max_auto_cycles` = عدد دورات قصوى في مرحلة (افتراضي ١٦)
  - `same_task_repeat_cap` = كم مرة نعيد نفس المهمة (افتراضي ٢)
  - `unclean_cap` = كم مرة نجرب build غير نظيف قبل الفشل (افتراضي ٣)

---

## ملفات الحالة وملفات التحكّم (ADR-RUNNER-BRIDGE-001)

**مبدأ الاتجاه الواحد:** لا اتجاهات متعاكسة، لا deadlock.

### ملفات يكتبها المنوال فقط (حالة — اقرأ فقط)

| الملف | المحتوى |
|-------|--------|
| `cycle-state.json` | الحالة الحالية (phase, cycle, step, phase_end_criterion, current_verdict) |
| `activity.json` | المهمة المختارة حالياً |
| `cycle-history.json` | سجل append-only — كل دورة منتهية |
| `critique-review.json` | نقاط تحسين من VERIFY |
| `critique-verdict.json` | الحكم النهائي (clean: true/false) |
| `build-signal.json` | نتيجة البناء (built أو no_available_task) |
| `gate-signal.json` | نتيجة البوابة (crossed أو drained) |
| `runner-notes.md` | ذاكرة markdown مستمرة (ملاحظات من الجلسات) |
| `visual-checks.json` | قائمة الفحوصات البصرية المعلقة (غير حاجبة) |

### ملفات يكتبها الجسر (nassaj-dev) فقط (تحكّم — اقرأ فقط)

| الملف | المحتوى |
|-------|--------|
| `pause` | ملف إشارة — إذا وُجد: تخطّ الدورة التالية |
| `approve-next-phase` | ملف إشارة — استئناف من awaiting_approval |
| `registry.json` | قائمة المشاريع المسجَّلة (enabled: true/false) |
| `unblock-queue/*.json` | طلبات فك سد يدوي |

### الموضع: STATE_DIR

```
/home/nassaj/Project/nassaj-ops/scripts/runner/state/<project-name>/
├── cycle-state.json
├── activity.json
├── cycle-history.json
├── critique-review.json
├── critique-verdict.json
├── build-signal.json
├── gate-signal.json
├── runner-notes.md
├── visual-checks.json
├── pending-approvals/
├── unblock-queue/
├── pause (إشارة تحكّم)
└── approve-next-phase (إشارة تحكّم)
```

---

## التحقق البصري (Non-Blocking)

المالك قد يرى الكود ويقول "هذا يحتاج تعديل يدوي" — بدون أن يوقف الدورة.

### آلية العمل

1. **المالك يراجع** الكود (خارج الدورة)
2. **يكتب في `visual-checks.json`:**
   ```json
   {
     "check-id": "vc-20260614-001",
     "description": "لون الزر الأحمر ما يطابق العلامة",
     "status": "needs_fix"
   }
   ```
3. **دورة BUILD التالية:**
   - المنوال يقرأ `visual-checks.json`
   - يحقن كل بند `needs_fix` في `runner-notes.md`
   - الجلسة تقرأ الملاحظات وتحوّلها مهمة `kind: bug` في لوحة المشروع

### الأمان

- **غير حاجب:** المنوال **لا يتوقف** لانتظار المالك
- **كتابة ذرّية:** tmpfile + `os.replace` لمنع الفساد
- **تاريخ:** كل check يُؤرّخ ويُحفظ في `visual-checks-archive.json`

---

## overlay اللوحة في nassaj-dev

جسر TypeScript يقرأ ملفات الحالة ويكتب ملفات التحكّم. واجهة تعرض الرحلة بصرياً.

### الجسر (runner-bridge.service.ts)

```typescript
// قراءة دورية من STATE_DIR
if (fs.existsSync(cycleStatePath)) {
  const state = JSON.parse(fs.readFileSync(cycleStatePath));
  // بث عبر WS
  wss.broadcast({ type: 'runner-updated', payload: state });
}

// كتابة تحكّم (إذن only if owner/admin)
if (request.action === 'approve-next-phase') {
  fs.writeFileSync(approvePath, '');
}
```

### الواجهة (RunnerControlBar + RunnerJourney)

| المكوّن | الدور |
|---------|--------|
| **RunnerControlBar** | أزرار (ابدأ، أوقِف، استأنف، اعتمد) — فقط للمالك/Admin |
| **RunnerJourney** | رسم مسار عمودي RTL يظهر المراحل والدورات |

**الأذونات:** الأفعال محمية بـ `requireRole(owner/admin)` — fail-closed (إذا لم تكن المالك، الزر معطّل).

---

## إعداد مشروع جديد (خطوات التشغيل)

### الخطوة 1️⃣: إنشاء ملف إعداد المشروع

مسار الملف:
```
/home/nassaj/Project/nassaj-ops/scripts/runner/projects/<project-name>.json
```

**القالب:**
```json
{
  "name": "myproj",
  "dir": "/home/nassaj/Project/MyProj",
  "model": "opus",
  "threshold": 80,
  "config_dir": "",
  "approval_mode": "manual",
  "execution_depth": "normal",
  "max_auto_cycles": 16,
  "same_task_repeat_cap": 2,
  "unclean_cap": 3,
  "timeouts": {
    "build": 14400,
    "verify": 7200,
    "verdict": 7200,
    "gate": 7200
  },
  "models": {
    "build": "opus",
    "build_trivial": "haiku",
    "build_critical": "fable",
    "verify": "sonnet",
    "verdict": "opus",
    "gate": "fable"
  },
  "allowed_tools": [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash(git commit:*)"
  ],
  "disallowed_tools": [],
  "notify_hook": ""
}
```

**الحقول الإلزامية:**
- `name`: معرّف المشروع
- `dir`: المسار الكامل للمجلد (يجب أن يكون git repo)
- `approval_mode`: "manual" أو "auto"

**الحقول الاختيارية:**
- `config_dir`: مسار CLAUDE_CONFIG_DIR (ترك فارغاً للافتراضي)
- `notify_hook`: رابط webhook للإخطارات (curl POST)

### الخطوة 2️⃣: التسجيل في Registry

تحرير:
```
/home/nassaj/Project/nassaj-ops/scripts/runner/projects/registry.json
```

إضافة:
```json
{
  "name": "myproj",
  "enabled": true,
  "priority": 2
}
```

**ملاحظات:**
- `priority` = رقم الأولوية (أصغر = أولاً)
- `enabled: false` = تجميد المشروع بلا حذف

### الخطوة 3️⃣: التحقق من المتطلبات

المشروع يجب أن:
- يكون git repository (`.git/` موجود)
- يحوي `docs/project-state.json` (لوحة المشروع)

### الخطوة 4️⃣: تفعيل cron (يدوي، غير مثبَّت آلياً)

افتح crontab:
```bash
crontab -e
```

أضِف السطر:
```bash
*/10 * * * * /home/nassaj/Project/nassaj-ops/scripts/runner/bin/minwal-supervisor.sh >> /home/nassaj/Project/nassaj-ops/scripts/runner/logs/cron.log 2>&1
```

**المتطلبات على النظام:**
- `bash`
- `flock`
- `timeout`
- `python3`
- `node`
- `git`
- سكربت الحصة: `/home/nassaj/.claude/scripts/claude-usage.js`

---

## الحالة الحالية

### الحالة الفعلية (2026-07-02)

| المكوّن | الحالة |
|--------|--------|
| مشرف cron (minwal-supervisor.sh) | ✅ مبنيّ ومُفعَّل |
| محرّك الحالات (nassaj-runner.sh) | ✅ مبنيّ ومُختبَر |
| جسر TypeScript (nassaj-dev) | ✅ مبنيّ |
| overlay الواجهة | ✅ مبنيّ (RunnerControlBar، RunnerJourney) |
| **التفعيل على مشروع حيّ** | ✅ **مُفعَّل ويعمل** — diwan enabled:true منذ 2026-06-19 |

### ملفات المشاريع المسجَّلة

- `diwan.json`: **مسجَّل بـ enabled:true** (priority 1) — **نشط**
- `alnuman.json`: **مسجَّل بـ enabled:false** (priority 2) — مجمَّد

### حالة cron

المنوال يعمل كل **١٠ دقائق** عبر `minwal-supervisor.sh`. لا cron تلقائي مثبَّت على مستوى النظام؛ كل استدعاء يدوي للمشرف = دورة واحدة فعلياً.

---

## اختبار المنوال (بلا استدعاء Claude حقيقي)

إذا كنت تريد اختبار الآلية بدون تكاليف:

```bash
/home/nassaj/Project/nassaj-ops/scripts/runner/test/run-tests.sh
```

**النتيجة المتوقعة:**
```
passed: 275  failed: 0
```

الاختبارات تغطي:
- بوابة الحصة المزدوجة
- تقدّم المراحل والدورات
- اختيار النموذج الثلاثي (trivial/normal/critical)
- مصالحة PID الميت
- ملف pause
- الكتابة الذرّية
- flock العام

---

## الأوامر اليدوية

### إعطاء موافقة يدوية (وضع manual)

```bash
touch /home/nassaj/Project/nassaj-ops/scripts/runner/state/<project>/approve-next-phase
```

الملف يُستهلك (يُحذف) فوراً في أول دورة cron بعده.

### إيقاف مشروع مؤقتاً (skip الدورة التالية فقط)

```bash
touch /home/nassaj/Project/nassaj-ops/scripts/runner/state/<project>/pause
```

أو من واجهة nassaj-dev (زر Pause في RunnerControlBar — للمالك/Admin فقط).

### تعطيل مشروع (بلا حذف)

تحرير `projects/registry.json`:
```json
{"name": "myproj", "enabled": false, "priority": 2}
```

---

## متغيرات البيئة للتخصيص

إذا كنت تريد تجاوز الإعدادات الافتراضية (للاختبار أو التخصيص):

| المتغير | الوصف | المثال |
|---------|--------|--------|
| `NASSAJ_RUNNER_ROOT` | تجاوز مسار runner الافتراضي | `export NASSAJ_RUNNER_ROOT=/tmp/test` |
| `RUNNER_CLAUDE_BIN` | تجاوز binary claude (للـ mock) | `export RUNNER_CLAUDE_BIN=/path/to/mock-claude.sh` |
| `RUNNER_USAGE_SCRIPT` | تجاوز سكربت الحصة | `export RUNNER_USAGE_SCRIPT=/custom/usage.js` |
| `RUNNER_HOME` | عزل الحالة في sandbox مؤقت | `export RUNNER_HOME=/tmp/runner-sandbox` |
| `RUNNER_MEM_MAX` | حد الذاكرة لـ systemd-run | `export RUNNER_MEM_MAX=2000M` |
| `RUNNER_CPU_WEIGHT` | وزن CPU | `export RUNNER_CPU_WEIGHT=80` |
| `RUNNER_DISABLE_SCOPE` | إلغاء systemd-run scope | `export RUNNER_DISABLE_SCOPE=1` |

---

## الفرق من منتقي مستوى الجهد

### منتقي مستوى الجهد — صندوق الكتابة

- **ما هو:** عنصر واجهة تختار عمق تفكير الوكيل
- **القيم:** auto / low / medium / high / ultracode
- **الدور:** توجيه رد واحد في جلسة تفاعلية
- **الموقع:** فوق صندوق الكتابة مباشرة

### المنوال (المُنفِّذ الذاتي) — في هذه الصفحة

- **ما هو:** نظام تنفيذ ليلي مستقل
- **القيم:** لا توجد اختيارات للمستخدم — آلي تماماً
- **الدور:** تشغيل دورات بناء متعددة بلا تدخل يدوي
- **الموقع:** خلف الكواليس، في cron النظام

**الخلاصة:** لا تخلط المفهومين. منتقي مستوى الجهد أداة **محادثة**، والمنوال أداة **تنفيذ ليلية مستقلة**.

---

## مصطلحات سريعة

| المصطلح | الشرح |
|--------|--------|
| **المنوال (runner)** | أوركستريتر التنفيذ الذاتي — يعمل كل ١٠ دقائق |
| **الدورة (cycle)** | دفعة واحدة من المهام داخل مرحلة (قد تحتوي عدة build/verify/verdict) |
| **الطور/المرحلة (phase)** | قسم كبير من المشروع (مثل: alpha، beta، production) |
| **الخطوة (step)** | واحدة من الأربع أطوار (build، verify، verdict، gate) |
| **artifact** | ملف النتيجة (build-signal.json، critique-verdict.json، إلخ) |
| **flock** | قفل عالمي يضمن جلسة واحدة فقط في كل وقت |
| **systemd-run scope** | صندوق عزل الموارد للجلسة (ذاكرة، CPU) |
| **state-dir** | مجلد الحالة الكامل للمشروع |

---

## الخطوات التالية

إذا أنت المالك وتريد تفعيل المنوال على مشروعك:

1. **اعتمِد ADR-RUNNER-BRIDGE-001** — الإطار النظري للجسر (قيد القرار)
2. **شغّل الاختبارات:** `test/run-tests.sh` — تأكد من عمل المحرّك
3. **أنشئ `projects/<name>.json`** — إعداد المشروع
4. **سجّل في registry.json** — تفعيل نهائي
5. **أضِف سطر cron** — في طرفيتك (أنت بنفسك، لا يُثبَّت آلياً): `*/10 * * * * /home/nassaj/Project/nassaj-ops/scripts/runner/bin/minwal-supervisor.sh >> ...`
6. **اختبر الواجهة:** افتح nassaj-dev، انقر RunnerControlBar

**مُحتاج ساعة واحدة فقط من الإعداد.** بعدها يعمل بلا أي تدخل.

---

نسّاج فريقك. المنوال موظفك الليلي الذكي.
