# ADR-025 — Model Selection Overhaul (إصلاح وتحديث منظومة اختيار النماذج)

> **سجلّ قرار معماري جامع (ADR).** الصيغة: Context → Decisions (1..6) → Verification → Deployment → Consequences → Follow-ups → Status.
> يوثّق خمس مشكلات في منظومة اختيار النماذج (Claude SDK + Antigravity) وقراراتها الإصلاحية،
> بما يشمل الانتقال من قوائم نماذج يدوية إلى **جلب ديناميكي** من Claude Code SDK وAntigravity CLI.
>
> *Architectural decision record. Documents five model-selection defects (Claude SDK + Antigravity), their root causes, and the fixes — including the move from hardcoded model lists to **dynamic discovery** from the Claude Code SDK and the Antigravity CLI.*

| الحقل / Field | القيمة / Value |
|---|---|
| **Status** | ✅ **Accepted** — 2026-06-09 (راجعه qa-critic / reviewed & approved by qa-critic) |
| **التاريخ / Date** | 2026-06-09 |
| **المالك / Owner** | i.rukhaimi |
| **الإصدار / Version** | v1.33.0 |
| **مرتبط بـ / Related** | CHANGELOG v1.33.0 · `/status` fallback fix (v1.31.0) · ADR-021 (session survival) |
| **النطاق / Scope** | منظومة اختيار النماذج عبر مزوّدَي `claude` و`agy` (واجهة + خادم). Model selection across the `claude` and `agy` providers (UI + server). |

---

## Context

كل إرسال رسالة كان يفشل بـ `There's an issue with the selected model (auto)`. التشخيص كشف أن المشكلة ليست واحدة بل **منظومة هشّة** لاختيار النماذج تجمع:

1. قيم localStorage عالقة وغير مُعقّمة (تسرّبت من نماذج Cursor).
2. تمرير قيمة النموذج للـ SDK دون تحقق على الخادم.
3. قوائم نماذج **يدوية ثابتة** تتقادم وتتعارض مع ما يتيحه الاعتماد فعلاً.
4. منطق واجهة يخفي مُنتقي المزوّد في حالات معيّنة (antigravity).
5. الخادم لا يمرّر النموذج المختار لمزوّد `agy` إطلاقاً.

القرار هنا يعالج الخمسة دفعةً واحدة، مع تحويل مصدر الحقيقة من القوائم اليدوية إلى **الجلب الديناميكي**.

*Every message send failed with `There's an issue with the selected model (auto)`. Investigation showed this was not a single bug but a brittle model-selection subsystem: stale/unsanitized localStorage values (leaked from Cursor models), no server-side validation before the SDK, stale hardcoded model lists, UI hiding the provider picker for antigravity, and the server never forwarding the selected model to `agy`. This ADR addresses all five and shifts the source of truth from hardcoded lists to dynamic discovery.*

---

## Problems, Root Causes & Decisions

### Decision 1 — إصلاح انهيار النموذج "auto" (auto-model crash)

**الأعراض / Symptoms:** كل إرسال يفشل بـ `There's an issue with the selected model (auto)`.

**الجذر / Root cause:** قيمة `localStorage["claude-model"]="auto"` عالقة (موروثة من نماذج Cursor)؛ الخادم يمرّرها للـ SDK دون تحقق؛ ومُعقِّم الواجهة الذاتي يعمل **فقط عند نجاح تحميل الكتالوج** — فإذا فشل التحميل بقيت القيمة التالفة.

**القرار / Decision:** تحقّق على طبقتين — خادم وواجهة — مع **سقوط معلَن لا صامت**:

- **خادم** — `server/claude-sdk.js` (`mapCliOptionsToSDK`): تحقق من قيمة النموذج، واستبدال أي قيمة غير معروفة بـ default مع `console.warn` صريح (لا استبدال صامت).
- **واجهة:**
  - ملف جديد `src/constants/providerModelFallbacks.ts` — مرآة عميل + `sanitizeStoredModel` / `sanitizeStoredProvider` + `DEFAULT_PROVIDER`.
  - ملف جديد `src/components/chat/hooks/normalizeProviderModel.ts` — دالة نقية `pickStoredOrCurrent`.
  - تعديل `src/components/chat/hooks/useChatProviderState.ts` — سقوط للكتالوج الاحتياطي عند فشل التحميل، عزل فشل المزوّد المفرد، تعقيم قراءات localStorage الابتدائية، وتصحيح `FALLBACK_DEFAULT_MODEL.claude` من `'opus'` إلى `'default'`.
  - بانر حالة في `src/components/CommandResultModal.tsx`.

**السبب / Rationale:** السقوط الصامت أخفى الجذر؛ التحقق على الخادم يحمي حتى لو فشل تعقيم الواجهة، والتعقيم الابتدائي يطهّر القيم العالقة قبل أول إرسال.

---

### Decision 2 — إصلاح علوق المُنتقي على antigravity (picker stuck on antigravity)

**الأعراض / Symptoms:** زر تبديل المزوّد يختفي عندما يكون المزوّد الفعّال `antigravity`.

**الجذر / Root cause:** فرع `isAntigravity` في `ProviderSelectionEmptyState.tsx` يعرض بطاقة **قراءة-فقط** بلا أداة فتح المنتقي.

**القرار / Decision:** عرض المنتقي القابل للنقر **دائماً** + استخدام `sanitizeStoredProvider`.

**السبب / Rationale:** المستخدم لا يجب أن يُحبَس في مزوّد بلا مخرج؛ المنتقي يبقى متاحاً في كل الحالات.

---

### Decision 3 — جلب نماذج claude ديناميكياً من Claude Code (dynamic Claude catalog)

**الأعراض / Symptoms:** القائمة اليدوية القديمة تتقادم ولا تعكس ما يتيحه الاعتماد.

**القرار / Decision:** استبدال القائمة اليدوية بجلب حيّ عبر `query(...).supportedModels()` من الـ SDK:

- ملف جديد `server/modules/providers/list/claude/claude-catalog.client.ts` — probe **معزول بلا أثر جانبي**:
  - prompt على هيئة async-generator بصفر turns → **لا جلسة jsonl شبحية**.
  - cwd مؤقت يُحذف بعد الاستعلام.
  - `close()` للتفكيك النظيف.
  - **circuit breaker** + **single-flight** + **degraded fallback**.
- `getSupportedModels()` في `claude-models.provider.ts` صار ديناميكياً، والقائمة الاحتياطية حُدّثت (+`claude-opus-4-8`).
- إضافة **stale-while-revalidate** في `provider-models.service.ts`.

**النتيجة / Outcome:** الافتراضي صار **Opus 4.8**، ويظهر أحدث نموذج يتيحه الاعتماد تلقائياً (مثل Fable 5).

**السبب / Rationale:** مصدر الحقيقة يجب أن يكون الاعتماد الحيّ لا قائمة مكتوبة يدوياً. **راجعه qa-critic واعتمده** (لا جلسات شبحية، مؤكّد بقراءة كود الـ SDK).

---

### Decision 4 — إصلاح استبدال Fable 5 بـ Opus 4.8 (Fable 5 silently downgraded)

**الأعراض / Symptoms:** اختيار Fable 5 كان يُشغَّل كـ Opus 4.8.

**الجذر / Root cause:** تحقّق الإرسال (`mapCliOptionsToSDK`) كان يقارن بالقائمة **الثابتة** فقط؛ فأي نموذج يكتشفه الكتالوج الديناميكي (مثل Fable) يُرفض ويُستبدل بـ default.

**القرار / Decision:** التحقق صار ضد **اتحاد** (union):
- الكتالوج الديناميكي (من كاش `getProviderModels`)، **∪**
- القائمة الثابتة (`buildValidClaudeModelValues`).

مع إبقاء حماية `auto` / القيم التالفة (من Decision 1).

**السبب / Rationale:** التحقق يجب أن يقبل ما يقبله الكتالوج الحيّ، وإلا انتقض الجلب الديناميكي نفسه (Decision 3) عند الإرسال.

---

### Decision 5 — اختيار نماذج agy ديناميكياً (dynamic agy model selection)

**الأعراض / Symptoms:** الواجهة تقصّ كتالوج antigravity إلى خيار واحد (`auto`)، والخادم لا يمرّر النموذج المختار أصلاً.

**القرار / Decision:**

- **واجهة** — `src/components/chat/ProviderSelectionEmptyState.tsx`: إزالة `slice(0,1)`، عرض الكتالوج الكامل قابلاً للاختيار، بانر معلوماتي للنموذج الفعّال.
- **خادم** — `server/agy-cli.js` (`spawnAntigravity`): يقرأ `model` ويمرّر `--model <label>`. عند `auto` / فارغ: **لا يُمرَّر** `--model`.

**اكتشاف موثّق / Documented discovery:** `agy` يتوقّع **الاسم المعروض (label)** لا الـ `modelId`، ولا يُخطئ على قيمة مجهولة بل **يسقط بصمت للافتراضي**. لذلك يحوّل الخادم قيمة الواجهة (`modelId`) إلى `label` من الكتالوج المخزّن قبل التمرير.

**السبب / Rationale:** لتمكين اختيار نماذج agy فعلياً (محور هذا الـfork)، مع التعامل مع سقوط agy الصامت بالتحويل الصريح modelId→label.

---

### Decision 6 — التحقق عبر السجلّ لا عبر سؤال النموذج (verify via logs, not self-report)

**القرار / Decision:** اعتماد **سجلّ nassaj-dev** كفحص قاطع، لا سؤال النموذج عن هويته.

**السبب / Rationale:** سؤال النموذج عن هويته **غير موثوق**؛ السجلّ يعكس ما مُرِّر فعلاً للـ SDK / للـ CLI.

التفاصيل في قسم Verification أدناه.

---

## Verification

- **claude:** غياب سطر `model "<x>" not in CLAUDE OPTIONS; falling back` للنماذج الصالحة = مرّ النموذج كما اختير.
- **agy:** ظهور `Propagating selected model override to backend: label="..."` = مرّر الخادم الـlabel الصحيح.
- ❌ **غير معتمد:** سؤال النموذج عن هويته (self-report غير موثوق).

---

## Deployment

| الطبقة / Layer | الأثر / Effect |
|---|---|
| واجهة (`dist/`) | تظهر بتحديث المتصفح / browser refresh. |
| خادم (`dist-server/`) | تتطلب `pm2 restart nassaj-dev` — **محجوب بحارس العميل، ينفّذه المالك في طرفيته**. |
| كاش النماذج | `~/.cloudcli/provider-models-cache.json` — TTL **3 أيام**؛ يُمسح يدوياً عند الحاجة للقطة فورية. |

---

## Consequences

- **إيجابي:** الإرسال لا ينهار على قيم نموذج تالفة؛ مصدر الحقيقة صار الاعتماد الحيّ؛ Opus 4.8 افتراضياً وأحدث نموذج يظهر تلقائياً؛ اختيار نماذج agy يعمل فعلاً؛ المنتقي لا يُحبَس على antigravity.
- **التحقق موثوق:** عبر السجلّ لا عبر self-report.
- **دَين معماري مقبول صراحةً (Follow-ups):** غياب سجلّ موحّد للنماذج، وعدم وجود اختبار تعاقد واجهة↔خادم — موثّق أدناه.
- **سقوط agy الصامت:** على قيمة label مجهولة يسقط agy للافتراضي بلا خطأ؛ مُعالَج بالتحويل modelId→label، لكنه يبقى سلوكاً هشّاً موثّقاً.

---

## Follow-ups (TODO)

- [ ] ربط لقطة النماذج عند اكتمال auth (`bypassCache`) — **لم يكتمل** (غير حرج / non-critical).
- [ ] ترجمات عربية لمفاتيح بانر agy الجديدة (تعمل بالإنجليزية حالياً عبر `defaultValue`).
- [ ] **دَين معماري:** توحيد `ProviderModelRegistry` + validate-on-write لمفاتيح localStorage + اختبار تعاقد واجهة↔خادم.
- [ ] تلميع label ليظهر "Fable 5" بدل "Fable".

> **⚠️ تنبيه ملفّي / File caveat:** `src/components/auth/context/AuthContext.tsx` فيه تعديل غير متتبَّع **سابق (2026-05-30) وخارج نطاق هذا العمل** — لم يُلمَس هنا؛ يُذكر لئلا يُنسب لهذا العمل عند أي commit لاحق.

---

## Tests

ملفات الاختبار المضافة/المعدّلة في هذا العمل:

- `server/claude-sdk.model.test.js`
- `server/modules/providers/list/claude/__tests__/claude-catalog.test.ts`
- `server/modules/providers/services/provider-models.service.test.ts`
- `server/agy-cli.model.test.ts`
- `src/components/chat/hooks/normalizeProviderModel.test.ts`

> فشل `branding-logo.test.ts` **سابق وغير متعلق** بهذا العمل / pre-existing & unrelated.

---

## سجل التغييرات / Change Log

- **2026-06-09** — اعتماد ADR-025 (إصلاح وتحديث منظومة اختيار النماذج) بقراراته الستة: إصلاح انهيار auto (تحقق خادم+واجهة، سقوط معلَن)، إصلاح علوق المنتقي على antigravity، جلب claude الديناميكي (probe معزول + circuit breaker + SWR)، إصلاح استبدال Fable 5 (تحقق ضد اتحاد ديناميكي∪ثابت)، اختيار agy الديناميكي (تحويل modelId→label)، والتحقق عبر السجلّ لا self-report. راجعه qa-critic واعتمده. الحالة → Accepted.
