# مصفوفة توافق نسّاج ↔ OpenCode وخطة إكمال التوافق

- **التاريخ:** 2026-07-10 · **الحالة:** مسودة للاعتماد (بوابة قرار المالك §5) · **المؤلف:** architect
- **المراجعة:** رُوجعت نقدياً وهيكلياً (qa-critic، ‏2026-07-10 — مقبول بشروط) وطُبّقت تعديلاتها
- **الفرع:** `fix/security-remediation-2026-07-09` · **النطاق:** وثيقة تخطيط فقط — لا تعديل كود
- **المرجعيات:** `server/modules/providers/README.md` (§How To Add A Provider) · `docs/planning/provider-capabilities/PLAN-v1.md` (ADR-047/T-224) · OpenCode 1.17.18 المثبَّت في `/home/nassaj/.opencode/bin/opencode` · memory `reference_anthropic_tos_compliance.md`
- **سؤال المالك:** «مهم أن كلود كود وأوبن كود يشتغلوا بنفس التعليمات والآلية» — الجواب الهندسي الصريح في §1 وتفصيله في §2 و§4.

---

## 1. خلاصة تنفيذية

الوضع الفعلي: **تكامل بنيوي ~90%** (registry ‏`provider.registry.ts:29-36`، الواجهات الست كاملة `server/modules/providers/list/opencode/` — 7 ملفات + اختبارات، spawn حي `server/opencode-cli.js`، مزامنة جلسات من `opencode.db` مع watcher ‏`sessions-watcher.service.ts:44-46`، توكنز post-session، drain ‏`server/index.js:2356`، واجهة/شعار/i18n — كلها مؤكدة)، **وجاهزية وظيفية أدنى معلّقة على فجوات المهارات/الأوامر/التوكنز** (المحاور 3/8/9 والبنود OC-18/19/20).

**الحاجب الوحيد للتشغيل اليوم:** حلّ مسار الثنائي — مواقع النداء الثلاثة تستدعي `'opencode'` عارياً عبر PATH، وعملية PM2 لا ترى `~/.opencode/bin` (المضاف في `.bashrc` فقط) → المزوّد يظهر «غير مثبَّت». الحل سطر إعداد (M0) + مقبض `OPENCODE_PATH` (M1).

**الامتثال:** محسوم لدى المالك — التفصيل حصراً في المصفوفة 13 والقرار D1.

**جواب «نفس التعليمات والآلية» في ثلاث جمل:**
1. **نفس التعليمات: نعم عبر مصدر واحد يولّد مخرجين، لا بنسخ حرفي** — OpenCode يقرأ `AGENTS.md` أصلاً (ونسّاج-كور يولّده بـ `build-agents` منذ ADR-018)، أما `NASSAJ.md` حرفياً فيحوي ميكانيكا Claude-only (قاعدة صفرية، compact، حصص جلسة، توزيع نماذج fable/opus) تضلّل OpenCode بل تشلّه — والأخطر أنه **يقرؤه اليوم فعلاً** عبر fallback ‏`~/.claude/CLAUDE.md → NASSAJ.md` لغياب AGENTS.md عام (إصلاحه M0/OC-03).
2. **نفس الآلية التنفيذية: متقاربة وقابلة للتطابق خلال M0–M1** — spawn/جلسات/استئناف/مزامنة وتوكنز post-session تعمل بنفس نموذج نسّاج؛ أما المهارات فالتحميل من `~/.claude/skills` **مفعَّل بنيوياً لكنه لا-حتمي وناقص** (اختبار ميداني، 5 تشغيلات `debug skill`: ‏8–9 من 12، وmotion-ui غائب في كلها) — **لا يُدّعى التكافؤ قبل تشخيصه** (OC-18).
3. **الحاكمية والأذونات التفاعلية: تُقارَب ولا تتطابق** — hooks/managed-settings لا مكافئ لها بضماناتها؛ البديل opencode-plugin + `permission` config (M3)، والجسر التفاعلي ممكن مستقبلاً عبر serve+SDK فقط (M4). حصة الاشتراك وWorkflows وultracode: لا مكافئ بنيوياً (§4).

---

## 2. مصفوفة التوافق

الأحجام: S ≤ نصف يوم · M ≤ 3 أيام · L أسبوع+. المراسي كلها مُتحقَّقة 2026-07-10.

| # | المحور | حالة اليوم | الفجوة | الإجراء | الحجم |
|---|---|---|---|---|---|
| 1 | **تشغيل المزوّد بالواجهة** | مدمج كاملاً: registry، spawn ‏`opencode run --format json --session <id> --model <m>`، واجهة/شعار/i18n | `spawnFunction('opencode', …)` عارٍ في المواقع الثلاثة (`opencode-cli.js:224`، `opencode-models.provider.ts:217`، `opencode-auth.provider.ts:33`)؛ PM2 لا يرى `~/.opencode/bin` → «غير مثبَّت» | OC-01 (PATH في ecosystem) ثم OC-06 (`OPENCODE_PATH` على قالب `agy-cli.js:42`) | S |
| 2 | **الجلسات/الاستئناف/المزامنة** | تعمل: synchronizer يقرأ `~/.local/share/opencode/opencode.db` ويثبّت `jsonl_path=null` عمداً (README:234)؛ watcher على الدليل؛ resume عبر `--session` + `resolveResumeModel` | لا فجوة في المزامنة/الاستئناف ذاتهما؛ لكن الظهور بالقائمة والإسناد متعدد المستخدمين فيهما فجوة (المحور 15/OC-21)؛ والمسارات hardcoded على HOME الفعلي (تنكسر تحت عزل XDG لاحقاً — محور 11) | تحقق ميداني ضمن OC-01؛ مواءمة المسارات ضمن OC-07 | S |
| 3 | **التوكنز/السياق** | الخادم يبث `token_budget` بعد إغلاق العملية من `opencode.db` (`opencode-cli.js:268-277`، أعمدة tokens_input/output/reasoning/cache)؛ المستقبِل واجهةً يضبط tokenBudget لأي مزوّد (`useChatRealtimeHandlers.ts:565-566`) | **محجوب واجهةً**: إصلاح B-92 النقطي قيّد العرض بـ `provider === 'claude' && <TokenUsageSummary/>` (`ChatComposer.tsx:448`) فحجب عدّاد opencode المبثوث فعلاً — يناقض واصف PLAN-v1 (`opencode: tokenCounter live`). لا عدّاد لحظي في وضع run (بنيوي) | **مسار احتياطي لا يعتمد T-224: OC-20 (M1)** — توسيع البوابة لتشمل opencode (ومعه مؤشر تعفّن السياق — نفس البوابة)؛ الحل البنيوي يبقى في **T-224 م0/م1**؛ اللحظية عبر OC-16 (M4) | S |
| 4 | **النماذج والاختيار** | `opencode models` عبر CLI (`opencode-models.provider.ts:217`) يغذّي picker؛ `resolveResumeModel` يعمل | نفس حاجب PATH؛ ولا تمرير جهد استدلال (`--variant high\|max\|minimal` موجود في CLI وغير موصول) | OC-06 يحل الأول؛ variant عبر واصف T-224 م2 (`effort.field` جديد) — لا عمل هنا | S / M |
| 5 | **الأذونات** | مثبتة `['default']` (`useChatProviderState.ts:49-51`)؛ payload بلا `permissionMode` (`useChatComposerState.ts:795-804`) — متسق مع الواقع | opencode يملك نظام `permission` ‏allow/ask/deny بأنماط، لكن **سلوك ask في run غير التفاعلي غير محدد رسمياً**، ولا جسر `canUseTool`/`permission_request` (خاص بـ Claude SDK)؛ `--auto` مرفوض أمنياً | أذونات ثابتة declarative في الإعداد القياسي (OC-13)؛ الجسر التفاعلي حصراً عبر serve+SDK ‏(OC-15) | M ثم L |
| 6 | **التعليمات (AGENTS.md/instructions)** | opencode يقرأ AGENTS.md تلقائياً (مشروعي + `~/.config/opencode/AGENTS.md`) وCLAUDE.md ‏fallback؛ نسّاج-كور يولّد AGENTS.md محايداً (76 سطراً) | (أ) لا AGENTS.md عام لـ opencode → **fallback حي إلى NASSAJ.md** بميكانيكا Claude-only؛ (ب) المولَّد **قديم**: 22 وكيلاً من 23 (negotiator ساقط)؛ (ج) أقسام صالحة محايداً ساقطة منه (§3/M2) | OC-03 (نشر العام) + OC-04 (إعادة توليد) + OC-09 (توسيع التغطية) | S+M |
| 7 | **الوكلاء الـ 23** | بطاقات `agents/*.md` بحقول نسّاج (name_ar/role/scope/max_words/triggers، model من `_models.yaml`)؛ opencode **لا يقرأ `.claude/agents/` إطلاقاً** (مُختبَر) | صيغة opencode مختلفة (`agent/*.md` بـ frontmatter ‏`mode: subagent, model, permission…`)؛ ودلالات توزيع النماذج (fable/opus/sonnet/haiku لكل دور) تتوقف على مزوّد opencode المعتمد (D1) | OC-10: target ثالث في build-agents يولّد `~/.config/opencode/agent/*.md` من نفس المصدر | M |
| 8 | **المهارات (12)** | التحميل من `~/.claude/skills/*/SKILL.md` **مفعَّل بنيوياً لكنه لا-حتمي وناقص**: اختبار ميداني (5 تشغيلات `debug skill`) أظهر 8–9 من 12، وmotion-ui غائب في كل التشغيلات؛ README:187 يؤكد المسارات | **لا يُدّعى التكافؤ قبل تشخيص سبب الفقد** (فرضيات: read-timeout ‏5s، حدّ تزامن، حجم/frontmatter)؛ وقراءة skills تتبع HOME الفعلي لا XDG → تحت عزل per-user (محور 11) يفقد المستخدم المعزول المهارات المشتركة | **OC-18 (M1): تشخيص الفقد** بمعيار 12/12 عبر 5 تشغيلات متتالية؛ مواءمة العزل داخل OC-07 (symlink في شجرة المستخدم أسوة بـ provisionUserDirs) | S/M |
| 9 | **الأوامر المائلة** | السلوك القائم المؤكد: (أ) جلسة opencode تُعرض لها built-ins كلود الثابتة المضلِّلة `/cost /memory /config…` — ‏`server/routes/commands.js:487` ‏(`if (provider !== 'claude') return builtInCommands`)؛ (ب) ملفات `.claude/commands` تُعرض لأي مزوّد وتُرسل نصاً خاماً (`commands.js:810-829`)؛ (ج) أوامر opencode الأصلية `~/.config/opencode/command/` **غير ممسوحة إطلاقاً** في نسّاج | قائمة أوامر مضلِّلة للمستخدم + غياب أوامر opencode الأصلية من `/api/commands/list`؛ وأوامر نسّاج وplugins كلود (code-review/simplify/github…) غير محمولة كما هي | **OC-19 (M1)**: مسح `~/.config/opencode/command/` وعرضها في `/api/commands/list` عند provider=opencode + فلترة/تحييد built-ins غير المنطبقة؛ OC-11 (M2): توليد المكافئ الصالح فقط + توثيق المستثنى | S/M |
| 10 | **الحاكمية (zero-rule/deny-floor)** | كلود: 7 hooks + managed-settings (`/etc/claude-code/managed-settings.json`) بأرضية منع 24 بنداً غير قابلة للكسر؛ opencode: **صفر حواكم** | لا مكافئ native؛ الأقرب: opencode-plugin بخطافي `tool.execute.before` (منع برمي استثناء) و`permission.ask` + طبقة `permission` config — **مع ثغرة معلنة: `--pure`/`OPENCODE_PURE=1` يعطّل الـ plugins** | OC-12 (plugin الحارس) + OC-13 (طبقة config) + قبول الحدود في §4 | L |
| 11 | **العزل متعدد المستخدمين** | spawn يمرّر `{...process.env}` خاماً (`opencode-cli.js:227`) ولا حالة `opencode` في `resolve-provider-env.js:85-131` (يسقط في default: shared)؛ آلية العزل مثبتة تجريبياً: `XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_STATE_HOME` تعيد توجيه كل شيء **بما فيه `auth.json`** — نظير `CLAUDE_CONFIG_DIR` | إضافة الحالة + تمرير `resolveProviderEnv` + مواءمة **أربعة قرّاء hardcoded على HOME**: ‏`opencode-auth.provider.ts:62` (auth.json)، synchronizer، watcher:44، وقارئ التوكنز في `opencode-cli.js` | OC-07 (خلف `isProviderIsolated` — الوضع المشترك بلا تغيير بايت) | M/L |
| 12 | **الخصوصية (share/autoupdate)** | لا إعداد بعد (لا `~/.config/opencode/opencode.json`)؛ الافتراضيات: `share: manual` (روابط عامة `opncd.ai/s/…` ممكنة يدوياً)، autoupdate فعّال، telemetry غير موثقة | يلزم فرض `share:"disabled"` و`autoupdate:false` أسطولياً (D3) | OC-02 (الإعداد القياسي) | S |
| 13 | **المصادقة والامتثال** | محسوم لدى المالك (اشتراك Claude داخل opencode محظور — بما فيه الإضافة المجتمعية)؛ لا اعتمادات (`providers list` = 0)؛ حارس iron-rule يستثني opencode صراحةً وعن حق (`anthropic-base-url-guard.js:31-34` — نطاقه بيئة Claude فقط) | لا فحص يكشف حقن اعتماد OAuth في `auth.json` | D1 (قرار المسار) + OC-14 (فحص سياسة موثَّق) | S |
| 14 | **المراقبة (usage/drain)** | drain يعدّ جلسات opencode الحية (`server/index.js:2356`)؛ `claude-usage.js` يقرأ حصة اشتراك Anthropic OAuth حصراً | لا مكافئ لحصة الجلسة/الأسبوع — وفي مسار API-key المفهوم أصلاً **فوترة لا حصص** (المراقبة = ميزانية/تنبيه إنفاق لدى المزوّد)؛ بوابة safe-restart تفحص journals ‏Claude SDK فقط (جلسة opencode تُحسب بعدّ الذاكرة فحسب) | قبول الفرق صراحةً (§4) + OC-08 (تقرير جلسات opencode في رسالة تأجيل safe-restart) | S |
| 15 | **رؤية/تسمية/حذف الجلسات متعدد المستخدمين (ADR-052)** | التسمية تعمل عامّةً بالمعرّف، والمزامن يحفظ `custom_name` (`opencode-session-synchronizer.provider.ts:115-119`)؛ الحذف آمن على `opencode.db` ‏(`jsonl_path=null` عمداً) | **فجوة**: مسار spawn opencode لا يسجّل participant/message-author — لا `recordSpawn` في `opencode-cli.js` ولا في `chat-websocket.service.ts:452` ولا `routes/agent.js:1020` (بعكس `claude-sdk.js:1321`، `agy-cli.js:804`، `gemini-cli.js:159`، `cursor-cli.js:63`، `openai-codex.js:277`) → (أ) الجلسات تفشل شرط NATIVE_SESSION_PREDICATE ‏(`sessions.db.ts:50-53`) المطبَّق على قائمة المشروع المرقّمة (`sessions.db.ts:196,212`)، (ب) لا بيانات مالك لدلالات ADR-052 ‏(`resolveOwnersForRows` يعيد null — ‏`projects-with-sessions-fetch.service.ts:251-268`)، (ج) upsert المزامن يعيد `isArchived=0` ‏(`sessions.db.ts:86`) → خطر بعث جلسة مؤرشفة | **OC-21 (M1)**: تسجيل spawn/authorship لجلسات opencode أسوة بالمزوّدات الأخرى + اختبار ميداني للقائمة ضمن قبول OC-01 + حسم سلوك إعادة البعث | M |
| 16 | **ضبط/عرض MCP** | **لا فجوة وظيفية**: `OpenCodeMcpProvider` كامل — نطاقا user/project ونوعا stdio/http ‏(`opencode-mcp.provider.ts:126-129`)، قراءة/كتابة قسم `mcp` في `opencode.json/.jsonc` مع تجريد JSONC ‏(`:32-124`)، مسجَّل عبر `OpenCodeProvider` ‏(`provider.registry.ts:29`) | ملاحظة عزل فقط: مسار الإعداد ثابت على `os.homedir()` ‏(`opencode-mcp.provider.ts:110`) — قارئ/كاتب **خامس** يُضاف لمواءمة OC-07 | ضمّه لقائمة مواقع OC-07 | — |
| 17 | **رسائل أخطاء runtime للمستخدم** | القناة موجودة: stderr يُمرَّر كرسالة خطأ (`opencode-cli.js:244-252`)، خروج غير صفري → رسالة عامة (`:135`)، أخطاء spawn مصنفة بنمط B-32 ‏(`:309-330` — منها `cli_not_installed`) | **فجوة جزئية**: لا تصنيف دلالياً لحالات «نموذج غير مصادَق/حصة free نفدت» (نظير حادثة B-91 في hermes) — الاعتماد على وضوح stderr الخام | فحص ميداني للحالتين ضمن قبول OC-01؛ إن ظهر غموضٌ نظيرُ B-91 يُفتح بند تصنيف | S |
| 18 | **الإلغاء/abort** | **لا فجوة**: `abortOpenCodeSession` ‏(`opencode-cli.js:341-350` — SIGTERM عبر خريطة `activeOpenCodeProcesses`) موصول من مسار الإيقاف الموحد (`chat-websocket.service.ts:486-487`) | — | لا عمل | — |
| 19 | **المرفقات/الصور** | مسار claude يمرّر `images` في الحِمل (`useChatComposerState.ts:850`) | **فجوة**: حِمل `opencode-command` بلا مرفقات/صور (`useChatComposerState.ts:795-804`) — المستخدم يرفق صورة فلا تصل | **OC-22 (M1)**: استكشاف قدرة `opencode run` على استهلاك مرفقات ثم توصيلها، وإلا توثيقه حداً معلناً في §4 | S/M |

---

## 3. خطة العمل M0 → M4

> **الترقيم:** المعرّفات هنا OC-01…OC-22 مقترحة؛ يخصص المنسّق أرقام اللوحة النهائية عند التسجيل (آخر مرصود: T-845 / B-160 — جلسات متوازية تستهلك أرقاماً). ما يتقاطع مع **T-224/ADR-047** أو **B-92** يُنفَّذ هناك ولا يُكرَّر هنا.

### M0 — فوري، بلا كود (تفعيل + سدّ الثغرات التوجيهية)

| ID | البند | الملفات/المواضع | معيار القبول |
|---|---|---|---|
| OC-01 (S) | إلحاق `/home/nassaj/.opencode/bin` بـ PATH في `ecosystem.<node>.config.cjs` ثم نشر وفق §6 | `ecosystem.nassaj.config.cjs` (كل عقدة ملفها — درس B-110) | بطاقة opencode بالواجهة لم تعد «غير مثبَّت»؛ `opencode --version` يعمل من عملية PM2 |
| OC-02 (S) | الإعداد القياسي `~/.config/opencode/opencode.json` وفق D3 (مسودة §7.2): ‏`share:"disabled"`, `autoupdate:false`, أرضية `permission` | ملف إعداد جديد خارج الريبو (أصل أسطول في nassaj-core لاحقاً) | `opencode run 'ping'` يمر؛ مفتاح مجهول → `ConfigInvalidError` صريح (فحص قبل التعميم) |
| OC-03 (S) | نشر `~/.config/opencode/AGENTS.md` (نسخة/symlink للمولَّد) **لقطع fallback الحي إلى NASSAJ.md** | `~/.config/opencode/AGENTS.md` ← `nassaj-core/AGENTS.md` | جلسة opencode تُظهر تعليمات AGENTS.md لا NASSAJ.md (تحقق عبر debug/سؤال الجلسة عن تعليماتها) |
| OC-04 (S) | إعادة توليد AGENTS.md: إصلاح سقوط negotiator (22/23) | `nassaj-core/scripts/build-agents` (تشغيل فقط) | `build-agents --check` يمر وnegotiator في الفهرس |
| OC-05 (قرار) | تسجيل D1–D3 (بوابة §5) قرارات/مهام تتبع في اللوحة | `docs/project-state.json` (يسجله المنسّق) | كل قرار له مهمة تتبع بتاريخ |

### M1 — كود خفيف في nassaj-dev (تصليب التشغيل)

| ID | البند | الملفات/المواضع | معيار القبول |
|---|---|---|---|
| OC-06 (S) | مقبض `OPENCODE_PATH` بنمط agy: `process.env.OPENCODE_PATH \|\| ~/.opencode/bin/opencode` في مواقع النداء الثلاثة + تحديث README المزوّدات | `server/opencode-cli.js:224` · `opencode-models.provider.ts:217` · `opencode-auth.provider.ts:33` · `server/modules/providers/README.md` | بلا PATH موروث: auth-status يكشف الثنائي وspawn/models يعملان؛ اختبارات الوحدة القائمة تمر |
| OC-07 (M/L) | عزل per-user: حالة `opencode` في resolveProviderEnv (حقن XDG_* الأربعة نحو شجرة المستخدم) + تمرير البيئة المحلولة في spawn + مواءمة القرّاء الأربعة hardcoded (auth.json / synchronizer / watcher / قارئ التوكنز) + symlink للمهارات المشتركة (محور 8) — كله خلف `isProviderIsolated('opencode')` | `server/services/isolation/resolve-provider-env.js:85-131` · `server/opencode-cli.js:227` · `opencode-auth.provider.ts:62` · `sessions-watcher.service.ts:44-46` · synchronizer | عند العزل: auth.json وopencode.db تحت شجرة المستخدم ولا تسرب لِـ HOME؛ الوضع المشترك **بلا تغيير بايت** (اختبار snapshot للبيئة) |
| OC-08 (S) | إظهار جلسات opencode الحية في رسالة تأجيل safe-restart (اليوم تُعدّ في drain بلا تسمية) | `scripts/safe-restart.sh` (قراءة عدّادات drain القائمة) | جلسة opencode جارية → التأجيل يسمّي المزوّد والعدد |
| OC-18 (S/M) | تشخيص فقد المهارات اللا-حتمي (8–9 من 12، motion-ui غائب دائماً — محور 8): اختبار الفرضيات (read-timeout ‏5s، حدّ تزامن، حجم/frontmatter) وإصلاح السبب أو توثيقه حداً | جانب opencode (config/بنية `~/.claude/skills`)؛ لا كود نسّاج متوقعاً | `debug skill` يُظهر **12/12 عبر 5 تشغيلات متتالية** |
| OC-19 (S/M) | أوامر opencode الأصلية: مسح `~/.config/opencode/command/` وعرضها في `/api/commands/list` عند provider=opencode + فلترة/تحييد built-ins كلود غير المنطبقة (`/cost /memory /config…`) | `server/routes/commands.js:487` (فرع `provider !== 'claude'`) و`:810-829` | جلسة opencode ترى أوامرها الأصلية ولا ترى built-ins كلود غير المنطبقة |
| OC-20 (S) | **مسار احتياطي لا يعتمد T-224**: توسيع بوابة العدّاد `provider === 'claude'` لتشمل opencode — ومعه **مؤشر تعفّن السياق** (نفس البوابة)؛ المستقبِل جاهز لأي مزوّد (`useChatRealtimeHandlers.ts:565-566`). **استثناء تكتيكي مصرَّح به** عن قاعدة «لا شرط provider=== جديداً» — يُزال عند تنفيذ T-224 م0 | `src/components/chat/ChatComposer.tsx:448` | عدّاد التوكنز ومؤشر التعفّن يظهران لجلسة opencode بعد `token_budget` |
| OC-21 (M) | تسجيل participant/authorship لمسار spawn opencode أسوة ببقية المزوّدات (محور 15) + حسم سلوك إعادة بعث الجلسات المؤرشفة من المزامن | `server/opencode-cli.js` (نظير `claude-sdk.js:1321`) | جلسة opencode مُطلقة من نسّاج تظهر في قائمة المشروع المرقّمة بمالكها؛ ADR-052 يسري عليها |
| OC-22 (S/M) | مرفقات/صور لجلسات opencode: استكشاف قدرة `opencode run` على استهلاكها ثم توصيل الحِمل، وإلا توثيق الحد في §4 | `src/components/chat/hooks/useChatComposerState.ts:795-804` (نظير claude ‏`:850`) | صورة مرفقة تصل للجلسة أو حدٌّ موثَّق معلن |

### M2 — توحيد التعليمات والأصول (مصدر واحد → مخرجان)

| ID | البند | الملفات/المواضع | معيار القبول |
|---|---|---|---|
| OC-09 (M) | توسيع build-agents: ضمّ الأقسام الصالحة محايداً الساقطة من AGENTS.md — الأوامر المحجوبة/safe-restart، مؤشر `nassaj-server-docs.md`، بروتوكول git للجلسات المتوازية (add بالاسم، لا `-A`)، قاعدة الروابط الفعلية، النشر والعلامة — مع وسم كل قسم Claude-only بمبرر | `nassaj-core/scripts/build-agents` + مصادر الأقسام | جدول تغطية أقسام NASSAJ.md الـ 16: كل قسم «مُغطى» أو «Claude-only + مبرر»؛ `--check` idempotent |
| OC-10 (M) | target ثالث: توليد `~/.config/opencode/agent/*.md` من بطاقات الوكلاء الـ 23 (`mode: subagent`، `description` من الوصف+triggers، `model` من خريطة D1، `permission` من دور الوكيل) | `build-agents` + `agents/*.md` + `_models.yaml` | 23 ملفاً idempotent يسردها opencode؛ إعادة التوليد = نفس البايتات |
| OC-11 (S/M) | أوامر `command/*.md` المكافئة لما يصلح فقط؛ توثيق المستثنى (plugins كلود: code-review/simplify/github/frontend-design غير محمولة) | `~/.config/opencode/command/` | قائمة منقول/مستثنى معتمدة؛ أمر واحد على الأقل مُختبَر end-to-end |

### M3 — حاكمية opencode (شرط قبل أي استخدام تنفيذي جدي بالفريق)

| ID | البند | الملفات/المواضع | معيار القبول |
|---|---|---|---|
| OC-12 (L) | plugin «حارس نسّاج» (أصل أسطول في nassaj-core): ‏`tool.execute.before` يطبق **أرضية المنع الـ 24 بنداً** (git push، prisma migrate/db push/reset، DROP/TRUNCATE، dropdb…) برمي استثناء + `permission.ask` للتصعيد | `~/.config/opencode/plugin/nassaj-guard.js` (مصدره nassaj-core) | حالات اختبار للبنود الـ 24 تُرفض كلها؛ سلوك fail-closed عند خطأ الحارس نفسه |
| OC-13 (M) | طبقة ثانية declarative: أنماط `permission.bash` deny في الإعداد القياسي (دفاع بالعمق — تصمد حتى مع `--pure` الذي يعطل الـ plugins) | `opencode.json` القياسي (OC-02) | مع `OPENCODE_PURE=1`: الأنماط الخطرة النمطية ما زالت deny |
| OC-14 (S) | فحص سياسة موثَّق (الامتثال محسوم لدى المالك): تدقيق دوري/يدوي لغياب اعتماد Anthropic OAuth من `auth.json` ضمن مراجعات الأسطول — لا حارس كوداً | إجراء موثَّق (لا كود) | بند فحص مسجَّل في قائمة مراجعات الأسطول |

### M4 — تحسينات عميقة عبر serve/SDK (خلف طلب فعلي — نظير بوابة G-DEMAND في PLAN-v1)

| ID | البند | الملفات/المواضع | معيار القبول |
|---|---|---|---|
| OC-15 (L) | مسار serve: ‏`opencode serve` معزول لكل مستخدم بـ `OPENCODE_SERVER_PASSWORD` + عميل `@opencode-ai/sdk`؛ جسر `permission/{requestID}/reply` و`question/{requestID}/reply` إلى واجهة نسّاج — **المكافئ الفعلي لـ canUseTool/AskUserQuestion** ويفتح أوضاع أذونات حقيقية | وحدة جديدة بجوار `opencode-cli.js` + واجهة الأذونات القائمة | طلب إذن/سؤال opencode يظهر في واجهة نسّاج ويُرَدّ عليه لحظياً |
| OC-16 (M) | توكنز/أحداث لحظية عبر SSE ‏`/api/session/{id}/event` بدل post-session | نفس وحدة OC-15 | `token_budget` يصل أثناء الجريان لا بعد الإغلاق فقط |
| OC-17 (S) | قلب قدرات opencode في واصف T-224 (permissions modes الموسعة، `tokenCounter` لحظي) — **تغيير بيانات الواصف لا منطق المكوّنات** | `providerCapabilities.ts` (من T-224 م0) | لا شرط `provider==='opencode'` جديد في L4 |

**تسلسل التنفيذ الموصى:** M0 فوراً (يفعّل المزوّد ويقطع fallback الضار) → M1 ‏(OC-06 مع أول نافذة build:server) → M2 بعد حسم D1 → M3 قبل فتح opencode للفريق تنفيذياً → M4 مجمّد حتى طلب فعلي.

---

## 4. ما لا يمكن تطابقه — بصراحة هندسية

1. **آلية hooks + managed-settings:** حاكمية كلود تفرضها العملية المضيفة (7 hooks بـ payload يميز `agent_type`، وmanaged-settings بمستوى OS لا يملك المستخدم كسره). opencode-plugin يقارب الوظيفة لكن **بضمانة أدنى درجتين**: يعطَّل بـ `--pure`/`OPENCODE_PURE=1` من سطر الأوامر، ولا مفهوم managed لا يُتجاوز. التخفيف: طبقتا OC-12+OC-13 + حقيقة أن spawn نسّاج لا يمرر `--pure` — لكن من يشغّل opencode بطرفيته مباشرة خارج نسّاج يستطيع التجرد من الحارس. **القاعدة الصفرية (تمييز منسّق/وكيل) غير قابلة للنقل أصلاً** — مفهومها مرتبط بمنظومة وكلاء Claude Code.
2. **جسر الأذونات التفاعلي في وضع run الحالي:** لا يوجد بنيوياً — سلوك `ask` في run غير التفاعلي **غير محدد رسمياً** في 1.17.18، و`--auto` (موافقة عمياء) مرفوض أمنياً. البديل الوحيد الصادق: أذونات ثابتة declarative اليوم، والجسر الكامل عبر serve+SDK ‏(OC-15) مستقبلاً.
3. **مراقبة حصة الاشتراك:** `claude-usage.js` يقرأ حصص جلسة/أسبوع خاصة بمنظومة اشتراك Anthropic OAuth. في opencode بمسار API-key المفهوم **فوترة بلا حصص جلسة** — لا يُبنى مكافئ، بل تنبيه ميزانية لدى المزوّد.
4. **ultracode / effort / Workflows:** حقن `ultrathink ultrawork` وسلّم effort ومنظومة Workflows (والمنوال) مبنية على Claude Agent SDK ودلالات نماذجه. opencode يملك `--variant high|max|minimal` — **مكافئ تقريبي دلالياً لا تطابق** — يوصل عبر واصف T-224 م2 كقدرة مستقلة، ولا تُحمل Workflows عليه.
5. **«تعليمات واحدة حرفياً»:** خطر لا هدف. NASSAJ.md يحوي ميكانيكا Claude-only (compact عند 40%، حصص 5 ساعات، توزيع fable/opus/sonnet، حارس العميل) تكون في opencode إما حشواً مضللاً أو تعليمات مستحيلة التنفيذ. **البديل المعماري المعتمد:** مصدر حقيقة واحد → build-agents يولّد مخرجين (NASSAJ.md الكامل لكلود، AGENTS.md المحايد لغيره) — التطابق في **الجوهر المعياري** (أمان، بوابات، لغة، توثيق، أدوار) لا في نص الملف.

---

## 5. بوابة القرار للمالك

| # | القرار | الخيارات | توصية architect |
|---|---|---|---|
| **D1** | مسار مصادقة opencode المسموح | (أ) مفتاح Anthropic API تجاري مخصص · (ب) `opencode/*-free` وأشباهه · (ج) Bedrock/Vertex · (د) مزيج | **(د) مزيج**: `opencode/*-free` فوراً للتجارب بكلفة صفر، ومفتاح API تجاري منفصل عن الاشتراك عند الحاجة لنماذج Anthropic؛ **منع صريح مسجَّل** لأي إضافة OAuth مجتمعية تستعمل اشتراك Pro/Max + فحص سياسة OC-14 الموثَّق. يُوثَّق ADR (المقترح: ADR-055) |
| **D2** | نطاق اعتماد الخطة | أي مراحل تُعتمد الآن | **M0+M1 فوراً** (تفعيل حقيقي + قطع fallback الضار)؛ M2 بعد D1؛ **M3 بوابة إلزامية قبل فتح opencode للفريق**؛ M4 مجمّد خلف طلب فعلي |
| **D3** | سياسة الأسطول القياسية | — | `share:"disabled"` + `autoupdate:false` + `OPENCODE_SERVER_PASSWORD` (يُفعَّل مع serve في M4) + **إبقاء توافق المهارات مفعّلاً** (عدم استعمال أعلام `OPENCODE_DISABLE_CLAUDE_CODE*`) + مراقبة بند telemetry غير الموثق في ترقيات النسخ |

---

## 6. اعتبارات النشر

- **PATH (OC-01):** يُضاف في `env` داخل `ecosystem.<node>.config.cjs` — **لكل عقدة ملفها** (درس حادثة traventure/B-110: القالب المحايد ليس للتشغيل). بيئة PM2 تَعلَق عند تعديل الملف: يلزم restart **بإعادة قراءة ecosystem** ثم `pm2 save`.
- **إعادة التشغيل حصراً عبر** `bash scripts/safe-restart.sh --exec` — ممنوع `pm2 restart nassaj-dev` الخام (تصميم drain يحبس المنفذ 3004 مع جلسة حية → حادثتا 502).
- **M0 لا يتطلب build**؛ OC-06 وما بعده في M1: ‏`build:server` + safe-restart (وتذكّر قلم devDependencies تحت `NODE_ENV=production` — ‏`--include=dev` قبل build).
- **دورة إعداد opencode:** كل رسالة = عملية `opencode run` جديدة تقرأ الإعداد عند إقلاعها → تعديل `opencode.json` يسري من الرسالة التالية **بلا restart لنسّاج**؛ لكن مفتاحاً علوياً مجهولاً = `ConfigInvalidError` يكسر **كل** الرسائل فوراً → فحص `opencode run 'ping'` إلزامي بعد أي تعديل إعداد وقبل تعميمه.
- **الأسطول لاحقاً:** ضمّ تثبيت opencode + الإعداد القياسي + AGENTS.md العام إلى `bootstrap-node.sh` (مرجع `reference_fleet_install`) — بند يُسجَّل عند اعتماد D2.

---

## 7. ملاحق

### 7.1 انحرافات مكتشفة عن معطيات الاستكشاف (تحقق 2026-07-10)

1. **عدّاد opencode محجوب واجهةً رغم بثه خادمياً:** إصلاح B-92 النقطي (`ChatComposer.tsx:448`: ‏`provider === 'claude' && <TokenUsageSummary/>`) حجب المزوّدات الباثة الأخرى (opencode/codex/gemini) وتعليقه المرافق («other providers never export») **غير دقيق** لـ opencode. B-92 حالتها باللوحة `fixed`؛ الإصلاح البنيوي المتسق مع PLAN-v1 ما زال في T-224 ‏(todo).
2. **AGENTS.md المولَّد قديم:** 22 وكيلاً من 23 — `negotiator` ساقط من الفهرس (البطاقة موجودة في `agents/`).
3. **مسار watcher الفعلي:** `server/modules/providers/services/sessions-watcher.service.ts` (لا `server/modules/sessions/`).
4. **موقع رابع يعتمد HOME الثابت:** `opencode-auth.provider.ts:62` يقرأ `auth.json` من `os.homedir()` — يُضاف لمواقع مواءمة العزل في OC-07 (المعطيات ذكرت ثلاثة مواقع spawn فقط).
5. **ThinkingModeSelector:** بوابة `provider === 'claude'` عند `ChatComposer.tsx:431` والمكوّن في `:433` (انزياح سطر واحد عن المعطيات — بلا أثر).

### 7.2 مسودة الإعداد القياسي (OC-02 — للنقاش، ليست نهائية)

```jsonc
// ~/.config/opencode/opencode.json — أسطول نسّاج (D3)
{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "autoupdate": false,
  "permission": {
    // طبقة declarative تصمد مع --pure (OC-13). آخر قاعدة مطابقة تفوز.
    "bash": {
      "git push*": "deny",
      "*prisma migrate*": "deny", "*prisma db push*": "deny", "*prisma migrate reset*": "deny",
      "*dropdb*": "deny",
      "pm2 restart*": "deny", "pm2 reload*": "deny", "pm2 delete*": "deny",
      "*": "allow"
    },
    "edit": "allow",
    "webfetch": "allow"
  }
  // بقية أرضية المنع الـ 24 (DROP/TRUNCATE داخل عبارات SQL…) لا تُصاغ أنماط bash موثوقة —
  // تغطيتها في plugin الحارس (OC-12). هذا حد معلن لا يُدّعى خلافه.
}
```

### 7.3 خريطة التقاطعات مع اللوحة

| المرجع | العلاقة |
|---|---|
| **T-224 / ADR-047** (`docs/planning/provider-capabilities/PLAN-v1.md`) | كل عمل UI مزوّد-واعٍ (variant/effort، توسيع الأذونات) يُنفَّذ عبر الواصف هناك — **الاستثناء الوحيد المصرَّح به: OC-20** (توسيع تكتيكي لبوابة العدّاد لا ينتظر T-224، يُزال عند تنفيذ م0)؛ أي بند آخر يُترك معلَّقاً على T-224 يُصرَّح به خطراً مجدولاً |
| **B-92** (`fixed`) | الإصلاح النقطي أنتج الانحراف 7.1/1؛ لا يُفتح من جديد — OC-20 مساره الاحتياطي، والحل البنيوي في T-224 م0/م1 |
| **B-95 / safe-restart** | بوابة النشر الوحيدة (§6)؛ OC-08 يحسّن رؤيتها لجلسات opencode |
| **ADR-018 / build-agents** | OC-04/09/10/11 امتداد مباشر له — مصدر واحد → مخرجات متعددة |
| **ADR-052 (رؤية الجلسات)** | لا يسري فعلياً على جلسات opencode قبل OC-21 (غياب participant/authorship — المحور 15) |
| **B-91 (hermes)** | النظير التحذيري لمحور 17 (أخطاء runtime الدلالية)؛ فحص ميداني ضمن قبول OC-01 |
| **ADR-055 (مقترح)** | قرار D1 الامتثالي عند اعتماده |
