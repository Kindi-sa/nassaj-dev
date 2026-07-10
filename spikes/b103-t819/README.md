# T-819 — spike الإثبات: جانب المنتِج (B-103 النموذج اللاتزامني)

> Proof spike for the B-103 async-agent model. **جانب المنتِج** (§و معايير 1-3، التقاط النتيجة)
> **وجانب المستهلك + المراقب** (§و معايير 4-7، dedup التسليم exactly-once + صمود المراقب + flock)
> كلاهما مُثبَت هنا. يبقى **soak ميداني حيّ (المعيار 8)** لموجة الحقل. لا شيء هنا يمسّ كود السيرفر
> الحيّ أو البناء أو PM2.
>
> المرجع: `docs/plans/B-103-ASYNC-AGENTS-DESIGN-2026-07-10.md` (§أ المخطط/دورة الحياة/الذرّية،
> §ب-2 المراقب، §ج التدفقات، §و/المرحلة 1) + `docs/plans/B-103-SYSTEMS-CONSOLIDATION-AUDIT-2026-07-10.md`.
>
> الأدلة: `evidence/producer.json` (معايير 1-3) و`evidence/consumer.json` (معايير 4-7).

## ما يثبته (what it proves)

يُطلَق `claude -p --output-format json` **حقيقياً** كخدمة systemd عابرة للمستخدم، ويُلتقَط
الناتج ذرّياً وفق §أ-4، ثم يُصنَّف نهائياً وفق §أ-3:

- **المعيار 1** — ≥20 تشغيلاً فعلياً عبر الأصناف الثلاثة (نجاح/جزئي/انهيار)، المصنّف 100%.
- **المعيار 2** — 100 حقن `kill -9` عند إزاحات بايت عشوائية أثناء كتابة النتيجة ⇒ **صفر
  `result.json` ممزّق** (فقط `.partial`). يُعاد تمرير fixtures **حقيقية** عبر **مسار الكتابة نفسه**، بلا LLM.
- **المعيار 3 (ثقب 2-أ)** — ≥10 تشغيلات فعلية مُقاطَعة `kill -9` في نافذة **rename→DONE** ⇒
  تصنيف **حاسم** (CRASHED أو PARTIAL-untrusted) بعد مهلة السماح — لا تعليق أبدي، لا ادّعاء SUCCEEDED.

## بروتوكول الالتقاط (§أ-4) — `lib/capture-writer.mjs`

الترتيب الحاسم، مُثبَّت في `seal()` (مسار واحد للحيّ وللاختبار):
1. `.partial` يحمل الناتج أثناء التنفيذ (غير نهائي أبداً).
2. عند exit=0: `fsync(.partial)` → `rename(.partial → result.json)` (ذرّي) → `fsync(dir)`.
   **`result.json` لا يوجد إلا مكتملاً ودائماً** (rename ذرّي لا يُنتج نسخة جزئية).
3. `DONE` **آخر شيء** (tmp→fsync→rename→fsync dir): `{exit_code, signal, finalizedAt}`.
   المراقب لا يثق بشيء دون `DONE`.

## التصنيف (§أ-3) — `lib/classifier.mjs`

`DONE` مصدر الحقيقة؛ حالة الوحدة تحكم فقط توفيق غياب `DONE`:

| الحالة على القرص | التصنيف |
|---|---|
| `DONE` + exit 0 + `result.json` | **SUCCEEDED** |
| `DONE` + exit≠0 | **PARTIAL** |
| `DONE` بإشارة قتل | **CRASHED** |
| لا `DONE` + (unit=failed أو لا `result.json`) بعد المهلة | **CRASHED** |
| لا `DONE` + unit=inactive/gone + `result.json` موجود بعد المهلة | **PARTIAL-untrusted** |

المهلة (`--grace-ms`) تغلق سباق «صارت inactive قبل كتابة DONE بلحظات» ثم تحسم — **لا تعليق أبدي**.

## البنية

```
lib/capture-writer.mjs     مسار الكتابة الذرّي الوحيد (finalize/replay + hooks؛ writeFileAtomic مُصدَّر)
lib/classifier.mjs         تصنيف §أ-3 (يقرأ الملفات + is-active)
lib/handoff.mjs            [مستهلك] التسليم exactly-once: handoffId + ledger + dedup بـ JSON.parse
lib/supervisor.mjs         [مستهلك] المراقب الدائم: reconcile-on-boot + monitor + onTerminal→deliver
lib/aggregate-evidence.mjs يدمج معايير 1-3 → evidence/producer.json
lib/aggregate-consumer-evidence.mjs  يدمج معايير 4-7 → evidence/consumer.json
bin/run-task.sh            يُطلق wf-<taskId>.service عبر systemd-run --user
bin/task-inner.sh          يعمل داخل الوحدة: claude -p → capture-writer --finalize
bin/handoff-cli.mjs        [مستهلك] CLI رفيع فوق handoff.mjs (finalize/scan/hid)
bin/supervisor-run.sh      [مستهلك] بوابة flock(2) مالك-واحد ثم exec node supervisor.mjs
tests/criterion{1,2,3}-*.sh  معايير المنتِج الثلاثة
tests/criterion{4,5,6,7}-*.sh معايير المستهلك الأربعة
tests/run-all.sh           منسّق المنتِج (يكتب evidence/producer.json)
tests/run-consumer.sh      منسّق المستهلك (يكتب evidence/consumer.json)
fixtures/t819-succ-*.json  result.json حقيقي مُلتقَط (للمعيار 2)
fixtures/conversation-*.jsonl  transcript محادثة حقيقي مُحصود (للمعايير 4-6، بلا توليد LLM)
evidence/producer.json     ملخّص آلي — معايير 1-3
evidence/consumer.json     ملخّص آلي — معايير 4-7
```

## التشغيل (re-run)

```bash
# الكل (يستهلك حصة اشتراك حقيقية — prompts قصيرة + haiku)
bash spikes/b103-t819/tests/run-all.sh

# المعيار 2 وحده — بلا LLM، على fixtures حقيقية مُودَعة
STATE_ROOT=/tmp/b103-verify-c2 bash spikes/b103-t819/tests/criterion2-tearing.sh

# معياران حقيقيان منفصلان
STATE_ROOT=/tmp/b103-verify-c1 bash spikes/b103-t819/tests/criterion1-classify.sh
STATE_ROOT=/tmp/b103-verify-c3 bash spikes/b103-t819/tests/criterion3-window.sh
```

## المستهلك: عقد التسليم exactly-once (§أ-4 / المعايير 4-7)

المراقب يسلّم نتيجة كل مهمة **مرّة واحدة بالضبط** إلى `<conversationId>.jsonl` بمفتاحين:

1. **ledger الدفعة** `handoffs/<conversationId>.done` — المفتاح الأساسي (ذرّي، مستوى-المحادثة).
   يُكتب عبر **نفس** `writeFileAtomic` الذي يختم به المنتِج `DONE` (tmp→fsync→rename→fsync-dir).
2. **توفيق jsonl** — يغلق نافذة العطل **بين الحقن وكتابة الledger**: المطابقة على سطر jsonl
   **مُحلَّل كاملاً بـ `JSON.parse`** لا regex نصّي. سطر ممزّق/نصف-مكتوب **لا يُحلَّل ⇒ يُتجاهَل**
   ويُعامَل «لم يُسلَّم» تحفّظاً (بلا فقد). هذا جوهر المعيار 5 (نظير reconcile 6.5%):
   **regex يطابق السطر الممزّق ويتخطّى خطأً ⇒ ضياع؛ JSON.parse لا** — والاختبار يثبت الطرفين.

`finalizeDelivery` idempotent: ledger موجود ⇒ تخطٍّ؛ سطر jsonl سليم موجود ⇒ إصلاح ledger فقط
(لا حقن ثانٍ)؛ لا ledger ولا سطر سليم ⇒ حقن ثم ledger. تكراره N مرّة ⇒ handoffId واحد (المعيار 4).

**دليل الحقل الأرضي (ground truth) في المعيار 6:** عدد التسليمات = عدد **أسطر handoff الصحيحة**
في jsonl، لا عدّ أحداث السجل — لأن مراقباً يُقتَل **داخل** فجوة الحقن→ledger يكون قد حقن السطر
لكنه مات قبل تسجيل حدثه؛ فالسطر الصحيح هو الحقيقة القاطعة. عبر 15 محاولة (5 منها قتل مُصوَّب
داخل الفجوة) ⇒ 15/15 تسليم مفرد، صفر مزدوج، صفر ضائع.

`bin/supervisor-run.sh` يأخذ `flock(2)` على `supervisor.lock` عبر fd 9 المُورَّث عبر `exec node`،
والنواة تحرّره عند أي موت (**بما فيه `kill -9`**) ⇒ restart يعيد الأخذ نظيفاً بلا قفل عالق (المعيار 6)،
ومثيلان متزامنان ⇒ واحد يعمل والآخر يخرج بهدوء (المعيار 7).

## التشغيل — جانب المستهلك (re-run)

```bash
# الكل (المعيار 6 يستهلك حصة: ~15 مهمة haiku صغيرة؛ 4/5/7 بلا LLM)
bash spikes/b103-t819/tests/run-consumer.sh

# المعايير 4/5/7 — بلا LLM إطلاقاً (على fixtures حقيقية مُودَعة)
STATE_ROOT=/tmp/b103-verify-c4 bash spikes/b103-t819/tests/criterion4-idempotency.sh
STATE_ROOT=/tmp/b103-verify-c5 bash spikes/b103-t819/tests/criterion5-torn-jsonl.sh
STATE_ROOT=/tmp/b103-verify-c7 bash spikes/b103-t819/tests/criterion7-flock.sh

# المعيار 6 وحده — يستهلك حصة haiku (يمكن تقطيعه: FROM/TO عبر C6_ROOT ثابت)
STATE_ROOT=/tmp/b103-verify-c6 bash spikes/b103-t819/tests/criterion6-supervisor-resilience.sh
# تقطيع يدوي (مثال): FROM=1 TO=5 و FROM=6 TO=10 و FROM=11 TO=15، ثابتاً C6_ROOT=/tmp/vc6/c6
```

## انحرافات موثّقة عن §أ/§و (justified deviations)

1. **`--unit=wf-*.service` عابرة لا `--scope` حرفياً:** اتّباعاً للكود المعتمد
   (`server/modules/workflow-supervisor/config.ts:91-102`) الذي يصحّح `--scope` التوضيحي في ADR
   لأنه **يحجب** المُطلِق. الخدمة العابرة ترجع فوراً وتُعمّر بعد المُطلِق = ضمان الصمود عينه.
2. **مسار كتابة واحد مشترك:** الحيّ (`--finalize`) والاختبار (`--replay`) يبلغان `result.json`
   عبر `seal()` نفسها — تحقيقاً لشرط «مسار الكتابة نفسه» في المعيار 2. الفرق الوحيد أن `--replay`
   يكتب `.partial` بنفسه لحقن الإزاحة؛ ضمانة الذرّية كلها في `seal()` (rename+DONE) وهي byte-identical.
3. **hooks اختبارية موثّقة:** `--kill-at-offset` (معيار 2)، `--widen-window-ms` (معيار 3، يوسّع نافذة
   rename→DONE لضمان الإصابة)، `--skip-done` (فرع PARTIAL-untrusted). كلها test-only ولا تُغيّر مسار الحيّ.
4. **grace=2000ms في الاختبارات** لتقصير الزمن؛ افتراض التصميم `RECONCILE_GRACE_MS≈10s`. الضمان
   (حسم بعد المهلة، لا تعليق) مستقلّ عن القيمة.
5. **flock عبر أمر `flock(2)`** (fd 9 مُورَّث عبر `exec node`) لا قفل داخل node — لأن node لا يوفّر
   flock مضمَّناً؛ النواة تحرّره على أي موت (مطابق لدلالة القفل في §ب-2، ونمط runner القائم).
6. **hooks استهلاكية موثّقة (test-only):** `tearAtOffset` (حقن نصف-مكتوب حقيقي بـ SIGKILL ذاتي أثناء
   الإلحاق — نظير `--kill-at-offset`)، `widenMs` + `SUPERVISOR_MARK_INJECT` (توسيع فجوة الحقن→ledger
   وتعليمها لقتل مُصوَّب — نظير `--widen-window-ms`)، `matcher=regex` (شاهد سالب يُثبت فشل regex).
7. **حارس السطر الجديد في الحقن (تصحيح حقيقي لا مجرّد اختبار):** الإلحاق بعد سطر ممزّق (بلا `\n` ختامي)
   كان يُلصِق السطر الجديد على الشظيّة فيُفسده؛ فصار الحقن يبدأ سطراً جديداً إن لم ينتهِ الملف بـ`\n`.
   كشفه المعيار 5 — درسٌ يُرحَّل لـ`result-capture.ts`/`handoff-injector.ts` في المرحلة 3.

## قيود التشغيل (احترامها إلزامي)

- كل `claude -p` يعمل في **cwd مؤقت تحت `/tmp`** (لا cwd مشروع) — درس تلوّث الجلسات اليتيمة.
- الوحدات العابرة تُنظَّف (`reset-failed`) بعد كل تشغيل؛ حالة `/tmp` قابلة للحذف بأمان.
- عزل الاعتماد عبر `--setenv CLAUDE_CONFIG_DIR` (هنا = مستخدم التشغيل).
