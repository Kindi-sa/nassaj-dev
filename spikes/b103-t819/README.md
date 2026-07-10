# T-819 — spike الإثبات: جانب المنتِج (B-103 النموذج اللاتزامني)

> Producer-side proof spike for the B-103 async-agent model. Scope: **§و acceptance
> criteria 1, 2, 3 only** (result capture). Consumer side (4-5), monitor (6-7), and soak (8)
> are a later wave. Nothing here touches live server code, builds, or PM2.
>
> المرجع: `docs/plans/B-103-ASYNC-AGENTS-DESIGN-2026-07-10.md` (§أ المخطط/دورة الحياة/الذرّية،
> §و/المرحلة 1) + `docs/plans/B-103-SYSTEMS-CONSOLIDATION-AUDIT-2026-07-10.md`.

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
lib/capture-writer.mjs     مسار الكتابة الذرّي الوحيد (finalize/replay + hooks)
lib/classifier.mjs         تصنيف §أ-3 (يقرأ الملفات + is-active)
lib/aggregate-evidence.mjs يدمج الملخّصات → evidence/producer.json
bin/run-task.sh            يُطلق wf-<taskId>.service عبر systemd-run --user
bin/task-inner.sh          يعمل داخل الوحدة: claude -p → capture-writer --finalize
tests/criterion{1,2,3}-*.sh  المعايير الثلاثة
tests/run-all.sh           المنسّق (يكتب الأدلة)
fixtures/*.json            stdout حقيقي مُلتقَط (للمعيار 2، بلا LLM)
evidence/producer.json     ملخّص آلي تعتمد عليه الموجة التالية
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

## قيود التشغيل (احترامها إلزامي)

- كل `claude -p` يعمل في **cwd مؤقت تحت `/tmp`** (لا cwd مشروع) — درس تلوّث الجلسات اليتيمة.
- الوحدات العابرة تُنظَّف (`reset-failed`) بعد كل تشغيل؛ حالة `/tmp` قابلة للحذف بأمان.
- عزل الاعتماد عبر `--setenv CLAUDE_CONFIG_DIR` (هنا = مستخدم التشغيل).
