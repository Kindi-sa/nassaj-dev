# CODEX-DELEGATION-SPIKE — نتائج تشغيل البوّابات 1A/1B (2026-07-13)

- **النوع:** نتائج سبايك تجريبي (تشغيل حقيقي، لا كود إنتاجي، لا build، لا go-live).
- **المرجع:** `CODEX-DELEGATION-SPIKE-2026-07-13.md` (تصميم architect) + `…-REVIEW-…md` (فيتو qa-critic).
- **المشغِّل:** المنسّق مباشرةً (تزامنياً) بعد موت 3 وكلاء خلفيين على التوالي بخروج عملية Claude
  (هشاشة [[project_workflow_orchestrator_fragility]]) — البيئة كانت مُجهَّزة بالكامل من الوكيل الثالث.
- **الحصة:** المالك أذن صراحةً بتجاوز حدّ حصة Claude واستهلاك حصة Codex.
- **مبدأ الصدق:** كل ادعاء أدناه مرساةً على مخرَج أمر حقيقي (لا fixtures). النتيجة **سلبية صريحة**، لم تُفبرك.

---

## البيئة (معزولة، أُجهِّزت ثم نُظِّفت)

- `CODEX_HOME=/tmp/codex-spike-home.b6jllu` (نسخة auth.json المالك + AGENTS.md + `agents/{architect,qa-critic}.toml` مولَّدة).
- cwd موثوق مؤقت `/tmp/codex-spike-cwd.TReblq` (git + `.codex/agents/`).
- المولّد: `docs/plans/spike-artifacts/gen-codex-agent-toml.cjs` (نموذج أوّلي، **غير موصول بالإنتاج**).
  يُسقط معرّف نموذج Claude، يحقن عقد leaf + canary + بطاقة الدور الكاملة في `developer_instructions`.
- codex-cli **0.144.1**، النموذج المحلول للأب **gpt-5.5**.
- canary مزروع في architect.toml: `NASSAJ-CANARY-5728da1f3973`.

---

## Gate 1B — تحميل الهوية عبر spawn_agent: **لم تُجتَز (FAIL)**

أمر التشغيل (يحاكي إعداد queryCodex):
```
CODEX_HOME=/tmp/codex-spike-home.b6jllu  (cwd=/tmp/codex-spike-cwd.TReblq)
codex exec -c project_doc_max_bytes=0 -c approval_policy="never" -s danger-full-access "<prompt>"
```
المطالبة: «استخدم spawn_agent لتفويض architect ليعرّف بنفسه (دوره + رمز بوابة الهوية + أول بوابة رفض)،
ثم wait_agent وانقل ردّه حرفياً».

**السلوك المرصود (مخرَج حرفي):**
- الأب **حاول التفويض فعلاً** (`collab: SpawnAgent` ×5) — أي **بوابة التحفيز انفتحت** بمجرّد طلب التفويض
  صراحةً (يؤكّد أن الكبح نصّي `<multi_agent_mode>` لا بنيوي).
- لكن كل محاولة فشلت بخطأين متمايزين من `codex_core::tools::router`:
  1. `error=spawn_agent could not resolve the child model for service tier validation` (×4).
  2. `error=unknown agent_type '@architect'` (×1).
- لا طفل أُنشئ، فلا canary ولا هوية نسّاج — الأب أبلغ بصدق «تعذّر التفويض تقنياً» ولم يخترع رداً.
- استُهلك ~30,453 توكن.

---

## Gate 1A — تكافؤ القدرة

مستنتَج ضمنياً من 1B: أدوات التفويض (`spawn_agent`/`wait_agent`) **حاضرة ومُستدعاة** على مسار exec
تحت إعداد queryCodex الحرفي (الأب استدعاها فعلاً). فوجود الأداة وتوفّرها مؤكَّد — يطابق E4/E8 في التصميم.
العقبة ليست غياب الأداة بل **فشلها وقت التنفيذ**.

---

## التحليل — عقبتان جذريتان

### عقبة أ [حرجة، فرضية قوية]: طبقة الخدمة مقابل مصادقة الاشتراك
`/home/nassaj/.codex/auth.json` هو **مصادقة اشتراك ChatGPT** (`auth_mode` + `tokens`
{id/access/refresh/account_id}، **بلا `OPENAI_API_KEY`**). خطأ «could not resolve the child model
for **service tier** validation» يشير إلى أن `spawn_agent` يحتاج حسم **طبقة خدمة (service tier)**
لنموذج الطفل — وهو مفهوم مرتبط بمفاتيح API لا بمسار اشتراك ChatGPT.
**الفرضية:** التفويض الأصيل (multi-agent) قد يكون **محجوباً على مصادقة الاشتراك**، ويتطلّب API-key/BYOK.
**غير محسوم قطعاً بعد** — يلزم تأكيد بإعادة الاختبار بنموذج طفل صريح/طبقة صريحة، أو بمصادقة API key.
إن ثبت: قرار بتبعات **كلفة (API مدفوع) وToS** — يرفع فوق مسألة التسجيل، ويقيّد مسار native جوهرياً.

### عقبة ب [مهمة]: التعريف المخصّص لم يُسجَّل
`unknown agent_type '@architect'` — إسقاط `agents/*.toml` في `$CODEX_HOME/agents/` و`cwd/.codex/agents/`
**لم يجعل الوكيل قابلاً للاستدعاء**. آلية تسجيل الوكلاء المخصّصين في 0.144.1 غالباً مختلفة عن افتراض
التصميم (لاحظ وجود علم `--profile <CONFIG_PROFILE_V2>` = `$CODEX_HOME/<name>.config.toml` — مرشّح لآلية
التسجيل الحقيقية، يحتاج تحقّقاً). كما أن الأب استعمل الاسم بصيغة `@architect` وقد يكون الصحيح `architect`.

---

## الحكم على المحور (native مقابل MCP)

**Gate 1B لم تُجتَز** — مسار native custom-agents **غير صالح out-of-the-box** تحت إعداد queryCodex
ومصادقة الاشتراك الحالية. لا ينهار المسار نهائياً بعد (العقبتان قد تكونان قابلتين للحل)، لكن **لا يُعتمد
native** قبل حسم:
1. هل تُحلّ عقبة الطبقة/المصادقة دون API-key؟ (إن لا → تبعة ToS/كلفة تُرجّح إعادة النظر أو MCP).
2. آلية تسجيل الوكيل المخصّص الصحيحة في 0.144.1 (`--profile`؟ مسار آخر؟ صيغة الاسم؟).

**التوصية:** جولة تشخيص ثانية قصيرة (بنموذج طفل/طبقة صريحة + تصحيح آلية التسجيل) تحسم العقبتين قبل
اعتماد native أو التصعيد لـMCP dispatcher (البديل في التصميم §القرار). البوابة الأمنية T-884 تبقى شرطاً
سابقاً لأي طرح.

---

## المصنوعات

- `docs/plans/spike-artifacts/gen-codex-agent-toml.cjs` — المولّد (نموذج أوّلي).
- البيئات المؤقتة `/tmp/codex-spike-*` نُظِّفت بعد التوثيق.
