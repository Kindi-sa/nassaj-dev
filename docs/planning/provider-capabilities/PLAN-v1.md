# PLAN-v1 — الواجهة المزوّد-واعية (Provider-Aware UX via Capability Descriptor)

> خطة واحدة متماسكة لتحويل واجهة نسّاج إلى «مزوّد-واعية»: مكوّنات الـUX تتبدّل بحسب المزوّد النشط (Claude → مكوّناته، Hermes → مكافئاته). تدمج خمسة أقسام فريق + قرارات أغلبية ثلاثة محكّمين. القرار الموجِّه: **ADR-047 — Provider UI Capability Descriptor** بمراحله م0→م3.
>
> **المبدأ الناظم الواحد:** كل سلوك UX يُشتقّ من واصِف قدرات واحد declarative (`ProviderUiCapabilities`)، يحلّ محل شروط `provider === 'x'` المبعثرة 3+ مرات عبر 4+ ملفات. هذا يحوّل العلاقة من O(مزوّدات × مواقع شرط) إلى O(مزوّدات)، ويغلق علّة B-92 بنيوياً لا نقطياً.

التاريخ: 2026-06-27 · الحالة: معتمد (Approved، بعد تصويت المحكّمين) · النطاق: أداة تطوير داخلية، fork claudecodeui، RTL عربي · المزوّد المرجعي للميزة: Hermes؛ المزوّد المرجعي للحياد: Claude.

---

## جدول المحتويات

1. المشكلة البنيوية ومبدأ المصدر الواحد للقدرة
2. جرد المكوّنات × المزوّدات
3. نموذج بيانات الواصِف `ProviderUiCapabilities`
4. مصدر «المزوّد النشط» الواحد وآلية التبديل ودورة الحياة
5. ربط وتفعيل مكوّنات كل مزوّد (Wiring & Activation)
6. معالجة B-92 وقيد التوكنز اللحظية في هرمز
7. سيناريوهات التشغيل والحالات الحدّية
8. المعمارية الكلية ومخطط الطبقات
9. الترحيل المرحلي م0→م3 ومعايير القبول
10. استراتيجية الاختبار
11. الإطلاق والتراجع وسجل المخاطر
12. مسوّدة ADR-047
13. القرارات المعتمدة بالأغلبية
14. جدول تتبّع المطالب
15. ملحق: مهام اللوحة المقترحة

---

## 1. المشكلة البنيوية ومبدأ المصدر الواحد للقدرة

اليوم لا يملك نسّاج **مصدر حقيقة واحداً** لما يدعمه كل مزوّد من مكوّنات الـUX. القرار «هل أُظهر هذا المكوّن لهذا المزوّد؟» مبعثر كشروط `provider === 'x'` مكرّرة عبر أربع طبقات على الأقل:

| الموقع | الملف:السطر (مؤكَّد كوداً) | شكل القرار اليوم | العلّة / القدرة الضمنية |
|---|---|---|---|
| منتقي التفكير | `ChatComposer.tsx:414` | `provider === 'claude' && (<ThinkingModeSelector …/>)` | مبوَّب صلباً؛ أي مزوّد آخر يفقد منتقي الجهد حتى لو دعم مكافئاً (هرمز `reasoning_effort`) — قدرة `effort` |
| عدّاد التوكنز | `ChatComposer.tsx:428` | `<TokenUsageSummary usage={tokenBudget} />` **بلا شرط** | **B-92**: يُعرض للجميع؛ هرمز/agy لا يبثّان `token_budget` → شارة `0` مضلِّلة — قدرة `tokenCounter` |
| الأذونات | `useChatProviderState.ts:53-64` | سلسلة `if (provider === …)` ترجع `PermissionMode[]` | منطق صحيح لكنه مغلق على قائمة مثبتة في دالّة واحدة — قدرة `permissions` |
| الموديل الافتراضي + تمرير الأمر | `useChatProviderState.ts:40-51` + `useChatComposerState.ts:372-391, 633-755` | خرائط وسلاسل ternary مكرّرة عبر 10 مزوّدات | كل مزوّد جديد = تعديل 3+ مواضع متطابقة — قدرات `models` / `command` |
| الأسماء المعروضة | `ProviderSelectionEmptyState.tsx:37-48` + `117-128` | تعريفان متوازيان (`PROVIDER_META` + `getProviderDisplayName`) | **تباعد حقيقة فعلي** (مرصود: 'Claude' مقابل 'Anthropic' لنفس المزوّد) — قدرة `displayName` |

النتيجة المعمارية: **إضافة مزوّد أو ضبط مكوّن تتطلب لمس 3–6 ملفات بنفس النمط**، وأي إغفال يُنتج علّة صامتة من نوع B-92.

**القرار:** كل صفّ أعلاه يصبح **حقلاً في واصِف واحد** بدل شرط مبعثر. الواصِف يُجيب سؤالاً واحداً لكل مزوّد: «ما الذي تُظهره الواجهة وكيف؟».

**مبدأ توجيهي حاكم (ADR-047):** الواصِف **محايد لـClaude في م0** — قيم Claude الحالية تُعاد حرفياً كما هي، فلا تغيّر سلوكياً ولا انحدار. الإصلاحات الفعلية (إخفاء عدّاد هرمز، تصحيح أذوناته، منتقي `reasoning_effort`، مؤشّر الحصة) تأتي في م1/م2 كتغييرٍ في **بيانات** الواصِف لا في منطق المكوّنات.

**تماثل أمامي/خلفي مقصود:** الخادم يملك أصلاً seam قدرات في `IProvider` (`hermes.provider.ts:87-95`، حيث `synchronize()→0` و`fetchHistory→notSupported` يُعلنان «لا أدعم هذا»). الواصِف الأمامي هو **النظير الواجهي لهذا العقد الخلفي**: ما يُعلنه الخادم `notSupported` تُخفيه الواجهة كقدرة `false`. هذا التماثل يضمن أن م3 (البثّ الخادمي) يندمج لاحقاً دون إعادة تصميم.

---

## 2. جرد المكوّنات × المزوّدات

المزوّدات في `PROVIDER_META` (`ProviderSelectionEmptyState.tsx:37`): `claude, codex, gemini, antigravity(agy), cursor, opencode, hermes, kimi, deepseek, glm`. ومفهوم **engine-on-vendor** (ADR-037): `provider==='claude'` مع `engineProvider ∈ {kimi,deepseek,glm}` — يُعامَل في الواصِف كقدرات Claude (المحرّك كلود) لا قدرات المورّد.

### (أ) منتقي النموذج (Model Picker)
- المكوّن: `ProviderSelectionEmptyState.tsx` (حوار `Dialog`+`Command`، `visibleProviderGroups:235`).
- المصدر: `providerModelCatalog[provider].OPTIONS` عبر `GET /api/providers/:p/models`.
- التباين: الأغلبية اختيار حر من الكتالوج يُخزَّن `localStorage['<provider>-model']`؛ **agy** الكتالوج يُقصّ لخيار واحد (`slice(0,1):510`) والنموذج للقراءة فقط (`useAntigravityActiveModel`)؛ **hermes** قابل للاختيار من `HERMES_FALLBACK_MODELS` (10 خيارات، المجاني `:free`) لكن `changeActiveModel()→notSupported` (`hermes.provider.ts:57`) فالتغيير لكل-جلسة غير مدعوم.

### (ب) عدّاد التوكنز / نافذة السياق (Token / Context)
- المكوّن: `TokenUsageSummary.tsx` — عند `total>0` يرسم شريط «تعفّن السياق» (`EFFECTIVE_CONTEXT_FACTOR=0.6`)؛ عند `total<=0` يرسم **فرع `!hasWindow` (السطور 95-108)** بـ`used=0` → جوهر B-92.
- المصدر: حالة `tokenBudget` تُملأ من WS `text:'token_budget'` (`useChatRealtimeHandlers.ts:523`). **المُنتِجون المؤكَّدون:** claude (`claude-sdk.js:1685`), codex (`openai-codex.js:386`), gemini (`gemini-response-handler.js:98`), opencode (`opencode-cli.js:272` من ملف الجلسة). **لا يبثّ:** hermes (`hermes-cli.js` يبثّ فقط `session_created/stream_delta/stream_end/complete/error`), agy.
- هرمز: العدّاد اللحظي **غير ممكن مباشرة** — الحقول داخلية في `AIAgent` ولا تُصدَّر في `-z` (oneshot يُصمت stdout)؛ المصدر الخارجي الوحيد `state.db` (SQLite) بعد الجلسة أو `hermes insights`. نافذة السياق متاحة (`context_length_cache.yaml`، 256K) — «نافذة بلا عدّاد لحظي» حالة مشروعة.

### (ج) مستوى التفكير / الجهد (Reasoning / Effort)
- المكوّن: `ThinkingModeSelector` فوق `effortModes` (`thinkingModes.ts`): `none, auto, low, medium, high, xhigh, max, ultracode`. يُرسل كـ`options.effort`.
- الخادم (claude): `resolveEffortLevel` + `EFFORT_ALIASES` (`auto→null`, `ultracode→max`)، و`ultracode` يحقن `ultrathink ultrawork` (`maybeApplyUltracodeKeywords`، `claude-sdk.js:405-466`).
- هرمز: مكافئ حقيقي — `reasoning_effort ∈ {low,medium,high,xhigh}` (النموذج الحالي يدعمه). الواصِف يحتاج **مجموعة قيم لكل مزوّد** لا علماً منطقياً واحداً.

### (د) الأذونات (Permission Modes)
- المصدر: `getPermissionModesForProvider` (`useChatProviderState.ts:53-64`) — أنظف موضع وأقرب نموذج للواصِف. claude=5 أوضاع، codex=3، opencode=`['default']`، الباقي افتراضي 4.
- هرمز: نسّاج **headless لهرمز**، `hermes -z` يتجاوز الأذونات؛ فأوضاعها **بلا معنى تنفيذي** ويجب أن تكون `['default']` فقط (تصحيح م1). الافتراضي الحالي (4 أوضاع) خادع كـB-92 للأذونات.

### (هـ) الحالة / الحصة (Status / Quota)
- لا مكوّن حصة حيّ اليوم. هرمز: لا حقل «متبقٍّ»؛ تُشتق من `fallback_providers` + `auth.json(last_status/expires)`، وتُكتشف بـ429 (`hermes auth list` يُظهر `exhausted`). «no final response» = نفاد حصة النموذج المجاني لا عطل (B-91). القدرة تُوصَف `derived/onError` لا `live`.

### (و) شكل أمر WebSocket
- المصدر: `dispatchProviderCommand` (`useChatComposerState.ts:633-755`). كل مزوّد له `type` خاص وطقم خيارات مختلف (claude=`claude-command` بـ`effort/images/engineProvider`؛ codex بتحويل `plan→default`؛ hermes=`hermes-command` أبسط طقم بلا `permissionMode/effort/images`). الواصِف **لا يبني الـpayload** (منطق نقل)، لكنه يُعلن أبعاداً (`supportsImages`, `supportsPermissionMode`, `planFallbackToDefault`) تُقرأ بدل تكرار `provider===`.

### (ز) الاستئناف والجلسات (Resume / Sessions)
- `resume = Boolean(targetSessionId)` موحّد للجميع. لكن `HermesSessionSynchronizer.synchronize()→0` (`hermes.provider.ts:83`) و`fetchHistory/normalizeMessage` غير مدعومتين → جلسات هرمز **تُرسَل لكنها لا تُسرَد ولا تُستعاد**. الواصِف: `session.listing='none'` (مقابل `'full'` لـclaude).

---

## 3. نموذج بيانات الواصِف `ProviderUiCapabilities`

### 3.1 المبادئ
1. **إعلاني لا إجرائي**: بيانات صرفة تُستهلك في render، خالية من side-effects (نظير `effortModes`/`PROVIDER_META`).
2. **مصدر بيانات صريح لكل قدرة (`source`)**: تمييز الثابت تصميمياً عن الحيّ وقت التشغيل.
3. **محايد لـClaude (م0)**: واصِف Claude يُنتِج سلوكاً مطابقاً 1:1 للحالي.
4. **مكان السكنى**: ثابت أمامي محض في `src/components/chat/constants/providerCapabilities.ts` (بجوار `thinkingModes.ts`)، مُصدِّراً `PROVIDER_UI_CAPABILITIES: Record<LLMProvider, ProviderUiCapabilities>` ودالّة `getProviderCapabilities(provider, engineProvider?)`. الأخيرة تطبّق engine-on-vendor: عند `engineProvider != null` تُعيد قدرات `claude`.
5. **fallback إجباري**: مزوّد بلا إدخال صريح يحصل واصِفاً افتراضياً آمناً (كل القدرات الحسّاسة `false`/`none`).

### 3.2 الأنواع (TypeScript)

```ts
export type CapabilitySource =
  | 'static'        // مثبَّت تصميمياً
  | 'catalog'       // من providerModelCatalog (GET /api/providers/:p/models)
  | 'stream'        // من رسالة WS حيّة (token_budget)
  | 'cache-file'    // من ملف يقرأه نسّاج (context_length_cache.yaml …)
  | 'auth'          // من auth.json / providerAuthStatus / fallback_providers
  | 'post-session'; // متاح بعد الجلسة فقط (state.db / hermes insights)

export type LivenessMode = 'live' | 'derived' | 'onError' | 'none';

export interface ModelPickerCapability {
  supported: boolean; selectable: boolean; source: CapabilitySource;
  perSessionChange: boolean; readOnlyActiveModelHook?: 'antigravity';
}
export interface TokenCounterCapability {
  supported: boolean;             // claude/codex/gemini/opencode=true ; hermes/agy=false ← B-92
  liveCounter: LivenessMode;      // 'live' للأربعة ; 'post-session' لهرمز (م3) ; 'none' لـagy
  contextWindow:
    | { source: 'stream' }
    | { source: 'cache-file'; file: 'context_length_cache.yaml'; defaultTokens?: number }
    | { source: 'none' };
  streamMessage?: 'token_budget';
}
export interface EffortCapability {
  supported: boolean; field: 'effort' | 'reasoning_effort'; values: string[];
  source: CapabilitySource; promptKeywordsAlias?: 'ultracode';
}
export interface PermissionsCapability {
  modes: PermissionMode[]; planFallbackToDefault: boolean; source: 'static';
}
export interface QuotaCapability {
  supported: boolean; liveness: LivenessMode; source: CapabilitySource;
  freeTierModelSuffix?: ':free';
}
export interface CommandShapeCapability {
  wsType: string; supportsImages: boolean; supportsToolsSettings: boolean;
  supportsPermissionMode: boolean; supportsEngineOnVendor: boolean;
}
export interface SessionCapability { resume: boolean; listing: 'full' | 'none'; history: boolean; }

export interface ProviderUiCapabilities {
  id: LLMProvider;
  displayName: string;     // يستبدل getProviderDisplayName (:117)
  vendorName?: string;     // لحسم تضارب 'Claude'/'Anthropic' دون انحدار بصري (شاشة الاختيار vs المحادثة)
  modelPicker: ModelPickerCapability;
  tokenCounter: TokenCounterCapability;
  effort: EffortCapability;
  permissions: PermissionsCapability;
  quota: QuotaCapability;
  command: CommandShapeCapability;
  session: SessionCapability;
}
```

> **توحيد المصطلح:** الأقسام استخدمت أسماء حقول متعددة لنفس القدرة (`thinking.kind`/`thinkingControl.kind`/`tokenMeter.kind`/`tokenBudget.mode`). **المعتمد في PLAN-v1:** قدرة الجهد = `effort` بحقل `field` (`'effort'|'reasoning_effort'`) و`supported`؛ قدرة العدّاد = `tokenCounter` بحقل `supported` + `liveCounter`. حيث يلزم تمييز شكل المنتقي للعرض يُقرأ `effort.field`. هذا التوحيد يلغي الأسماء المتنافسة.

### 3.3 أمثلة مثبتة

**claude** (محايد، م0 — يطابق الحالي حرفياً):
```ts
claude: {
  id:'claude', displayName:'Claude', vendorName:'Anthropic',
  modelPicker:{ supported:true, selectable:true, source:'catalog', perSessionChange:true },
  tokenCounter:{ supported:true, liveCounter:'live', contextWindow:{source:'stream'}, streamMessage:'token_budget' },
  effort:{ supported:true, field:'effort', values:effortModes.map(m=>m.id), source:'static', promptKeywordsAlias:'ultracode' },
  permissions:{ modes:['default','auto','acceptEdits','bypassPermissions','plan'], planFallbackToDefault:false, source:'static' },
  quota:{ supported:false, liveness:'none', source:'auth' },
  command:{ wsType:'claude-command', supportsImages:true, supportsToolsSettings:true, supportsPermissionMode:true, supportsEngineOnVendor:true },
  session:{ resume:true, listing:'full', history:true },
}
```

**hermes** (يجسّد إصلاحات م1/م2):
```ts
hermes: {
  id:'hermes', displayName:'Hermes (Nous)',
  modelPicker:{ supported:true, selectable:true, source:'catalog', perSessionChange:false }, // changeActiveModel→notSupported
  tokenCounter:{ supported:false, liveCounter:'post-session', // ← م1: يخفي العدّاد، يحلّ B-92
                 contextWindow:{ source:'cache-file', file:'context_length_cache.yaml', defaultTokens:256000 } },
  effort:{ supported:true, field:'reasoning_effort', values:['low','medium','high','xhigh'], source:'static' }, // ← م2
  permissions:{ modes:['default'], planFallbackToDefault:false, source:'static' }, // ← م1: headless
  quota:{ supported:true, liveness:'onError', source:'auth', freeTierModelSuffix:':free' }, // ← م2
  command:{ wsType:'hermes-command', supportsImages:false, supportsToolsSettings:false, supportsPermissionMode:false, supportsEngineOnVendor:false },
  session:{ resume:true, listing:'none', history:false }, // synchronize→0
}
```

**antigravity (agy)**: `modelPicker.selectable:false` + `readOnlyActiveModelHook:'antigravity'` (يلغي `slice(0,1)`)؛ `tokenCounter.supported:false`؛ `effort.supported:false`.
**opencode**: `tokenCounter.supported:true, liveCounter:'live'`؛ `effort.supported:false` (يثبت أن العدّاد لا يلزم الجهد)؛ `permissions.modes:['default']`.
**codex**: `permissions.planFallbackToDefault:true` (plan→default)؛ `tokenCounter.supported:true`.

> **التزام المصدر الواحد:** `getPermissionModesForProvider` و`getProviderDisplayName` **يُعاد تنفيذهما كقارئتين رفيعتين** فوق `PROVIDER_UI_CAPABILITIES` (`caps.permissions.modes` / `caps.displayName`)، فلا يبقى تعريفان للحقيقة (يحسم تضارب 'Claude'/'Anthropic' المرصود عبر `displayName`/`vendorName`).

---

## 4. مصدر «المزوّد النشط» الواحد وآلية التبديل ودورة الحياة

### 4.1 مصدران متمايزان (مقصودان)

في نسّاج مفهومان متمايزان مقصودان (تعليق `ChatInterface.tsx:231-234` صريح):

| المفهوم | المصدر | المُلِف | الغرض |
|---|---|---|---|
| `provider` (الاختيار العالمي/المُؤلِّف) | `localStorage['selected-provider']` عبر `sanitizeStoredProvider` | `useChatProviderState.ts:93` | ما **سيُرسَل** التالي + ما يحكم المُؤلِّف |
| `displayProvider` (هوية الجلسة المعروضة) | `selectedSession?.__provider ?? provider` | `ChatInterface.tsx:234` | شارات الرسائل والشعار (جلسة Claude قديمة تبقى Claude حتى لو الاختيار العالمي مختلف) |

**القاعدة المعتمدة (S2-Q1، أغلبية 3/0):** القدرات تُشتقّ من **`provider`** لمكوّنات المُؤلِّف (منتقي التفكير، عدّاد التوكنز) ومن **`displayProvider`** لمكوّنات المحادثة (الشعار، الشارات). دالة واحدة `getProviderCapabilities` بمدخلين حسب الموضع — لا مصدري حقيقة، ولا توحيد يكسر إبقاء جلسة Claude المفتوحة على هويتها.

### 4.2 قواعد المصدر الواحد
1. **مُدخِل تغيير واحد:** كل تغيير لـ`provider` عبر `setProvider` (`useChatProviderState`). `handleModelSelect` (`ProviderSelectionEmptyState.tsx:365`) يستدعيه مع كتابة localStorage معاً.
2. **`engineProvider` تابع:** ذو معنى فقط حين `provider==='claude'`؛ أي انتقال لغير Claude يُصفّره (`useChatProviderState.ts:475-477`)، بلا ترميم تلقائي.
3. **منع الدوس:** `__provider` معلوماتي فقط ولا يُعيد ضبط `provider` العالمي أبداً.
4. **الإعادة القسرية الوحيدة:** عند `shouldResetProvider` (`providerAuthFilter.ts:43`) لمزوّد غير مثبَّت قطعاً → `ChatInterface.tsx:225-228` يُعيد إلى `'claude'` (fail-open، لا أثناء التحميل).

### 4.3 دورة الحياة عند التبديل: swap مقابل hide

| المكوّن | الملف | النمط المعتمد | السلوك |
|---|---|---|---|
| منتقي التفكير / `reasoning_effort` | `ChatComposer.tsx:414-426` | **swap حقيقي** (S2-Q3، 3/0) | تركيب/إزالة شرطية حسب `effort.field`؛ تحرير الحالة الداخلية يمنع تسرّب قيمة `ultracode↔xhigh` (فضاءا قيم متنافران) |
| `TokenUsageSummary` | `ChatComposer.tsx:428` | **إخفاء كامل (unmount)** (S1-Q3، 3/0) | يُخفى كلياً عند `!caps.tokenCounter.supported` — لا `display:none` ولا 0-state |
| شارة `ULTRACODE` | `ChatComposer.tsx:417` | تابعة لمنتقي Claude | تختفي تلقائياً |
| منتقي النموذج | `ProviderSelectionEmptyState.tsx` | ثابت دائم + محتوى مشتقّ | المجموعات من `visibleProviderGroups` |
| شعار/شارة الجلسة | عبر `displayProvider` | ثابت prop-driven | يتبع `displayProvider` |

> **محظور:** `key={provider}` على `ChatComposer` كله (يُعيد تركيب المُؤلِّف بأسره: النص، الرفع، التركيز → وميض واسع). التبديل **موضعي** على المكوّنات المزوّد-واعية فقط.

### 4.4 منع التسرّب الثلاثي
1. **تسرّب الحالة:** swap للمنتقي + شرط القدرة للعدّاد + **تصفير `setTokenBudget(null)` عند تبديل provider** (S2-Q2، 3/0).
2. **تسرّب الأذونات:** إعادة الفرز القائمة (`useChatProviderState.ts:453-461`): وضع خارج مجموعة المزوّد الجديد يسقط على `'default'`.
3. **تسرّب الطلبات المعلّقة:** تفريغ عند تغيّر المزوّد (`:471`) + تصفية حسب `sessionId` عند تغيّر الجلسة (`:481-485`) + بوّابة `isActiveViewSession` (`useChatRealtimeHandlers.ts:508`).

### 4.5 تنبيه تنفيذي (تصفير العدّاد)
`setTokenBudget` مملوكة لـ`useChatSessionState` (ليست في `useChatProviderState`)؛ وeffect تبديل المزوّد الذي يصفّر `pendingPermissionRequests/engineProvider` (`useChatProviderState.ts:467`) **لا يملك** `setTokenBudget`. لذا التصفير عند تبديل `provider` يُضاف إمّا بتمرير `setTokenBudget` إلى ذلك المسار، أو effect مرافق على `[provider]` في `useChatSessionState`/`ChatInterface` (حيث الاثنان مرئيان) يملك `setTokenBudget(null)`. هذا حسم تنفيذي أكّده المحكّمون الثلاثة.

### 4.6 استقرار الاشتقاق
كل `getProviderCapabilities(provider)` **خالصة ومتزامنة** (لا جلب شبكي عند التبديل — الكتالوجات مُجلَبة مسبقاً في `loadProviderModels`، و`auth.json`/`context_length_cache.yaml` تصل عبر الكتالوج/الحالة)، ومذكَّرة عبر `useMemo` على `[provider]`/`[displayProvider]`. لحظة التبديل لا تُدخِل حالة تحميل وسيطة تومض.

---

## 5. ربط وتفعيل مكوّنات كل مزوّد (Wiring & Activation)

### 5.0 الجدول المركزي: القدرة × المصدر × الربط × إشارة التفعيل

| القدرة | مكوّن الـUI | مصدر البيانات | قناة النقل | إشارة التفعيل | الحالة |
|---|---|---|---|---|---|
| `tokenCounter` | `TokenUsageSummary` | WS `token_budget` + REST `/token-usage` | WS push + REST | `caps.tokenCounter.supported` | claude/codex/gemini/opencode؛ **هرمز=false ⇒ B-92** |
| `effort` (claude) | `ThinkingModeSelector` | `claude-sdk.js EFFORT_ALIASES` | WS `claude-command` options.effort | `caps.effort.field==='effort'` | يعمل، مبوَّب صلباً |
| `effort` (hermes) | `ReasoningEffortSelector` (جديد) | ثابت `{low,medium,high,xhigh}` | WS `hermes-command` → `hermes -z … --reasoning-effort` | `caps.effort.field==='reasoning_effort'` | **غير موصول** |
| `models` | منتقي النموذج | `provider_models_cache.json`/`/v1/models` | REST → `providerModelCatalog` | `caps.modelPicker.source` | موصول (static fallback) |
| `contextWindow` | داخل `TokenUsageSummary.total` | `context_length_cache.yaml` (256K) | REST (جديد) | `caps.tokenCounter.contextWindow` | غير مقروء بعد |
| `quota` | `ProviderQuotaIndicator` (جديد) | `auth.json` + `fallback_providers` + 429 | REST `provider-auth-status` + WS `quota_status` (جديد) | `caps.quota.supported` | غير موجود |
| `permissions` | مؤشّر الوضع | `caps.permissions.modes` | محلي | `caps.permissions.modes` | هرمز يرث افتراضياً خاطئاً |

> **القاعدة الموحّدة:** كل «إشارة تفعيل» تُقرأ من الواصِف بمفتاح المزوّد النشط. **لا يُضاف شرط `provider==='hermes'` جديد في أي مكوّن**؛ تُضاف خاصية في الواصِف ويُستهلك عَلَمها.

### 5.1 Claude (المرجع المحايد): إبقاء ما يعمل
- **effort:** المسار قائم. م0 يستبدل `provider==='claude'` بـ`caps.effort.field==='effort'` (سلوك Claude لا يتغيّر). الإرسال `claudeOptions.effort` عند قيمة غير فارغة. الخادم `claude-sdk.js:405-466`.
- **tokenBudget:** بثّ حيّ (`claude-sdk.js:1685`) + جلب أوّلي REST `/token-usage` (مبوَّب `useChatSessionState.ts:683` للأربعة). `TokenUsageSummary` **لا يُمسّ منطقه**؛ يُتحكَّم بظهوره فقط.

### 5.2 هرمز: ربط المكافئات وتفعيلها

**(أ) منتقي `reasoning_effort`** — القيم ثابتة `{low,medium,high,xhigh}`. التدفّق:
```
ReasoningEffortSelector (يُظهره caps.effort.field==='reasoning_effort')
  → setHermesReasoningEffort(level)  [حالة جديدة في useChatComposerState]
  → hermes-command options.reasoningEffort = level  [غصن hermes عند 685-694]
  → spawnHermes → hermes-cli.js: args=['-z',command]; if(model) push('-m',model);
                  if(options.reasoningEffort) push('--reasoning-effort', level)  [إدراج وحيد ~135-138]
```
ربط دقيق: القيمة argv مستقلّة (لا تُسلسَل في الـprompt)؛ allowlist خادمي مماثل لـ`resolveEffortLevel` يُسقط أي قيمة خارج `{low,medium,high,xhigh}` بصمت. **حسم الربط الخادمي في S3-Q1 (3/0): علم argv + بوابة تحقّق فعلي قبل م2؛ عند الفشل، متغيّر بيئة per-spawn عبر `resolveProviderEnv` — لا كتابة `config.yaml` المشترك (تسابق جلسات).**

**(ب) النماذج من cache:** `HermesModels.getSupportedModels` يُعيد `HERMES_FALLBACK_MODELS` (static)؛ ترقية م2: قراءة `provider_models_cache.json` مع إبقاء static fallback. `caps.modelPicker.source='catalog'` يسمح بشارة «من ذاكرة هرمز» + زر التحديث القائم.

**(ج) نافذة السياق:** 256K من `context_length_cache.yaml` تغذّي `total`. لكن **لا يكفي لعدّاد** (يحتاج `used` غير متوفّر لحظياً) → في م1 يُمرَّر `contextWindow` لكن `tokenCounter.supported=false` يبقى (العدّاد محجوب).

**(د) الحصة (B-91):** لا حقل «متبقٍّ». REST `provider-auth-status` يقرأ `auth.json` ويُسقط `ok|expiring|exhausted`؛ WS عند رصد 429 في `hermes-cli.js` يبثّ `kind:'status', text:'quota_status', state:'exhausted'`. `caps.quota.supported` يُظهر الشارة. **لا يُلفَّق رقم متبقٍّ** (حالة لا عدّاد). «no final response» عند `exhausted` → رسالة «نفدت حصة هذا النموذج، جرّب آخر» لا «خطأ».

**(هـ) تصحيح الأذونات (م1):** `getPermissionModesForProvider` يُسقط هرمز في الافتراضي 4 أوضاع مضلِّلة (`hermes -z` headless يتجاوزها). الإصلاح: مصدره `caps.permissions.modes=['default']`.

---

## 6. معالجة B-92 وقيد التوكنز اللحظية في هرمز

### 6.1 تشخيص B-92 (مثبت كوداً)
1. `ChatComposer.tsx:428` يستدعي `<TokenUsageSummary usage={tokenBudget} />` **دون شرط مزوّد**.
2. هرمز لا يبثّ `token_budget` إطلاقاً (المُصدِرون: claude/opencode/gemini/codex فقط).
3. الجلب الأوّلي REST مبوَّب (`useChatSessionState.ts:683`) للأربعة ⇒ هرمز `setTokenBudget(null)`.
4. `tokenBudget===null` ⇒ فرع `!hasWindow` (`TokenUsageSummary.tsx:95-108`) يرسم شارة `0` — **مضلِّلة**.

### 6.2 الإصلاح (م1، يتبع الواصِف لا شرطاً جديداً)
```
ChatComposer.tsx:428
  قبل:  <TokenUsageSummary usage={tokenBudget} />
  بعد:  {caps.tokenCounter.supported && <TokenUsageSummary usage={tokenBudget} />}
```
حيث `supported=true` للباثّين الأربعة، `false` لهرمز/agy. الحجب الكامل (لا إخفاء الرقم فقط، لا 0-state) — **حسم S1-Q3 (3/0)**. لا يُلمَس منطق المكوّن الداخلي، ولا يُضاف `provider==='hermes'`. الإصلاح في **موقع الاستدعاء** لا داخل المكوّن (أنظف من فرع ثالث).

### 6.3 قيد التوكنز اللحظية وبدائله
**القيد المثبت:** عدّاد لحظي **غير ممكن** لهرمز في `-z` (oneshot يُصمت stdout، الحقول داخلية في `AIAgent`). نسّاج headless لهرمز. ⇒ `liveCounter='post-session'` لا تأجيل.

**مسار م3 الاختياري (نظير `opencode-cli.js:268` المثبت):**
```
hermes-cli.js → on('close', code===0) → readHermesTokenUsage(finalSessionId)  [قراءة state.db]
  → ws.send({ kind:'status', text:'token_budget', tokenBudget:{used,total}, provider:'hermes' })
     (used من state.db، total من context_length_cache.yaml)
  → useChatRealtimeHandlers.ts:523 → setTokenBudget → TokenUsageSummary
```
**حسم S3-Q2 (3/0): عرض هجين** — العدّاد **محجوب أثناء الجريان** (لا قيمة صادقة في `-z`)، **يظهر فقط بعد `complete`** بقيمة `state.db` مع tooltip «حتى آخر ردّ» لنفي إيحاء اللحظية الكاذب. عند تفعيل م3 يُقلب `tokenCounter.supported=true` لهرمز فيظهر العدّاد (لقطة بعد turn لا تدفّق). **حتى ذلك العدّاد محجوب لا مزيّف.**

---

## 7. سيناريوهات التشغيل والحالات الحدّية

| # | السيناريو | المكوّن/الملف | السلوك المتوقع بعد الواصِف | المرحلة |
|---|---|---|---|---|
| S1 | عدّاد توكنز لهرمز | `ChatComposer.tsx:428` | لا يُركَّب إطلاقاً عند `!tokenCounter.supported` | م1 |
| S2 | منتقي تفكير لهرمز | `ChatComposer.tsx:414` | منتقي `reasoning_effort` (low/medium/high/xhigh) | م2 |
| S3 | أذونات هرمز | `useChatProviderState.ts:53` | `['default']` فقط (headless) | م1 |
| S4 | تبديل أثناء بثّ نشط | `dispatchProviderCommand` | الطلب الجاري مُجمّد لحظة الإرسال (إغلاق `useCallback:759`)؛ المُؤلِّف يتبع `provider` الحيّ؛ تصفير `tokenBudget` عند التبديل | م0 |
| S5 | مزوّد غير مُصادَق | `ProviderSelectionEmptyState` | شارة + تعطيل الإرسال؛ فحص `auth.state` **يُعاد عند الإرسال** لا الاختيار فقط | م1 |
| S6 | استنفاد حصة هرمز (B-91) | `hermes-cli.js` | `quota.supported`: «الحصة نفدت — التجدّد بعد …» لا «خطأ» | م2 |
| S7 | fallback تلقائي | `fallback_providers` | محافظ: الإبقاء على واصِف الأصل + شارة «via fallback» صغيرة (الشفّاف م3) | م2/م3 |
| S8 | مرايا/مشاهدون متعددون | `chat-websocket.service.ts` | الواصِف يُبثّ ضمن `provider_state` عند **الانضمام** لا فقط البدء؛ مرآة منضمّة تستلمه فوراً؛ فيتو no-swap محترم | م0 |
| S9 | جديد مقابل استئناف | `hermes-cli.js:55` | الاستئناف يُعيد بناء الواصِف من `getSessionProvider` (الصف المخزَّن) لا آخر اختيار؛ يمنع عدّاد Claude لجلسة هرمز | م0 |
| S10 | build/restart | `build:client`/`build:server` | م0/م1/م2(أمامي) = `build:client` بلا restart؛ م2(خادمي)/م3 = `build:server`+restart (يطلبه المستخدم بطرفيته — حارس العميل) | كل المراحل |
| S11 | RTL وعرض القيم | الشارات/المنتقيات | الترتيب منطقي (low→xhigh)؛ محاذاة يمين؛ `toLocaleString(i18n.language)`؛ `:free` بـLTR isolate | م1/م2 |
| S12 | عرض الأخطاء | `useChatRealtimeHandlers` | تصنيف عبر الواصِف (غير مثبَّت/حصة/مصادقة/cwd مفقود/عام)؛ كل خطأ يحمل `provider` | م1/م2 |
| S13 | تعدد المستخدمين | `resolveProviderEnv` | الواصِف يُشتقّ لكل عملية فرعية من بيئتها المعزولة (`CLAUDE_CONFIG_DIR`/`auth.json` الخاص)؛ إن خُزِّن cache فالمفتاح يشمل هوية المستخدم (تفادي خطر `IS_PLATFORM`) | م0 |

**مصفوفة تقاطعات حرجة:** تبديل أثناء بثّ + مرايا → `provider_state` يُعاد بثّه لكل المرايا عند التبديل؛ استئناف + حصة نفدت → الواصِف يُعرَض والإرسال يكشف 429؛ fallback + عدّاد → الإبقاء على واصِف الأصل؛ build:client فقط + بثّ م3 → العميل لا يفترض `post-session` إلا إن أكّده الواصِف القادم من الخادم.

**المبدأ الناظم:** كل سلوك UX يُشتقّ من الواصِف، والواصِف من المصدر الموثوق للعملية الفرعية الفعلية، ويُبثّ ضمن حالة الجلسة لا كحالة عميل محلية. يحلّ معاً: B-92 (حذف لا تعطيل)، التشتّت، المرايا، تعدد المستخدمين، الاستئناف.

---

## 8. المعمارية الكلية ومخطط الطبقات

```
┌─────────────────────────────────────────────────────────────────────┐
│ L4 العرض: ChatComposer · ProviderSelectionEmptyState · TokenUsageSummary
│    ↳ تقرأ القدرة من الواصِف فقط — صفر شروط provider===… للقدرات الستّ
├─────────────────────────────────────────────────────────────────────┤
│ L3 الواصِف (قلب ADR-047): PROVIDER_UI_CAPABILITIES[provider]
│    ↳ كائن ثابت declarative، يُجمَّع وقت البناء، لا I/O وقت التشغيل
│    ↳ getProviderCapabilities(provider, engineProvider?) خالصة متزامنة مذكَّرة
├─────────────────────────────────────────────────────────────────────┤
│ L2 المصدر الحيّ (اختياري، يُحقَن في حقول قائمة):
│    ثابت (م0–م2): catalog (REST) · contextWindow (yaml) · quota (auth.json+429)
│    بثّ خادمي (م3، خلف بوابة): عدّاد هرمز من state.db عبر chat-websocket.service
├─────────────────────────────────────────────────────────────────────┤
│ L1 المصادر الخام: config.yaml · auth.json · provider_models_cache.json ·
│    context_length_cache.yaml · state.db · hermes insights
│    ↳ نسّاج headless لهرمز: لا stdout توكنز في -z
└─────────────────────────────────────────────────────────────────────┘
```

**حدّ الانتقال L3-static → L2-stream (بوابة م3):** الواصِف ثابت بالكامل في م0–م2. الانتقال للبثّ الخادمي ليس حتمياً، يُحكم بثلاثة شروط مجتمعة:

| الشرط | العتبة | المنطق |
|---|---|---|
| G-DATA | `state.db` يحوي حقل توكنز موثوقاً بعد كل turn | بلا مصدر موثوق، البثّ يفبرك أرقاماً — تكرار مضادّ لـB-64 |
| G-DEMAND | طلب مستخدم متكرّر صريح على عدّاد هرمز | بلا طلب، الجهد ضائع — م3 «اختياري» |
| G-COST | كلفة قارئ state.db + حدث WS < قيمة العدّاد | state.db بعد الجلسة فقط → «لحظي» وهمٌ بنيوي؛ أفضل ما يُقدَّم «آخر جلسة» |

**القاعدة:** الواصِف الثابت يبقى **مصدر القدرة** حتى لو وُصل البثّ؛ البثّ يحقن **قيمة** لا يبدّل **بنية**. غياب البثّ = درجة سفلية شريفة. م3 قد لا يُنفَّذ أبداً، وهذا مقبول تصميمياً.

---

## 9. الترحيل المرحلي م0→م3 ومعايير القبول

### م0 — الواصِف (محايد لـClaude حرفياً) | Foundation
**النطاق:** إنشاء `ProviderUiCapabilities` + الخريطة + `getProviderCapabilities`. تحويل المواقع الستّ لقراءة الواصِف مع تثبيت قيم Claude حرفياً. **إعادة `getPermissionModesForProvider` و`getProviderDisplayName` فوق الواصِف فوراً** (حسم S1-Q2، 3/0).

| AC | المعيار | التحقّق |
|---|---|---|
| AC-0.1 | تجربة Claude غير متغيّرة بصرياً وسلوكياً | snapshot e2e قبل/بعد متطابق بكسلياً |
| AC-0.2 | صفر شروط `provider === 'claude'` متبقّية في L4 للقدرات الستّ | Grep = 0 لمواقع القدرات |
| AC-0.3 | الواصِف يغطّي كل المزوّدات الـ10 (لا undefined) | unit: `Object.keys ⊇ LLMProvider` |
| AC-0.4 | مزوّد بلا إدخال → fallback آمن | unit: مزوّد وهمي → كل الحسّاس `false/none` |

**بوابة الحياد:** م0 لا تُغلق إلا بـAC-0.1 مثبتاً. أي انحراف في Claude = إخفاق بوابة لا «تحسين».

### م1 — إصلاح هرمز السلبي (إغلاق B-92) | Negative-Path
**النطاق:** `tokenCounter.supported=false` لهرمز → إخفاء `TokenUsageSummary` كلياً؛ تصحيح `permissions.modes=['default']`.

| AC | المعيار | التحقّق |
|---|---|---|
| AC-1.1 | العدّاد غائب تماماً (لا DOM node) لهرمز | e2e: `not.toBeInTheDocument()` |
| AC-1.2 | لا انحدار للباثّين | العدّاد يظهر كما كان |
| AC-1.3 | أذونات هرمز تطابق الخلفي الفعلي | integration |
| AC-1.4 | B-92 مغلق بمهمة `kind:bug` باللوحة | `project-state.json` |

### م2 — مكافئات هرمز | Positive Equivalents
**النطاق:** (أ) `ReasoningEffortSelector` بقيم `{low,medium,high,xhigh}`؛ (ب) `quota.supported` يقرأ `auth.json(last_status)` ويعكس exhausted عند 429.

| AC | المعيار | التحقّق |
|---|---|---|
| AC-2.1 | منتقي effort يظهر ويمرّر القيمة للأمر | e2e: `high` → الطلب يحمل reasoning_effort=high |
| AC-2.2 | القيم تطابق المدعوم خادمياً | unit |
| AC-2.3 | مؤشّر الحصة يعكس exhausted فور 429 | integration |
| AC-2.4 | الحصة حالة لا نسبة مفبركة (لا progress bar) | مراجعة UX (مضادّ B-64) |
| AC-2.5 | منتقي Claude لم يتأثر | snapshot |

**بوابة الربط الخادمي (S3-Q1):** قبل بناء UI، شغّل فعلياً `hermes -z … --reasoning-effort high` وارصد الأثر؛ إن فشل العلم → متغيّر بيئة per-spawn عبر `resolveProviderEnv`.

### م3 — عدّاد هرمز من state.db + بثّ خادمي (اختياري، خلف بوابة)
**بوابة التفعيل:** G-DATA ∧ G-DEMAND ∧ G-COST. **لا يُبدأ قبل اجتيازها.**

| AC | المعيار |
|---|---|
| AC-3.1 | العدّاد موسوم «آخر جلسة»/«حتى آخر ردّ» لا «الآن» (هجين S3-Q2) |
| AC-3.2 | الحدث الجديد لا يكسر مستهلكي WS القدامى (يتجاهلون المجهول) |
| AC-3.3 | فشل قراءة state.db = درجة سفلية لـ`supported=false` |
| AC-3.4 | لا تسريب قيم هرمز لمزوّد آخر (تبديل يمسح القيمة) |

---

## 10. استراتيجية الاختبار

| الطبقة | الأداة | النطاق | ما يُختبر |
|---|---|---|---|
| Unit | Vitest | L3 الواصِف | اكتمال الخريطة، fallback، نقاء القيم (effort aliases، permission sets) |
| Integration | Vitest + mock WS/REST | L4↔L3↔L2 | حقن القيم الحيّة؛ 429→quota؛ catalog→models |
| E2E | Playwright | المسار الكامل | إظهار/إخفاء فعلي لكل مزوّد، RTL، تبديل المزوّد |

**مصفوفة التغطية الدنيا** (المرجعيان: claude=regression، hermes=feature؛ البقية اختبار جدولي):

| القدرة | claude | hermes | ثالث (smoke) |
|---|---|---|---|
| effort | snapshot يظهر | e2e: 4 قيم | جدولي |
| tokenCounter | snapshot live يظهر | e2e: **غائب** (م1)/posthoc موسوم (م3) | جدولي |
| permissions | unit: 5 أوضاع | integration: ⊆ المدعوم | جدولي |
| quota | — | integration: 429→exhausted | جدولي |
| displayName | unit: "Claude" | unit: "Hermes (Nous)" | جدولي: لا undefined |

**اختبار الحياد (الأهم، م0):** e2e يلتقط `ChatComposer` بـclaude قبل/بعد فرع الواصِف ويؤكّد التطابق البكسلي — خطّ الدفاع ضدّ كسر Claude.
**اختبار العزل:** claude→hermes→claude يعيد الحالة الأصلية تماماً (مضادّ تسرّب T-121).

---

## 11. الإطلاق والتراجع وسجل المخاطر

### الإطلاق
| المرحلة | العلَم | المنطق |
|---|---|---|
| م0/م1 | **بلا علَم** | حياد/إصلاح عيب — لا سطح جديد يُخفى |
| م2 | `provider_capabilities_hermes_equiv` | سطح UX جديد، ارتداد فوري |
| م3 | `hermes_live_token_counter` (off) | خلف بوابة G + علَم منفصل |

### التراجع
| السيناريو | الإجراء | الاسترداد |
|---|---|---|
| انحدار Claude بعد م0 | git revert + build:client | < دقائق |
| منتقي effort يعطّل الإرسال | إطفاء علَم م2 | فوري |
| بثّ م3 يفبرك/يُغرق | إطفاء علَم م3 → `supported=false` | فوري |
| واصِف معطوب (مزوّد بلا إدخال) | fallback (AC-0.4) | مدمج |

> الواجهة تكفيها `build:client` بلا restart → revert/إطفاء العلَم رخيص، يقوّي حجّة «بلا علَم» لـم0/م1.

### سجل المخاطر
| ID | المخاطرة | احتمال | أثر | التخفيف | درس |
|---|---|---|---|---|---|
| R1 | refactor م0 يكسر Claude | متوسط | حرج | اختبار الحياد بوّابة صلبة؛ AC-0.1؛ revert ذرّي | — |
| R2 | state.db ليس «لحظياً» | عالٍ | متوسط | م3 اختياري؛ لصيقة «آخر جلسة»؛ G-DATA | جرد هرمز |
| R3 | تلفيق أرقام حصة/توكنز | متوسط | عالٍ | حالة لا نسبة (AC-2.4)؛ لا progress bar | **B-64** |
| R4 | تسرّب قيم عند التبديل | متوسط | متوسط | اختبار العزل؛ AC-3.4؛ تصفير tokenBudget | **T-121** |
| R5 | أذونات هرمز بلا أثر | عالٍ | متوسط | تقليص `['default']` في م1 | نظير B-92 |
| R6 | مزوّد جديد ينسى إدخالاً | متوسط | عالٍ | fallback إجباري؛ اختبار اكتمال | — |
| R7 | بثّ م3 يكسر مستهلكي WS | منخفض | عالٍ | حدث جديد يتجاهله القدامى؛ علَم منفصل | قيود hermes-cli |
| R8 | scope creep (م3 بلا طلب) | متوسط | متوسط | G-DEMAND؛ م3 «اختياري» | استئناف المنوال |
| R9 | RTL يكسر التخطيط | منخفض | متوسط | e2e RTL؛ محاذاة مرآتية | — |

---

## 12. مسوّدة ADR-047

```
# ADR-047: واصِف قدرات الواجهة لكل مزوّد (Provider UI Capability Descriptor)
الحالة: مقترح (Proposed) · التاريخ: 2026-06-27 · السياق: PLAN-v1 (الأقسام 1–11)

## السياق
منطق «أيّ UX يظهر لأيّ مزوّد» مبعثر provider==='x' مكرّر 3+ مرّات عبر 4+ ملفات.
(1) كل مزوّد جديد = جولة تعديلات هشّة. (2) B-92: TokenUsageSummary بلا حارس لهرمز → "0" مضلّل.
(3) منتقي التفكير مبوَّب صلباً لـclaude رغم دعم هرمز reasoning_effort. الخادم يملك seam قدرات
في IProvider؛ الواجهة لا نظير.

## القرار
واصِف أمامي declarative واحد (L3) مصدراً وحيداً للقرار العرضي:
  PROVIDER_UI_CAPABILITIES: Record<LLMProvider, ProviderUiCapabilities>
يُقرأ عبر getProviderCapabilities(provider, engineProvider?). L4 تقرأ القدرة فقط — صفر شروط
provider=== للقدرات الستّ. الواصِف ثابت (لا I/O) في م0–م2؛ القيم الحيّة تُحقَن في حقول قائمة.
البثّ الخادمي (م3) اختياري خلف G-DATA∧G-DEMAND∧G-COST.
الترحيل: م0 الواصِف (محايد لـClaude حرفياً) · م1 إصلاح هرمز السلبي (B-92 + الأذونات) ·
م2 مكافئات (reasoning_effort + حصة حالة-لا-نسبة) · م3 (اختياري) عدّاد state.db + بثّ.

## البدائل المرفوضة
- إبقاء provider=== + حارس نقطي لـB-92: يعالج العَرَض لا العلّة.
- server-driven UI كامل: كلفة بلا عائد؛ معظم القدرات ثابتة معروفة وقت البناء.
- توحيد PROVIDER_META/displayName دون واصِف شامل: يحلّ عَرَضاً واحداً.

## النتائج
+ مزوّد جديد = إدخال واحد (O(مزوّدات)). + B-92 مغلق بنيوياً. + هرمز يحصل مكافئات حقيقية.
+ تماثل أمامي/خلفي مع IProvider يمهّد لـم3 دون إعادة تصميم.
− كلفة م0 (refactor + اختبار الحياد) قبل قيمة مرئية. − خطر R1 يتطلّب بوّابة حياد صلبة.

## الروابط
يوحّد: ChatComposer.tsx:414,428 · useChatProviderState.ts:53-64 ·
useChatComposerState.ts:372-391,633-755 · ProviderSelectionEmptyState.tsx:37-48,117-128
يُغلق: B-92 · دروس: B-64 (لا تلفيق) · T-121 (لا تسرّب) · B-91 (no final response=حصة)
```

---

## 13. القرارات المعتمدة بالأغلبية

> ثلاثة محكّمين صوّتوا على ثمانية أسئلة متنازعة. **كل القرارات بإجماع 3/0** (المحكّمون الثلاثة طابقوا توصية الفريق في كل سؤال). فيما يلي الخيار المعتمد وتوزيع الأصوات.

| السؤال | الخيار المعتمد (أغلبية) | التوزيع | الأثر في الخطة |
|---|---|---|---|
| **S1-Q1** موضع سُكنى الواصِف | ثابت أمامي محض في `providerCapabilities.ts` (لا اعتماد خادمي) | 3/0 (الباب مفتوح لحقول حيّة في م3) | §3.1، §8 (L3) |
| **S1-Q2** نطاق التوحيد في م0 | إعادة `getPermissionModesForProvider`/`getProviderDisplayName` فوق الواصِف **فوراً** | 3/0 | §3.3، §9/م0؛ حسم تضارب 'Claude'/'Anthropic' عبر `displayName`/`vendorName` |
| **S1-Q3** تمثيل «نافذة بلا عدّاد لحظي» لهرمز | **إخفاء العدّاد كلياً** عند `tokenCounter.supported=false` (لا شارة ساكنة) | 3/0 | §6.2، §4.3 |
| **S2-Q1** مصدر اشتقاق القدرات | **مصدران متمايزان**: `provider` للمُؤلِّف + `displayProvider` للمحادثة | 3/0 | §4.1 |
| **S2-Q2** معالجة `tokenBudget` العالق | **شرط القدرة + تصفير `setTokenBudget(null)`** في effect تغيّر provider | 3/0 (مع تنبيه: setTokenBudget في useChatSessionState) | §4.4، §4.5 |
| **S2-Q3** تبديل منتقي التفكير | **Swap حقيقي** (تركيب/إزالة شرطية) لا إخفاء CSS | 3/0 | §4.3 |
| **S3-Q1** تمرير reasoning_effort خادمياً | **افتراض علم argv `--reasoning-effort` + بوابة تحقّق فعلي قبل م2** | 3/0 (الرجوع: env per-spawn، لا config.yaml المشترك) | §5.2(أ)، §9/م2 |
| **S3-Q2** عدّاد هرمز من state.db (م3) | **عرض هجين**: محجوب أثناء الجريان، يظهر بعد `complete` بـtooltip «حتى آخر ردّ» | 3/0 | §6.3 |

---

## 14. جدول تتبّع المطالب

| # | مطلب المستخدم | القسم/الأقسام المغطّية | الحالة |
|---|---|---|---|
| (أ) | **كل المكوّنات ودمجها وعرضها** — جرد شامل لمكوّنات UX × المزوّدات، نموذج بيانات موحّد، كيفية استهلاك المكوّنات | §2 (الجرد الكامل: model picker, token counter, effort, permissions, quota, command, session) · §3 (الواصِف ونموذج البيانات والأمثلة المثبتة) · §5.0 (الجدول المركزي للربط) | مغطّى |
| (ب) | **آلية التبديل** — مصدر المزوّد النشط، دورة التركيب/الإزالة، التبديل أثناء بثّ، منع الوميض/التسرّب | §4 كامل (4.1 المصدران، 4.3 swap/hide، 4.4 منع التسرّب الثلاثي، 4.6 الاستقرار) · §7/S4 (التبديل أثناء بثّ) | مغطّى |
| (ج) | **ربط وتفعيل مكوّنات كل مزوّد وضمان تفعيلها** — مصدر بيانات كل قدرة، مسار الوصول، إشارة التفعيل لكل مزوّد | §5 كامل (5.0 الجدول × المصدر × إشارة التفعيل، 5.1 Claude، 5.2 هرمز a–e) · §6 (تفعيل/حجب العدّاد بنيوياً) | مغطّى |
| (د) | **كل سيناريوهات التشغيل** — 13 سيناريو + حالات حدّية + تقاطعات | §7 كامل (جدول S1–S13 + مصفوفة التقاطعات + المبدأ الناظم) | مغطّى |
| (هـ) | **الهيكلة/المعمارية والترحيل والاختبار** — الطبقات، م0→م3 بمعايير قبول، الاختبار، المخاطر، الإطلاق/التراجع، ADR | §8 (المعمارية والطبقات والبوابة) · §9 (الترحيل م0→م3 + AC) · §10 (الاختبار) · §11 (الإطلاق/التراجع/المخاطر) · §12 (ADR-047) | مغطّى |
| إضافي | **B-92 صراحةً** (العلّة المحرّكة) | §1، §6.1–6.2، §7/S1، §9/م1 (AC-1.1/1.4) | مغطّى |
| إضافي | **قيد التوكنز اللحظية في `-z`** | §2(ب)، §6.3، §13/S3-Q2 | مغطّى |

---

## 15. ملحق: مهام اللوحة المقترحة

> يُسجّلها المنسّق في `docs/project-state.json` (تنفيذ خارج هذه الخطة). كل قرار أغلبية = مهمة تتبّع، وB-92 = مهمة `kind:bug`.

- **B-92** (bug، critical UX): عدّاد توكنز هرمز المضلِّل → يُغلق في م1 (AC-1.4).
- **T-ADR-047**: اعتماد ADR-047 (واصِف قدرات أمامي) — قرار معماري.
- **T-م0**: إنشاء `providerCapabilities.ts` + `getProviderCapabilities` + إعادة القارئتين فوق الواصِف + اختبار الحياد.
- **T-م1**: إخفاء عدّاد هرمز + تصحيح أذوناته (`['default']`).
- **T-م2-effort**: `ReasoningEffortSelector` + بوابة تحقّق علم `--reasoning-effort`.
- **T-م2-quota**: `ProviderQuotaIndicator` + WS `quota_status` + REST `provider-auth-status`.
- **T-م3** (مؤجَّل، خلف G-DATA∧G-DEMAND∧G-COST): عدّاد هرمز من state.db + بثّ خادمي.
- **CTX قرارات الأغلبية الثمانية** (S1-Q1..S3-Q2): مسجّلة في §13، تُتعقَّب كقرارات معتمدة بتاريخ 2026-06-27.
