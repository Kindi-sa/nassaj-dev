# خطة تنفيذ v1.35 + B-107 + i18n — للمحادثة التنفيذية الجديدة

> **الغرض:** المرجع الأول الذي تقرؤه محادثة التنفيذ النظيفة. كُتب في جلسة تحديد-وتهيئة (2026-06-30) بعد حسم T-242 (لجنة ثلاثية) وجمع كل الحقائق، **ومُراجَع بفيتو qa-critic (APPROVE-مع-تعديلات، التعديلات مطبَّقة هنا — §9).** التنفيذ لم يبدأ بعد.
> **الفرع:** `integration/publish` · cwd `/home/nassaj/Project/nassaj-dev` · الخادم حيّ pm2 `nassaj-dev` PORT 3004.

---

## 0. الفصل الجوهري — محادثتان لا واحدة

| | محادثة التنفيذ 1 (أولاً) | محادثة التنفيذ 2 (لاحقاً) |
|---|---|---|
| النطاق | **v1.35 + B-107 + i18n** | **T-242 (أ)** |
| الطبقة | **عميل فقط** (frontend/locale/test) | **خادمي** (claude-sdk.js + services) |
| النشر | `npm run build:client` **بلا restart** | `build:server` + **restart المالك** بطرفيته |
| الحاجز على المالك | لا | نعم (`bash scripts/safe-restart.sh --exec`) |
| المواصفة | هذا المستند (WS-A..G) | `PHASE-T242.md` §8 |

سبب الفصل: v1.35/B-107 عميل-فقط (ADR-050: «كلها build:client بلا restart») فلا تحجب المالك؛ T-242 خادمي حسّاس يلمس `claude-sdk.js` + restart + إعادة مراجعة qa-critic.

---

## 1. ⛔ ضوابط حرجة (تُقرأ قبل أي تفويض)

1. **حارس منع توالد الوكلاء (حرفياً في كل prompt وكيل):**
   > «نفّذ هذه المهمة بنفسك عبر Read/Edit/Write/Bash فقط. **ممنوع منعاً باتّاً إطلاق أي وكيل فرعي (لا تستخدم أداة Agent).** إن كانت كبيرة، نفّذها على دفعات بنفسك ولا تفوّضها.»
   السبب: حادثة P2 (2026-06-30) — `frontend-dev` بأداة Agent توالد recursively وأهدر ~580k توكن بصفر كتابة.
2. **تحقّق من القرص لا من الادّعاء:** بعد كل وكيل، المنسّق يتحقّق بنفسه: `git status` + `git diff --stat` + JSON صالح + إعادة تشغيل البوابة (`npm run typecheck` أو `node scripts/i18n-gap-scan.cjs`). رسائل «اكتمل/يمرّ» تكذب. **وعودة وكيل بصفر كتابة على القرص (`git status` نظيف) = فشل وإعادة تنفيذ ذاتي فوري — لا إعادة تفويض لوكيل آخر** (درس P2 الحرفي).
3. **ملفات مشتركة = وكيل واحد:** i18n **وكيل/لغة** (ملفات منفصلة = لا سباق). لا تُسنِد ملفاً واحداً لوكيلين (حادثة B-96/B-97).
4. **بروتوكول الجلسات المتوازية:** قبل أي commit: `git status` ثم `git diff --stat`. `git add` بأسماء فقط — **ممنوع `-A`/`.`**. ملف معدَّل لم تلمسه الجلسة لا يُضمّ ويُسأل عنه.
5. **النشر:** `build:client` للواجهة بلا restart. لا `build:server` في محادثة 1. إن قلّم `NODE_ENV=production` الـdevDeps → `npm install --include=dev` ثم أعِد البناء.
6. **حصة/موارد قبل أي إطلاق:** `node ~/.claude/scripts/claude-usage.js` (توقّف ≥90%) + موارد < 80%.
7. **push:** المالك أذن صراحةً بـ`git push` لـ`integration/publish`. يُستثنى ما عداه (ريبو/PR/secrets جديدة).

---

## 2. حالة الانطلاق (مُتحقَّقة 2026-06-30)

- **git:** متقدّم على `origin/integration/publish` بـ**5 commits** غير مدفوعة (`1b732c8e` handoff، `761f87d4` board، `6d509f78` B-106، `e126642d` board، `366c8452` B-105). متأخّر 0.
- **غير مُلتزَم — كود v1.35 شرعي (يلتزمه WS-A):** `QuestionAnswerContent.tsx` (#920/W1)، `chatFormatting.ts` (#903/W2-regex)، `ar/sidebar.json` + `en/sidebar.json` (#896/W2-i18n)؛ + غير متعقَّب `QuestionAnswerContent.test.tsx`. (qa-critic أكّد: شرعية لا بقايا P2.)
- **غير مُلتزَم — توثيق/تهيئة (التزمته جلسة التحديد في commit توثيقي منفصل، ليس ضمن كود WS-A):** `PHASE-T242.md` (+§8)، `EXECUTION-PLAN-v1.35.md` (هذا)، `i18n-gap-manifest.{json,md}`، `scripts/i18n-gap-scan.cjs`.
- **قرار §8:** `docs/planning/provider-capabilities/PLAN-v1.md` (ناتج ورشة `wf_ef5ba242` شرعي، 53KB)؛ نسخ `dist.bak*`/`*.predeploy*` (لا تُلتزَم).
- **typecheck:** أحمر بـ3 أخطاء (B-107، WS-B).

---

## 3. WS-A — التزام كود v1.35 الجاهز (W1 + W2)

**الوكيل:** frontend-dev (+ الحارس). **النموذج:** sonnet. **النطاق:** مراجعة + التزام الموجود (لا إعادة كتابة):
- `#920` (W1): `QuestionAnswerContent.tsx` + `QuestionAnswerContent.test.tsx` — تحصين `Array.isArray`/فلترة `options`/`answer` ضد payload مشوّه (يطابق upstream `ed4ae311`).
- `#903` (W2-regex): `chatFormatting.ts` — `[ \t]` بدل `\s` (يطابق `4712431b`، سطر واحد).
- `#896` (W2-i18n): `{ar,en}/sidebar.json` — مفاتيح `sidebar.messages`.
**التحقّق:** `npm run test` لـ`QuestionAnswerContent.test.tsx` يمرّ + JSON صالح. **الالتزام:** Conventional Commits، ملفات مُسمّاة.

---

## 4. WS-B — إصلاح B-107 typecheck (آلي، دقيق). تبعية: لا. (يجب أن يخضرّ قبل WS-C)

**الوكيل:** frontend-dev (+ الحارس). **النموذج:** sonnet.
**3 تعديلات (مُؤكَّدة من typecheck + qa-critic):**
1. `src/components/chat/hooks/useChatProviderState.ts:37` — `FALLBACK_DEFAULT_MODEL` تنقص `hermes`+`sakana`. **الأفضل (qa-critic م-1): استورد `FALLBACK_DEFAULT_MODEL` كاملةً من `src/constants/providerModelFallbacks.ts` (مصدر واحد) بدل الخريطة اليدوية** — فهذا يصلح أيضاً علّة `claude:'opus'` المعروفة (الصحيح `'default'`، انظر تعليق `providerModelFallbacks.ts:790-793`). إن رُفض توسيع النطاق: أضِف `hermes: HERMES_FALLBACK_MODELS.DEFAULT` + `sakana: PLACEHOLDER_FALLBACK_MODELS.DEFAULT` **وسجّل `claude:'opus'` كـissue معروف صراحةً** (لا تتركها تُعدّ مُصلَحة ضمناً).
2. `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx:275` — `modelByProvider` تنقص `sakana` فقط (hermes موجود). أضِف `sakana`.
3. `src/stores/useSessionStore.test.ts:27` — `provider: 'anthropic'` غير صالح → `'claude'` (الـunion يحوي `claude` لا `anthropic`).
**التحقّق الإلزامي:** `npm run typecheck` **أخضر (exit 0)**. المنسّق يعيد تشغيله بنفسه.

---

## 5. WS-C — نقل #933 معاينة الوسائط من upstream. **تبعية: WS-B (typecheck أخضر أولاً)**

**الوكيل:** frontend-dev (+ الحارس). **النموذج:** sonnet (أو opus إن تعقّد الدمج).
**سبب التبعية (qa-critic م-3):** بوابة WS-C = typecheck أخضر؛ إن جرى مع typecheck أحمر بأخطاء B-107 الموروثة، يتعذّر تمييز أخطاء WS-C → إغلاق كاذب. لا تبدأ WS-C حتى يخضرّ B-107.
**القرار:** ADR-050 — يُؤخَذ #933 من upstream (**ليس بناءً من الصفر**).
**الـcommits المرجعية (`git show <sha>`):** `2ebe64f2` (#933 الأساس)، `6d5ed6fd` (تحصين SVG XSS + a11y — **أمنيّ إلزامي**)، `e39de299` (منع معاينة قديمة عند تبديل الملفات)، `92b5b935` (ملاحظات مراجعة).
**المتوقَّع (ADR-050):** ملفان جديدان `CodeEditorMediaPreview.tsx` + `utils/previewableFile.ts` (مؤكَّد غيابهما) + تعديلات صغيرة على `CodeEditor`/`Header`/`useCodeEditorDocument` + مفاتيح `ar`.
**ضوابط:** لا تأخذ المرفوضات (Gemini catalog، unified-gateway، restart-skew #898). احفظ تحصين SVG XSS.
**التحقّق:** typecheck أخضر + `build:client` ينجح + معاينة صورة/فيديو/HTML تعمل.

---

## 6. WS-D — سدّ فجوة i18n للّغات السبع (الجهد الأكبر). تبعية: لا (متوازٍ مع A/B)

**الوكلاء:** **frontend-dev واحد لكل لغة** (7 متوازين، + الحارس). **النموذج:** sonnet (صعّد opus لـja/ko/zh-CN إن لزم). كل وكيل يملك **ملفات لغته فقط** = لا سباق.
**المصدر الحتمي:** `docs/workitems/i18n-gap-manifest.json` — قوائم المفاتيح الناقصة/الـorphan/غير المترجَمة **لكل لغة/namespace**. **هذا الـJSON هو المصدر، لا الملخّص النثري أدناه.** المرجع `en` (1608 مفتاحاً، 9 namespaces). السكربت المُلتزَم: `scripts/i18n-gap-scan.cjs`.
**مهمة كل وكيل (للّغة L):**
1. أنشئ الملفات المفقودة من `en`: `presence.json` (السبع)، `tasks.json` (`ko`+`zh-CN`).
2. املأ كل `missingKeys` في `manifest.languages[L]` بترجمة L صحيحة (لا إنجليزية).
3. أعد ترجمة `untranslatedKeys` (قيمتها = en): أبرزها `projectBoard.json` (مترجَم صفر)، `settings.profile.passkeys`، `sidebar.{systemStats,sessionProcessState,upstream}`.
4. **احذف/أصلِح `orphanKeys`** (مفاتيح في L ليست في en): أبرزها **`ja/sidebar.json` `sessionCount` المفرد → استبدله بـ`sessionCount_one`/`_other`** (احذف المفرد القديم بعد إضافة الجمع، وإلا بقي فاسداً رغم `missing=0`). راجِع `orphanKeys` كل لغة في المانيفست (de=1, ja=2, ko=1, ru=3, zh-CN=1).
5. حالات خاصة (المصدر = المانيفست): `ja/chat.json` ينقصه `gemini` + `providerSelection.providerInfo.google` (**ملاحظة: `claudeStatus` موجود فعلاً في ja — لا تضِفه**).
**البوابة (إلزامية بعد كل وكيل):** المنسّق يعيد `node scripts/i18n-gap-scan.cjs` ويؤكّد للّغة **`missing=0` AND `orphan=0`** + كل JSON صالح. لا تُغلق اللغة حتى تُستوفى الشرطان. (`missing=0 + orphan=0` يضمن **التغطية** لا **صحّة الترجمة**؛ الموجة 2/مراجعة عيّنية بشرية لاحقاً.)
**الحجم/التقسيم (قرار §8):** ~3536 ناقص + 8 orphan + ~1451 untranslated. يجوز موجتان: **م1 = الناقص + الorphan** (سدّ وظيفي)، **م2 = إعادة ترجمة untranslated** (جودة). م1 أولاً.

---

## 7. WS-E/F/G — تنظيف + بناء + نشر

- **WS-E تنظيف:** `dist.bak-*` + `dist*.predeploy-*` غير متعقَّبة — احذف (`rm -rf`) أو `.gitignore` (قرار §8). `docs/planning/` قرار §8.
- **WS-F بناء:** `npm run build:client` فقط (لا restart). تحقّق حيّاً على `https://nassaj.alkindy.tech` (لا localhost). NODE_ENV قلّم devDeps → `npm install --include=dev` ثم أعِد.
- **WS-G نشر:** `git push origin integration/publish` (الـ5 commits + commits WS-A..E + commit التوثيق). تحقّق `git status` = up to date.

---

## 8. قرارات تنتظر المالك

1. **حجم i18n (WS-D):** (i) سدّ كامل الآن، أم (ii) الموجة 1 فقط (ناقص+orphan) الآن وتأجيل إعادة الترجمة، أم (iii) لغات أولوية؟ — **توصية: الموجة 1 كاملة ثم الموجة 2 لاحقاً.**
2. **`docs/planning/provider-capabilities/PLAN-v1.md`:** التزام توثيقي أم ترك للمبادرة؟ — **توصية: التزام في commit توثيقي منفصل.**
3. **نسخ `dist.bak*`/`*.predeploy*`:** حذف أم `.gitignore`؟ — **توصية: حذف.**

---

## 9. مراجعة qa-critic — APPROVE-مع-تعديلات (التعديلات مطبَّقة)

**الحكم:** APPROVE-مع-تعديلات. تحقّق qa-critic كوداً من: شرعية W1/W2، صحّة B-107 (`providerModelFallbacks.ts:795` صالح، `'claude'` بديل صحيح)، وجود commits #933، ودقّة كل مراجع T-242 §8، وسدّ الشروط الخمسة لفيتو #1. **التعديلات الإلزامية الخمسة + الموصاتان طُبِّقت في هذه النسخة:**
1. ✅ سكربت i18n نُقل من `/tmp` إلى `scripts/i18n-gap-scan.cjs` (مُلتزَم) — بوابة دائمة لا متبخّرة.
2. ✅ بوابة WS-D = `missing=0 AND orphan=0` (يكشف `ja sessionCount` المفرد الفاسد) + بند حذف المفرد.
3. ✅ صُحّح §6.4: `claudeStatus` موجود في ja (حُذف من النواقص)؛ المصدر الحتمي = المانيفست JSON.
4. ✅ §2 يجرد ملفات التوثيق ويشترط commit توثيقي منفصل عن كود WS-A.
5. ✅ WS-C تابعة لـWS-B (typecheck أخضر أولاً).
6. ✅ WS-B: استيراد الخريطة من المصدر الواحد أو تسجيل `claude:'opus'` كissue.
7. ✅ §1.2: صفر كتابة على القرص = إعادة ذاتية لا إعادة تفويض.

**جاهزة للتنفيذ.**

---

## 10. T-242 (محادثة التنفيذ 2) — مرجع

المواصفة الكاملة في `PHASE-T242.md` §8. خلاصة: مصدر حياة pid حقيقي (child pid عبر runTag + `/proc/<pid>/stat` state∉{Z,X} + إعادة تحقّق environ-tag)، إصلاح علّة `unregisterSessionProcess` في `claude-sdk.js:796`، 5 شروط + 4 فخاخ، fixtures من `wf_ef5ba242` الحقيقي (`/home/nassaj/nassaj-core/projects/-home-nassaj-Project-nassaj-dev/230ab538-223e-48f5-b505-e69ac902f541/subagents/workflows/wf_ef5ba242-b4b/journal.jsonl`)، إعادة مراجعة qa-critic. **حتى تُنفَّذ: التصميم القديم يبقى `rejected`.**
