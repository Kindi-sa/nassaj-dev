# CODEX-COORDINATOR-IMPL — جعل Codex منسّقاً محكوماً بآلية نسّاج موحّدة (T-886)

- **التاريخ:** 2026-07-15 · **النوع:** تصميم تنفيذي (لا spike، قرار المالك بالبناء حاسم) · **المُصمِّم:** architect
- **النطاق (MVP):** مالك موثوق واحد على nassaj-dev فقط. عزل-القراءة متعدد المستخدمين (T-893/ADR-059)
  **خارج النطاق صراحةً** — لا تُتاح حوكمة المنسّق لغير المالك قبل هبوطه.
- **يبني على:** بوابة 1B (native صالح: `model` صريح + اسم بلا `@`)، ADR-058 (سقف workspace-write)،
  زبدة جلسة Codex 019f6569: «المنسّق ليس نموذجاً نطلب منه ألا ينفّذ؛ هو هوية تشغيل لا تُمنح قدرات التنفيذ».

## 0. المبدأ الموحَّد (ينطبق على أي محرك)

نسّاج (لا النموذج) يحسم **الدور** خارج النموذج عند نقطة الإطلاق الواحدة، ثم يطبّق **أرضية قدرات**
بنيوية لكل محرك. المنسّق = هوية إطلاق **محرومة من أدوات الكتابة/التنفيذ**؛ التفويض هو مخرجه الوحيد.
الحوكمة النصّية (عقد «فوّض ولا تنفّذ») **تكميل** لا أساس — العبرة بالبنية لا بطاعة النموذج (فيتو qa-critic).

## 1. جدول القرارات الأربعة (محسومة بدليل)

| # | القرار | الدليل من الكود |
|---|---|---|
| **D1 — الطبقة البنيوية** | أرضية المنسّق = **حرمان التنفيذ** عند مُحلّل الإطلاق الواحد: **Codex** فرع `coordinator` جديد في `mapPermissionModeToCodexOptions` يرجع `sandboxMode:'read-only', approvalPolicy:'never'` (منع OS للكتابة/الشبكة/`apply_patch`، غير قابل للّعب بحقن prompt)؛ **Claude** `disallowedTools` (Edit/Write/Bash-exec) + hook القائم؛ **محرك جديد** adapter يخرّط نفس deny-set أو يمرّر كل الأدوات عبر MCP gateway لنسّاج. | مُحلّل واحد chokepoint `openai-codex.js:271-301` (سقف T-884)؛ `claude-sdk.js:561-622` يضبط disallowedTools/permissionMode ويعرف أصلاً `origin.kind 'coordinator'` (سطر 1831). |
| **D2 — توتر sandbox الأب/الطفل** | **استثمار وراثة E12 لا مقاومتها.** MVP بوكيلين قرائيين (architect/qa-critic): أب read-only → أطفال native يرثون read-only (E12) → **ضمان بنيوي ألا يكتب أي طفل**، والتوتر **غائب** لأنهما لا يحتاجان الكتابة (لهذا اختارهما الـspike). وكلاء الكتابة (backend-dev…) native **غير كافٍ بنيوياً** (E12 يحبس الطفل عند read-only الأب) → يُطلقون بنمط **dispatcher**: المنسّق يستدعي أداة نسّاج → طبقة الإطلاق تبدأ **جلسة Codex جذر جديدة** (workspace-write + حوكمتها + شخصيتها)، شقيقة لا طفلاً وارثاً. | E12 (codex-manual: يعيد تطبيق sandbox الأب فوق TOML الطفل)؛ sandbox لكل thread في `openai-codex.js:487`؛ startThread جديد = sandbox مستقل. |
| **D3 — الطبقة النصّية (عقد المنسّق)** | عقد المنسّق يُحقَن في **الجذر فقط** وقت الإطلاق (طبقة nassaj-dev)، **لا في AGENTS.md** (مشترك، مبصوم T-883، يقرؤه الأطفال → تلوّث). عملياً: prepend للـ`command` عند role=coordinator (`openai-codex.js:521-525`). الأطفال يأخذون **عقد leaf** من TOMLهم؛ وعزلهم مصلَّب بأن leaf-contract في TOML **يتقدّم على أي تعليمة منسّق موروثة** عبر fork، ويُتحقَّق بضابط عدم-التلوّث. **nassaj-core لا يلزم لـMVP** — الحقن من nassaj-dev؛ الترقية لاحقاً. | `neutral-standards.md` بلا عقد المنسّق (مؤكَّد)؛ المولّد يحقن leaf أصلاً `gen-codex-agent-toml.cjs:51-59`؛ AGENTS.md مبصوم `codex-governance-material.js`؛ `<multi_agent_mode>` يكبح التفويض ما لم «تطلبه التعليمات صراحةً» → العقد هو الطالب، جذرياً فقط. |
| **D4 — التسجيل + تمرير النموذج + Gates 2/3/5** | ترقية المولّد لوحدة منتج `codex-coordinator-agents.js`، وتوليد `$CODEX_HOME/agents/{architect,qa-critic}.toml` **وقت الإطلاق** داخل queryCodex (كـ`materializeGovernanceCopy`) لأن النموذج المحلول يُعرف عند `openai-codex.js:414` لا وقت التزويد. النموذج: يُمرَّر `resolvedModel` مباشرة للمولّد (`model=`, اسم بلا `@`). **Gate2**: تثبيت `agents.max_depth=1` في config لكل spawn (`:473`). **Gate3**: عقد leaf + بوابات الرفض + بطاقة الحوكمة في `developer_instructions`. **Gate5**: read-only الأب هو الضابط والأطفال يرثونه. | `resolveResumeModel('codex',…)` عند `:414`؛ نمط materialize قائم في `codex-governance-material.js`؛ `~/.codex/agents/` غير موجود بعد → يُنشأ؛ البطاقات في `~/.claude/agents/*.md` (مشتركة، `provision-user-dirs.js:291`). |

## 2. حلّ توتر sandbox الأب/الطفل (خلاصة D2)

- **MVP** = وكلاء **قرائيون** فقط: read-only للأب يورّث read-only للأطفال (E12) — **هذا مطلوب لا عيب**.
- **الكتابة (Phase 2)** = **dispatcher**، لا native: الأب read-only يستحيل معه رفع طفل native إلى الكتابة، فوكيل
  الكتابة جلسةٌ جذر مستقلة يُطلقها نسّاج (نفس queryCodex بدور specialist + workspace-write). هذا **الحدّ الذي يفرضه E12**.
- **الخطر الحاسم للتحقّق:** هل ينجح `spawn_agent` تحت أب read-only؟ (بوابة 1B كانت danger-full-access). spawn أداة
  تحكّم لا كتابة قرص، فالمتوقّع نعم — لكن **يُثبَت بتشغيل واحد قبل تثبيت الرافعة**؛ إن فشل: المنسّق يبقى
  workspace-write وتنحدر الأرضية البنيوية إلى **بوابة الأدوات (MCP gateway)** المؤجَّلة (تبقى الطبقة النصّية).

## 3. نقاط اللمس (ملف:سطر)

**server (nassaj-dev) — كل التنفيذ هنا:**
1. `server/openai-codex.js:271-301` — فرع `case 'coordinator'` في `mapPermissionModeToCodexOptions` → read-only/never.
   الافتراضي يبقى workspace-write (المنسّق **opt-in** لا default — غير كاسر لجلسات الكتابة المباشرة).
2. `server/openai-codex.js:404-421` — قراءة الدور من `options.permissionMode==='coordinator'`؛ تطبيق sandbox المنسّق.
3. `server/openai-codex.js:521-525` — prepend عقد المنسّق للـ`command` عند role=coordinator فقط (حقن جذري، خارج البصمة).
4. `server/openai-codex.js:473` — إضافة `'agents.max_depth': 1` لـ`config` لكل spawn (Gate2، دفاع في العمق).
5. `server/openai-codex.js:~415` — بعد `resolvedModel` وقبل startThread: `materializeCoordinatorAgents(governance.codexHome, resolvedModel)` fail-closed.
6. **جديد** `server/services/isolation/codex-coordinator-agents.js` — منفذ منتج للمولّد: بطاقة→TOML بـ`model` المحلول
   + leaf + `sandbox_mode="read-only"` + بصمة `agentDefinitionHash`؛ يصدّر `materializeCoordinatorAgents(codexHome, model)`.
7. `server/services/isolation/provision-user-dirs.js:342-362` — `ensureDir(codexDir/agents)` بجوار الحوكمة (المجلد فقط؛ TOMLs وقت الإطلاق).
8. (تكافؤ Claude، اختياري في MVP) `server/claude-sdk.js:561-622` — تخريط دور coordinator لأرضية disallowedTools نفسها.

**nassaj-core (Phase 2 — أسطولي، push بيد المالك، ليس MVP):**
9. `core/governance.yaml` (جديد) — تعريف الدورين + مصفوفة القدرات + نصّ عقد المنسّق (مصدر واحد) + `policyVersion`.
10. `scripts/build-agents` — توسعته compiler: مخرجات لكل محرك (Codex TOMLs، عقد المنسّق) ببصمة/إصدار.
    **MVP يتجنّبها بالحقن من nassaj-dev؛ الترقية متابعة موثّقة.**

## 4. خطوات backend-dev (مرقّمة)

1. أضف `case 'coordinator'` (D1) واختبار انحدار: default يبقى workspace-write، coordinator=read-only، لا مسار يبلغ danger افتراضياً.
2. أنشئ `codex-coordinator-agents.js` (منفذ `gen-codex-agent-toml.cjs`) + وحدة اختبار ابتلاع بالثنائي الفعلي (كـ`codex-agents-ingestion.test.ts`).
3. اربطه في queryCodex بعد `resolvedModel` (خطوة 5) + `agents.max_depth=1` (خطوة 4) + prepend العقد (خطوة 3)، كلها خلف role=coordinator.
4. `ensureDir(agents)` في التزويد (خطوة 7).
5. **تشغيل تحقّق واحد** (خطر spawn تحت read-only) قبل الإغلاق؛ ثم build:server (بلا restart — safe-restart بيد المالك).

## 5. معايير القبول (قابلة للفحص حيّاً — مالك، nassaj-dev)

- turn منسّق يحاول write/apply_patch/exec-بأثر → **يُرفض بنيوياً بالـsandbox** (read-only) ويفوّض بدلاً منه (rollout: لا كتابة ناجحة + `spawn_agent` حاضر).
- **[حرج]** `spawn_agent` ينجح تحت أب read-only (إن فشل → dispatcher مبكّراً).
- الطفل architect يردّ بهوية نسّاج (canary + الدور + بوابة رفض) = TOML مُحمَّل بالنموذج المحلول (تكرار 1B في مسار المنتج).
- الطفل يحاول توليد حفيد → يُرفض (max_depth=1).
- الطفل (read-only) لا يكتب خارج workspace (وراثة E12).
- بصمة `AGENTS.md` **لم تتغيّر** (T-883 سليم) — العقد ليس فيها؛ وضابط عدم-تلوّث: الطفل لا يمتنع خطأً عن التنفيذ داخل نطاقه.
- جلسة Codex **غير-منسّقة** سليمة (workspace-write) — لا كسر.
- سجل تدقيق: الدور + قرارات الأدوات (المنسّق: صفر تنفيذ-كتابة ناجح من الجذر).

## 6. المخاطر (فيتو qa-critic / قرار مالك)

- **R1 (قرار مالك):** قلب default الـCodex إلى منسّق يكسر تدفّق الكتابة المباشرة. MVP يبقيه **opt-in**؛ قلب الافتراضي قرار منفصل.
- **R2 (تحقّق إلزامي):** نجاة `spawn_agent` تحت read-only غير مُثبَتة — تُختبر بتشغيل واحد قبل تثبيت الرافعة.
- **R3 (صدق الادعاء — نقطة qa-critic نفسها):** read-only = «لا كتابة/شبكة» **لا** «لا تنفيذ»؛ read-exec (تحليل كود) يبقى.
  الشارة **Write-Enforced** لا **Full-Coordinator** حتى بوابة الأدوات (Phase 2). المبالغة = عين فيتو الجلسة.
- **R4 (نطاق):** وكلاء الكتابة (backend-dev) **لا يُشحنون native** (E12 يجعلهم read-only فيُكسرون صامتاً) — MVP قرائيون فقط.
- **R5 (متعدد المستخدمين):** عزل-القراءة (T-893) خارج النطاق؛ لا تفويض منسّق لغير المالك قبل هبوطه (uid مشترك = قراءة اعتمادات الآخرين).

## 7. متابعات T-903 (مراجعة qa-critic على T-886 — مقبولة بلا فيتو)

- **§1 تنظيف TOMLs — منفَّذ:** `pruneStaleCoordinatorAgents(agentsDir, roster)` في `codex-coordinator-agents.js` يكنس أيتام الوكلاء (بطاقة حُذفت من `~/.claude/agents` تترك TOML قابلاً للتفريخ) على مسار الـok من `materializeCoordinatorAgents` — أي عند بدء الجلسة التالية. حميد وذاتي التصحيح: يحذف فقط ملفاتنا (تحمل `agentDefinitionHash`)، لا يمسّ ملفاً أجنبياً، ولا ينزع وكيلاً من روستر جلسة حيّة. اختبارات في `codex-coordinator-agents.test.ts` (كنس/حماية-الأجنبي/لا-رمي).
- **§2 حجب الحفيد — مُتحقَّق ومُصلَّب:** `agents.max_depth=1` مُطبَّق في بناء `new Codex({ config })` الوحيد — `server/openai-codex.js` داخل `queryCodexUnlocked` — وهو نقطة الاختناق الوحيدة التي يمرّ عبرها كلا مساري الإطلاق: REST ‏(`server/routes/agent.js` → `queryCodex`) و‏WS ‏(`server/modules/websocket/services/chat-websocket.service.ts:377` → `queryCodex`). ضابط مصدري في `openai-codex.coordinator.test.ts` يفشل إن أُضيف مسار spawn ثانٍ بلا السقف (وحدانية `new Codex(` + كلا المتصلين عبر queryCodex).
- **§3 owner-only غير مفروض — موثَّق:** الطبقة تخفيض قدرة (⊂ الافتراضي) مطبَّق موحّداً على كل مستخدم لا حصراً للمالك، والجذر يتبع وضع الجلسة الفعلي (لا أرضية OS للقراءة-فقط). الضمان textual (عقد الجذر) كزيرو-رول كلود. فجوة **مقبولة حتى عزل القراءة T-893** (على uid مشترك لا معنى لامتياز owner-only per-user أصلاً). تعليق صريح عند نقطة الطبقة في `openai-codex.js`.
- **§4 تكافؤ Claude — مؤجَّل متابعةً مستقلّة (غير منفَّذ عمداً):** سباكة `origin.kind=coordinator` + `disallowedTools` للتكافؤ مع حجب أدوات Codex **ليست تغييراً صغيراً آمناً**: (أ) حقن `origin.kind=coordinator` يمسّ مسار origin رسائل الـSDK الحرج (claude-sdk.js حول السطر 1830) — ممنوع بلا مراجعة؛ (ب) كلود يحمل زيرو-رول نصياً عبر CLAUDE.md/NASSAJ.md أصلاً، فالتكافؤ النصي **قائم بالفعل** ولا يلزمه سباكة؛ (ج) حجب أدوات كلود مكافئاً لـweb-search/network في Codex قرار أمني غير محسوم — نموذج تهديد كلود (عزل per-user عبر CLAUDE_CONFIG_DIR) يختلف عن uid Codex المشترك، فنسخ حجب Codex حرفياً غير مبرَّر. **الحجم الحقيقي:** مهمة تصليب أمني في claude-sdk تتطلّب فيتو qa-critic وقرار أدوات، لا سباكة روتينية — تُفتح متابعة مستقلّة عند/بعد T-893.
