# ADR-048 — تصحيح حالة المهمة الخلفية (Workflow Completion Reconcile)

- الحالة: Proposed (تصميم architect، بانتظار اعتماد المنسّق/المالك ثم تنفيذ backend-dev)
- التاريخ: 2026-06-27
- الصلة: حادثة 2026-06-27 (wf_ef5ba242-b4b)، B-N-DRAIN (ADR-021/022)، ADR-041 (live replay)، ADR-042 (ghost detach)، B-94 (regex إشعار المهمة)، B-95 (ecosystem)

## Context

workflow خلفي (أداة `Workflow`) يُطلق من جلسة Claude عبر SDK. عند `restart` للسيرفر، `treekill:false`
يُبقي وكلاء الـworkflow أحياءً (orphans) فيكملون عملهم ويكتبون `result` في
`<sessionDir>/subagents/workflows/wf_*/journal.jsonl`. لكن دالة الـdrain
(`countActiveSessionsByProvider` في `server/index.js:~2098`) تعدّ جلسات المزوّدات **في الذاكرة فقط**
ولا ترى الـworkflows، فالعملية الأم تخرج فوراً والجلسة البديلة تُصدر إشعار `run.stopped` (صادق
وقته لكنه سابق لاكتمال العمل) **دون أي آلية تصحيح لاحقة**. النتيجة: انفصام رؤية — العمل يكتمل
على القرص بينما الواجهة تعرض «توقّف». لا فقدان عمل.

الجذر في طبقة Claude Code SDK (لا تتبّع اكتمال للـworkflow عبر إعادة التشغيل). نسّاج لا يملك
تعديل الـSDK؛ يصحّح بطبقته اعتماداً على أثر القرص الذي يتركه الـSDK (journal.jsonl).

حقائق أرضية مُتحقَّق منها (قراءة كود + قرص فعلي، 2026-06-27):
- `journal.jsonl`: سطور `{type:"started",key,agentId}` و`{type:"result",key,agentId,result}`؛ المطابقة
  بحقل `key` (تجزئة محتوى)، والاكتمال = **لكل `started.key` يوجد `result.key` مطابق** (مكافئ
  `count(started)==count(result)` ما لم تتكرر المفاتيح). في الحادثة 17 started / 15 result.
- `result.result` = `{sectionId,title,content}` — **لا يوجد حقل `path`**؛ ملف الخرج (PLAN-v1.md)
  يُجمَّع بطبقة أعلى، فلا يصلح كإشارة اكتمال مباشرة.
- `getSessionMessages` (`claude-sessions.provider.ts:125`) هو مسار قراءة الجلسة عند الفتح/الاستئناف،
  ويمشي أصلاً مجلد `subagents/` المجاور — مَفصِل الإدماج الطبيعي.
- إشعار `run.stopped` يُكتب صفّاً JSONL حقيقياً في الـtranscript (`<task-notification>`) ويُعاد تحليله
  في كل فتح جلسة على الواجهة بـ`taskNotifRegex` (`useChatMessages.ts:109`) الذي **يُلزم `<output-file>`**؛
  إشعار stopped يحمل `<tool-use-id>` فيسقط لنصّ خام (B-94).
- `complete` يحمل `pendingWorkflows` = **عدد** استدعاءات أداة `Workflow` في الدور، لا تتبّع اكتمال.
- مسار الـtranscript الصحيح يأتي من `sessionsDb.getSessionById(sessionId).jsonl_path` (لا يُعاد بناؤه يدوياً).

## Alternatives

1. **مراقبة حيّة لمجلد الـworkflows (watcher دائم)** يبثّ تصحيحاً لحظة كتابة آخر `result`.
   - مرفوض الآن: اقتران دائم بمسار SDK داخلي، استهلاك واصفات/CPU بلا حاجة، وتعقيد دورة الحياة عبر
     drain. يخالف «عزل خلف علم وأقل اقتران ممكن». (يبقى تطويراً لاحقاً إن لزم زمن-حقيقي.)

2. **حقن صفّ `<task-notification>` تصحيحي في الـtranscript** بصيغة تطابق `taskNotifRegex`.
   - مرفوض: كتابة في transcript يملكه الـSDK = خطر سباق/إفساد عند كتابة متزامنة، واقتران بصيغة SDK
     داخلية. يخالف «حلّ بطبقة نسّاج لا SDK».

3. **تعديل دالة drain لتعدّ الـworkflows** فتنتظرها قبل الخروج.
   - مرفوض صراحةً: ممنوع مسّ مسار drain/B-N-DRAIN؛ كما أنه يطيل الإيقاف ولا يعالج الحالة بعد فوات
     الإشعار. (الحادثة ليست عيب drain بل غياب تصحيح **بعدي**.)

4. **reconcile بعدي عند قراءة الجلسة (المعتمد)**: عند فتح/استئناف جلسة، اقرأ journal الـworkflows
   المعلّقة؛ إن اكتملت كلها بعد إشعار stopped، أرفق **تصحيحاً مشتقّاً (derived) في حمولة الرسائل
   المُعادة** (لا كتابة قرص)، وابثّ حدث WS اختياري. fail-safe وخلف علم.
   - مُختار: يعالج الأصل (تصحيح بعدي)، صفر مسّ لـdrain، صفر كتابة في transcript الـSDK، اقتران
     قراءة-فقط بالأثر القرصي، ويستفيد من مَفصِل قراءة قائم.

## Decision

**`workflow-reconcile.service.ts` جديد** في `server/modules/providers/list/claude/` (أو
`server/services/`)، **قراءة-فقط، fail-safe، خلف علم `WORKFLOW_RECONCILE` (افتراضي OFF)**.

- **المُحفِّز:** داخل `getSessionMessages` (مسار فتح/استئناف الجلسة)، بعد تجميع الرسائل ومعرفة وجود صفّ
  `run.stopped` خلفي بلا تصحيح. لا watcher، لا cron — كسول عند الطلب فقط.
- **المنطق:** لكل `wf_*` تحت `<sessionDir>/subagents/workflows/`: اقرأ `journal.jsonl`، اجمع
  `Set(started.key)` و`Set(result.key)`. مكتمل = `started ⊆ result` و`started` غير فارغة. اشترط
  **حداثة**: `mtime(journal) > timestamp(صفّ stopped)` (اكتمل بعد الإشعار) **و** هدوء
  (`now − mtime(journal) ≥ QUIET_MS`، افتراضي 5000ms) لتفادي إعلان اكتمال أثناء جريان. عندها:
  أرفق رسالة تصحيح **مشتقّة** في حمولة `getSessionMessages` (kind اصطناعي `task_reconcile` /
  `isTaskNotification:true, taskStatus:'completed'`) **دون كتابة قرص**، واختيارياً ابثّ
  `kind:'workflow_reconciled'` عبر WS للمتصلين بالجلسة.
- **fail-safe:** أي تعذّر (غياب مجلد/سطر تالف/خطأ قراءة/صيغة غير معروفة) → **لا تصحيح، لا throw،
  `console.debug` فقط**؛ `getSessionMessages` يُكمل كأن الخدمة غير موجودة.
- **العلم:** `WORKFLOW_RECONCILE` افتراضي **OFF** — تقليل اقتران مع مسار SDK داخلي قد يتغيّر بترقية
  upstream؛ يُفعَّل بعد تثبيت اختبار الصيغة. تفعيله لا يلمس drain/B-N-DRAIN.
- **العقد للواجهة (frontend بالتوازي):** (أ) توسيع `taskNotifRegex` ليقبل
  `(<output-file>|<tool-use-id>)` اختيارياً → يُصلح B-94 ويعرض إشعار stopped كبطاقة لا نصّاً.
  (ب) معالجة `kind:'task_reconcile'`/`workflow_reconciled` كبطاقة «اكتمل في الخلفية» تستبدل/تذيّل
  بطاقة stopped. لا تعتمد الواجهة على كتابة الخادم قرصاً.

## Consequences

- إيجابي: يُغلق انفصام الرؤية دون مسّ drain ولا transcript الـSDK؛ كلفة صفرية وقت التشغيل (كسول)؛
  معزول خلف علم؛ يصلح B-94 ضمناً عبر عقد الواجهة.
- سلبي/مخاطر: مقترن بصيغة `journal.jsonl` (`type/key/result`) — ترقية upstream قد تكسرها. التخفيف:
  **اختبار تثبيت صيغة** (fixture من journal الحادثة) يفشل إن تغيّرت المفاتيح، + fail-safe يحوّل أي
  انحراف إلى «لا تصحيح» بدل خطأ. التصحيح مشتقّ (غير مُمأسَس على القرص) فلا أثر دائم إن أُطفئ العلم.
- متابعة (مهام اللوحة): T-RECONCILE (تنفيذ الخدمة + اختبار التثبيت)، T-FE-RECONCILE (عقد الواجهة
  + B-94)، وقرار تفعيل العلم بعد جولة تحقّق.
