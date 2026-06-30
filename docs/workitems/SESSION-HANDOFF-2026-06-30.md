# تقرير إغلاق جلسة 2026-06-30 + كتالوج المشاكل (تمهيد لجلسة الإصلاح)

> الفرع: `integration/publish` · cwd: `/home/nassaj/Project/nassaj-dev` · الخادم الحيّ: pm2 `nassaj-dev` pid 1619100، PORT 3004، online، unstable=0.
> الغرض: توثيق ما أُنجز وما تعطّل بدقّة، تمهيداً لجلسة جديدة تنفّذ: (1) تخطيط إصلاح، (2) مراجعة نقدية، (3) تنفيذ، (4) نشر على GitHub.

---

## 1. ما أُنجز ونُشر حيّاً (لا يُعاد)

| البند | الحالة |
|---|---|
| **B-105** (IDOR قراءة رسائل الجلسات) | commit `366c8452` + اختبار 5/5 (أعاده المنسّق) + dist-server 13:17 + restart المالك → **حيّ** (curl `/api/providers/sessions/x/messages` بلا توكن = 401) |
| **B-106** (IDOR بحث الجلسات) | commit `6d509f78` + **qa-critic APPROVE** (mutation test أثبت الاختبار حقيقياً + fixtures إنتاجية) + اختبار 4/4 (أعاده المنسّق) + نفس البناء → **حيّ** (curl `/api/providers/search/sessions` = 401) |
| **B-104** (انحراف T-235 الخادمي) | مُغلق بالـrestart (dist-server 13:17 يحوي T-235) |
| **اللوحة** | محدَّثة ومُلتزَمة (`761f87d4`): B-105/B-106 fixed، B-104 resolved، B-107 logged |
| **توثيق** | `docs/workitems/PHASE-T242.md` (تصميم T-242، **مرفوض** — انظر P1) · `~/.claude/.../memory/feedback_agent_recursive_delegation.md` |
| **تدقيق أمني** | `scripts/safe-restart.sh` = **SAFE** (qa-critic، سطراً بسطر) |

البناء كان build #2 (dist-server 13:17:13) يضمّ B-105 + B-106 + T-235؛ المنسّق تحقّق من الناتج المبني ومن الحياة (uptime جديد + 401 + بصمة الكود).

---

## 2. حالة git الدقيقة

- **متقدّم على origin بـ4 commits غير مدفوعة:** `761f87d4` (board)، `6d509f78` (B-106)، `e126642d` (board)، `366c8452` (B-105). origin tip = `f13914e6` (T-235 مدفوع سابقاً).
- **غير مُلتزَم (عمل v1.35 ‏W1/W2):** `src/components/chat/tools/components/ContentRenderers/QuestionAnswerContent.tsx`، `src/components/chat/utils/chatFormatting.ts`، `src/i18n/locales/ar/sidebar.json`، `src/i18n/locales/en/sidebar.json`.
- **غير متعقَّب:** `docs/workitems/PHASE-T242.md` (تصميم — يُلتزَم مع هذا التقرير) · `docs/workitems/SESSION-HANDOFF-2026-06-30.md` (هذا الملف) · `src/.../QuestionAnswerContent.test.tsx` (اختبار W1) · `docs/planning/` (**مجهول المصدر — يُفحَص لا يُلتزَم أعمى**) · نسخ `dist.bak*`/`dist*.predeploy*` (**لا تُلتزَم**).
- **i18n: اللغات السبع لم تُمَسّ** — الحلقة الهاربة كتبت صفراً (مؤكَّد `git status -- src/i18n/locales/` = ar+en فقط، من W1/W2).

---

## 3. المشاكل (بدقّة) — جوهر التقرير

### P1 — [حرج/تصميم] T-242: تصميم مرفوض بفيتو qa-critic — لا مصدر حياة موثوق للعمل الخلفي
- **الملف:** `docs/workitems/PHASE-T242.md`. **مراجع الكود:** `server/claude-sdk.js:1568, 1715-1718, 1919-1922, 791-800`.
- **الجوهر:** التصميم اعتمد `isClaudeSDKSessionActive` مصدرَ حياة، لكنه **لا يرى الـworkflow الخلفي بعد انتهاء دور المنسّق** — لأن `removeSession` يُستدعى عند نهاية حلقة `for-await` (1717) لا عند انتهاء الـworkflow. حينها: `activeSessions` فارغ + registry مطفأ (`SESSION_REGISTRY_claude`) + mirrors=0 → التصنيف يهبط إلى `mtime/QUIET` **المرفوض في الفيتو الأصلي**.
- **الحقيقة البنيوية:** لا يوجد اليوم **أي سجلّ حياة لعمليات الـworkflow** (لا pid tracking ولا workflowProcesses؛ `session-process-monitor` مرتبط بالجلسة ويُفكَّك في `removeSession:796`). هذا جوهر «مشكلة B».
- **القرار المطلوب (مالك):** (أ) بناء تتبّع حياة حقيقي — سجلّ workflows نشطة يُفتح عند إطلاق Workflow ويُغلق عند `result` في journal، أو pid + `kill(pid,0)` (الأمتن، بند backend جديد)؛ (ب) معيار زمني معاير `QUIET≥180s` موثَّق وصريح (الأبسط، لكنه ما رفضه الفيتو)؛ (ج) تأجيل T-242.
- **ملاحظات الفيتو الإضافية:** اختبار B5 سيكون fixture مصطنع يُثبت ادعاءً كاذباً ما لم يشمل حالة «المنسّق انتهى + workflow حيّ» من transcript فعلي؛ سقف مسح الـendpoint غير معرَّف القيمة/السلوك.
- **المُحتفَظ به سليماً (لا يُعاد تصميمه):** #3 (التصنيف في `fetchHistory`)، #5 (عزل per-user يرث B-105)، #6 (عدم مسّ reconcile)، البنود F1-F3.

### P2 — [عملياتي/حاد] #896 i18n: حلقة تفويض هاربة — صفر إنتاج، هدر ضخم
- **ما حدث:** أُطلق `frontend-dev` واحد لـ#896 (يملك أداة Agent)، فتصرّف كمنسّق وتوالد recursively: `af986d2 → a9a2ebc → aaa64ef → «4 وكلاء قراءة»` (`ad0974e2, a1666a6a, a35cba3c, af596a49`) يقرؤون ويخطّطون ويُفرّغون محتوى الملفات الكامل في الإشعارات.
- **الأثر:** ~580k توكن مهدور + إغراق سياق المنسّق، و**صفر كتابة على القرص** (مؤكَّد `git` 3 مرّات).
- **الجذر:** مهمة كبيرة + أداة Agent متاحة للوكيل → غريزة التفويض.
- **الدرس (محفوظ في memory):** قسّم i18n حسب اللغة (وكيل/locale، ملفات منفصلة = لا سباق)؛ امنع التوالد صراحةً في الـprompt؛ تحقّق من القرص لا من رسالة «اكتمل».

### P3 — [عمل متبقٍّ، مُحدَّد بدقّة] فجوة i18n الفعلية (ما كان #896 يُفترض أن يصلحه)
بيانات مُستخرَجة فعلياً من فحص القرص + dumps وكلاء القراءة (مرجع ثمين للإصلاح):
- en = **9 namespaces، 1608 مفتاحاً**. نقص المفاتيح لكل لغة: `de 479 · it 466 · ja 495 · ko 576 · ru 479 · tr 466 · zh-CN 575`.
- **ملفات مفقودة:** `presence.json` في السبع جميعاً؛ `tasks.json` في `ko` + `zh-CN`.
- **`projectBoard.json`:** السبع كلها **إنجليزية غير مترجمة** (149 سطراً متطابقة) — موجودة لكن تحتاج ترجمة لا مجرّد ملء مفاتيح.
- **`codeEditor.json`:** `ja/ko/zh-CN` ينقصها `actions.previewMarkdown` + `actions.editMarkdown`.
- **`settings.json`:** كتلة `profile.passkeys` إنجليزية في السبع.
- **`common.json`:** `de` + `ru` ينقصها قسم `notifications`.
- **`sidebar.json`:** `systemStats` (cpuUsage/memoryUsage) + `sessionProcessState` (running/frozen/*Hint) + `upstream.*` إنجليزية عبر اللغات.
- **`ja/sidebar.json`:** يستخدم `sessionCount` (مفرد) بدل `sessionCount_one/_other`.
- **`ja/chat.json`:** ينقصه قسم `gemini` + `providerSelection.providerInfo.google`؛ و`claudeStatus` (actions/state/elapsed/controls) إنجليزية جزئياً في `ja/ko/zh-CN`.

### P4 — [متوسط] B-107: typecheck العميل أحمر (مُسجَّل باللوحة)
- `npm run typecheck` أحمر بـ3 أخطاء كلها في `src/`: `useChatProviderState.ts:37` + `ProviderSelectionEmptyState.tsx:275` (خريطتا `Record<LLMProvider,string>` ناقصتان hermes+sakana) + `useSessionStore.test.ts:27` (`'anthropic'` ليس `LLMProvider` صالحاً).
- **ليس حاجز بناء** (build:server خادم فقط؛ build:client=vite/esbuild لا يفحص الأنواع) لكنه عيب نوعي حقيقي → يُصلَح قبل build:client لـv1.35.

### P5 — [عمل متبقٍّ] v1.35 غير مكتمل
- W1(#920) + W2-regex(#903) على القرص (الملفات الأربعة + الاختبار) **غير مُلتزَمة**.
- W2-i18n (#896): غير منجَز (P2/P3).
- W3 (#933 معاينة الوسائط): **لم يبدأ**.
- B-107: لم يُصلَح.
- ثم build:client + commit + deploy (الواجهة تكفيها build:client بلا restart).

### P6 — [تنظيف] الشجرة غير المُلتزَمة
- الملفات الأربعة + `QuestionAnswerContent.test.tsx` = عمل v1.35 شرعي → يُراجَع ويُلتزَم.
- `docs/planning/` (مجهول): يُفحَص قبل أي التزام (قد يكون من جلسة أخرى — بروتوكول الجلسات المتوازية).
- نسخ `dist.bak*`/`*.predeploy*`: لا تُلتزَم؛ يُنظر في حذفها.

### P7 — [تنبيه أداة] `AskUserQuestion` فشلت مرّة («Stream closed») وسط طوفان إشعارات الحلقة الهاربة — استُبدلت بسؤال نصّي.

---

## 4. الخطة المطلوبة للجلسة الجديدة (الخطوات الأربع)
1. **تخطيط إصلاح كل المشاكل (P1–P6):** يبدأ بقرار T-242 (أ/ب/ج)؛ ثم خطة #896 بضوابط (وكيل/لغة + منع توالد)؛ #933؛ B-107؛ التزام v1.35؛ تنظيف الشجرة.
2. **مراجعة نقدية للخطة** (qa-critic بفيتو قبل التنفيذ).
3. **التنفيذ** (وكلاء متخصّصون؛ تحقّق ذاتي من القرص/الاختبار بعد كلٍّ).
4. **النشر على GitHub «مع كل العمل السابق»** = `git push` للـ4 commits الأمنية غير المدفوعة + commits الجلسة الجديدة. (المالك أذن صراحةً بالـpush في طلبه — استثناء قاعدة «push بإذن صريح».)

---

## 5. ضوابط/دروس ملزمة للجلسة الجديدة
- **منع توالد الوكلاء:** لأي مهمة تُفوَّض لوكيل يملك أداة Agent، أضف صراحةً «نفّذ بنفسك عبر Write/Edit، ممنوع إطلاق وكلاء فرعيين». قسّم i18n حسب اللغة.
- **تحقّق من القرص لا الادّعاء:** `git status` + فحص JSON/المفاتيح بعد كل وكيل (رسائل «اكتمل» تكذب).
- **fixtures إنتاجية لا مصطنعة** (خاصة T-242 B5).
- **بوّابات النشر:** build:server خادم فقط؛ build:client بلا restart للواجهة؛ restart عبر `bash scripts/safe-restart.sh --exec` بطرفية المالك (حارس العميل يحجب pm2)؛ NODE_ENV → `--include=dev` إن قلّم devDeps.
- **حصة/موارد:** افحص `node ~/.claude/scripts/claude-usage.js` قبل أي إطلاق. هذه الجلسة بلغت ~41% جلسة / 53% أسبوع وسياقاً مُثقَلاً بالحلقة الهاربة → **ابدأ الجلسة الجديدة بسياق نظيف**.

---

## 6. الخلاصة
الأمن (الأهمّ) مُنجَز ومنشور حيّاً ومُتحقَّق ومُلتزَم محلياً. المتبقّي: قرار+تنفيذ T-242، إكمال v1.35 (#896/#933/B-107 + التزام W1/W2)، تنظيف الشجرة، والنشر على GitHub. كله مُوثَّق هنا وقابل للاستئناف نظيفاً في جلسة جديدة.
