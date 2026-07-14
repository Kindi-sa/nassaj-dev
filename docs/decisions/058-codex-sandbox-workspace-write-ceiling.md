# ADR-058 — سقف صلاحيات Codex: workspace-write بدل danger-full-access

- **الحالة:** معتمد (قرار لجنة 2026-07-14: architect + qa-critic [سلطة فيتو] + devops + backend-dev، بإذن المالك «اعتماد ما تتّفق عليه الوكلاء ثم التنفيذ»).
- **المهمة:** T-884 — يستبدل الوضع الافتراضي `danger-full-access` لجلسات Codex.
- **يرتبط بـ:** ADR-057 (حقن الحوكمة، النسخة 0444 المتعامدة)، T-893 (عزل القراءة — حاجز لاحق)، T-894 (إظهار posture في الواجهة)، T-886 (تفويض Codex-كمنسّق، مؤجّل).

## السياق (Context)

Codex يعمل بمستخدم نظام واحد مشترك (`uid nassaj`) لكل مستخدمي نسّاج؛ العزل عبر `CODEX_HOME` per-user يفصل المسار لا الـuid. نقطتا إطلاق حيّتان تمرّان بالمُحلّل الواحد `mapPermissionModeToCodexOptions` في `server/openai-codex.js`:
- REST: `server/routes/agent.js` كان يثبّت `permissionMode:'bypassPermissions'`.
- WS التفاعلي: `chat-websocket.service.ts` يمرّر خيارات العميل مباشرةً — فأي مستخدم يختار `bypassPermissions` من الواجهة.

كلاهما كان يُنتج `sandboxMode:'danger-full-access'` = وصول كامل للقرص والشبكة. على uid مشترك، أي turn يستطيع قراءة/كتابة أشجار المستخدمين الآخرين (`auth.json` = توكنات اشتراك، transcripts) والكتابة في مصدر حوكمة الأسطول `~/.claude/AGENTS.md`. مراجعة سابقة (07-13) خلُصت: «CODEX_HOME منفصل + uid مشترك + danger-full-access ليس حدّاً أمنياً بين المستخدمين».

## القرار (Decision)

سقف صلاحيات مُنفَّذ **داخل المُحلّل المشترك** (يغلق المسارين معاً، لا يُتجاوز من الواجهة):

1. **`bypassPermissions` مقصوص إلى `workspace-write`** (نفس سقف `acceptEdits`، مصدر واحد). `default` يبقى `workspace-write/untrusted`.
2. **`danger-full-access` خلف مخرج مالك صريح فقط:** علم بيئة الخادم `CODEX_ALLOW_FULL_ACCESS==='true'` (صارم؛ أي قيمة أخرى تُقصَّ). ليس افتراضياً ولا قابلاً لاختيار العميل.
3. **الشبكة OFF افتراضياً** تحت workspace-write (قناة تسريب على uid مشترك). تفعيل صريح فقط: per-session (`options.networkAccess===true`) أو علم مشغّل (`CODEX_WORKSPACE_NETWORK==='true'`). عند عدم الطلب يُحذف الحقل فلا يبعث SDK أي `network_access` (فيبقى افتراض Codex = OFF).
4. **`/api/agent`** يثبّت `acceptEdits` بدل `bypassPermissions` (يبقى headless بلا مطالبات، لكن محصوراً بـworkspace-write حتى لو فُعّل المخرج لمسار آخر).

## الأدلة (Evidence)

- وحدة + انحدار: `server/openai-codex.permission-ceiling.test.ts` **17/17** (لا مسار حيّ يبلغ danger بلا العلم؛ `/api/agent` يثبّت acceptEdits — مطلبا فيتو qa-critic). مجاميع عزل/حوكمة Codex **36/36**. typecheck الخادم نظيف. (شُغّلت بيد المنسّق، لا بادعاء وكيل.)
- سموك معزول حيّ (Codex 0.144.1، مسار SDK الفعلي، حقائق قرصية): تحت `workspace-write` تُكتب `$CODEX_HOME/sessions/**/*.jsonl` فعلاً (المصادقة تعمل، **المزوّد لا ينكسر، لا حاجة `--add-dir`/writable_roots لـCODEX_HOME**)؛ الشبكة تفشل (DNS محجوب) بلا العلم وتنجح (HTTP 200) معه.

## العواقب (Consequences)

- **مُغلَق:** كتابة عدائية عبر turn نحو أشجار المستخدمين الآخرين (`~/.nassaj-users/<آخر>`) ومصدر الحوكمة `~/.claude/AGENTS.md` (كلاهما خارج نطاق الكتابة) + قناة التسريب الشبكية بلا opt-in.
- **غير مُغلَق (مقصود، خارج النطاق):** **قراءة** اعتمادات/transcripts المستخدمين الآخرين — workspace-write يقيّد الكتابة لا القراءة، والـuid مشترك. حاجز فيتو (T-893: عزل uid/حاوية) **مانعٌ** قبل: (أ) أي كشف لتفويض Codex-كمنسّق (T-886) لمستخدم ثانٍ، (ب) أي تفعيل شبكة دائم على uid مشترك.
- **تحفّظ تقني (سموك):** نطاق كتابة workspace-write الفعلي = `cwd ∪ $TMPDIR(/tmp)` لا cwd وحدها — Codex يضمّ مجلد المؤقّت. أثره ضعيف حالياً (uid مشترك أصلاً بلا عزل نظام)، لكنه scratch مشترك يستحق الانتباه لو انتقل نسّاج لعزل حقيقي. تعليق الكود «writes confined to the workspace» تبسيط؛ المرجع الدقيق هنا.
- **الطرح:** nassaj قنصةً أولاً (عقدة dev)؛ الأسطول (الرخيمي/ترافنشر-إنتاج) بدفع المالك، والعلمان per-node لا يُفترضان. تراجع: `git revert` + إعادة بناء/تشغيل، أو `CODEX_ALLOW_FULL_ACCESS=true` للعودة السريعة عبر مسار bypass.

## الخط الأحمر (فيتو qa-critic)

لا turn من Codex يعمل `danger-full-access` (ولا بشبكة دائمة) على uid `nassaj` المشترك على أي عقدة يبلغها مستخدم ثانٍ، حتى يُركَّب عزل قراءة على مستوى النظام (T-893).
