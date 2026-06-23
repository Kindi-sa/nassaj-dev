# ADR-044: إخفاء النماذج غير المُطلَقة من قائمة اختيار النماذج

## Status
Accepted — منفّذ (commit `df53195f`، 2026-06-23). بانتظار النشر (build + restart).

## Context
نافذة «Choose a model» على سيرفر الرخيمي تعرض **«Fable 5» (`claude-fable-5`)** رغم
أن Anthropic **لم تُطلقه للاستخدام العام**؛ اختياره يفشل صامتاً (راجع
`feedback_workflow_agenttype_fable_fallback`). التشخيص أثبت أن المصدر ليس عطباً ولا
كوداً قديماً ولا اشتراكاً مخوَّلاً:

- قائمة claude تأتي من الكتالوج الحيّ `getClaudeModelCatalog()` →
  `queryInstance.supportedModels()` الذي يجيبه **الـ CLI binary عبر init handshake**.
- الفرق سلوكي بين الأجهزة بحكم **إصدار الـ CLI**، لا الاشتراك:
  - dev (CLI **2.1.183**، حساب المالك) → 3 نماذج، **بلا** Fable.
  - الرخيمي (CLI **2.1.185**، الحساب نفسه) → 6 نماذج، **فيها** Fable.
- إصدار CLI الأحدث (2.1.185) **يُدرج `claude-fable-5` في قائمته الثابتة** بصرف النظر
  عن إطلاق Anthropic له. لا توجد في الكود أي طبقة تستبعد النماذج غير المُطلَقة (لا
  كتالوج، لا fallback، لا فلترة مستوى-نموذج). زر التحديث يعمل صحيحاً — يعيد probe
  حيّاً فيجد Fable مجدداً.

## Decision
إضافة **قائمة استبعاد مركزية للنماذج غير المُطلَقة** قابلة للتوسيع والإزالة بسطر واحد:

- `UNRELEASED_HIDDEN_MODELS = new Set(['claude-fable-5'])` في
  `server/modules/providers/list/claude/claude-catalog.client.ts`، تُطبَّق داخل
  `buildClaudeModelsDefinition` فتُسقط أي نموذج محجوب من الكتالوج الحيّ قبل وصوله
  للواجهة (منطق DEFAULT يرسو على أول خيار **مرئي** إن لزم).
- إزالة `claude-fable-5` من `CLAUDE_FALLBACK_MODELS` (claude-models.provider.ts)
  ومن مرآة العميل `src/constants/providerModelFallbacks.ts` (مفروض بـ drift-guard).
- النموذج المحجوب إن طُلب صراحةً (قيمة مخزّنة قديمة) يُقصَر إلى DEFAULT مع تحذير
  مهيكل، بدل الفشل الصامت.

## Alternatives
1. علم env `CLAUDE_HIDDEN_MODELS` يقرأه الكتالوج — أكثر مرونة عبر الأسطول لكنه سطح
   إعداد إضافي؛ مؤجَّل (يمكن ترقية المجموعة لقراءة env لاحقاً دون كسر).
2. كسر الكاش/إعادة probe — مرفوض: الـ probe الحيّ نفسه يُرجع Fable، عديم الجدوى.

## Consequences
- (+) `claude-fable-5` لم يعد قيمة صالحة في أي مسار (كتالوج/fallback/عميل) → يختفي من
  الواجهة على كل الأسطول، ويمنع اختياره الخاطئ.
- (+) وقائي لـ dev: عند ترقية CLI لـ 2.1.185+ لن يظهر Fable.
- (−) إخفاء ثابت: عند إطلاق Fable فعلياً من Anthropic يلزم حذف السطر من المجموعة.
- no-op على الـ runtime حتى `build:server` + `build:client` + restart (يلمس server وsrc).

## Tests
catalog 16/16، خادم 83/83. اختبارات جديدة: إسقاط fable من buildClaudeModelsDefinition،
رسوّ DEFAULT على أول مرئي، خلوّ fallback من fable.
