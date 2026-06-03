# خطة مشروع — nassaj-dev

> **المرجع الثابت للمشروع.** يصف **ما نبنيه ولماذا**. يُحدَّث **عند الضرورة فقط** (تغيُّر النطاق، المعمارية، المراحل، المخاطر).
>
> - **للحالة الراهنة والخطوة التالية:** انظر `PROJECT_STATUS.md` (يُحدَّث باستمرار).
> - **لتفاصيل وحدات العمل:** انظر `docs/workitems/`.

**تاريخ الإنشاء:** 2026-05-24
**النوع:** Fork تجريبي من `siteboon/claudecodeui` (AGPL-3.0)
**الهدف العام:** إضافة ميزتين (AntigravityProvider + RTL عربي) واختبارهما قبل النقل إلى `nassaj.alkindy.tech`.

---

## 🎯 الرؤية والأهداف

### المشكلة
`nassaj.alkindy.tech` (النسخة الإنتاجية الحالية) تعمل على Claude Code فقط. نحتاج إضافة:
1. **AntigravityProvider** — موفِّر AI أصيل (native) يعمل عبر `agy` CLI (Google AI Pro) مع دعم sub-agents.
2. **RTL عربي كامل** — لجعل الواجهة قابلة للاستخدام بالعربية لفريق نسَّاج والمستخدمين العرب.

التطوير المباشر على الإنتاج محفوف بمخاطر regression؛ لذا أُنشئ هذا الـ fork التجريبي المعزول.

### الجمهور المستهدف
- **مباشر:** فريق نسَّاج الداخلي (اختبار وتطوير).
- **غير مباشر:** مستخدمو `nassaj.alkindy.tech` بعد اجتياز شرط الانتقال.

### النموذج التجاري
**Internal Tool** — fork خاص لأغراض داخلية. الترخيص الأصلي **AGPL-3.0** يستلزم الإفصاح عن أي شفرة معدَّلة عند التقديم كخدمة عبر الشبكة لطرف خارجي.

### معايير النجاح (KPIs)
- `agy` يعمل End-to-End بدون أخطاء (chat + history + abort).
- RTL يعمل في `sidebar` و `chat` و `settings` بدون كسر بصري.
- لا regression على Claude provider (المسار القائم يستمر دون تأثر).
- ≥ 10 جلسات حقيقية على `nassaj-dev` بدون مشاكل حرجة.

### معايير الإلغاء (Kill Criteria)
- `agy -p` لا يدعم streaming حقيقي بعد 4 ساعات محاولة → تعليق المشروع حتى حل PTY.
- RTL يكسر > 20% من مكوّنات Claude provider → rollback كامل لمرحلة RTL.

---

## 📦 النطاق

### ضمن النطاق (In Scope)
- **AntigravityProvider** كامل (backend `agy` CLI + frontend).
- **RTL عربي كامل** عبر 7 namespaces في الواجهة.
- **Auth بسيطة لـ agy:** فحص وجود الـ binary + token + ping.
- **Sub-agents badge** في الواجهة (تمييز بصري لـ tool calls الصادرة من sub-agents).

### خارج النطاق (Out of Scope)
- تعديل `GeminiProvider` القائم (لتفادي regression).
- النشر للعامة قبل اجتياز شرط الانتقال.
- Login flow مدمج لـ `agy` داخل الواجهة في المرحلة الأولى (يُفترض أن `agy` مهيَّأ على مستوى النظام).
- `node-pty` في المرحلة الأولى (راجع m-60 المؤجَّل).

### مؤجَّل (Deferred)
- **PTY support (m-60):** يُرفع لـ Blocking فور فشل streaming في B-10.
- **MCP hosting عبر agy:** المرحلة الثانية بعد استقرار الأساس.

---

## 🗺️ المراحل (Roadmap)

> **مبدأ:** كل مرحلة مرتبطة بكود Work Items مفصَّل في `docs/workitems/PHASE-N.md`. تُبنى المرحلتان 1 و 3 على أساس المرحلة 0، وتُبنى المرحلة 4 على نواتج 1+2+3 معاً.

### المرحلة 0 — Foundation (إعداد بيئة التطوير المستقلة)
- **الهدف:** repo مستقل + PM2 على port 3004 + domain `nassaj-dev.alkindy.tech` + DB معزولة.
- **المسؤول:** devops + backend-dev
- **الحالة:** 🟡 جارية
- **التواريخ:** 2026-05-24 → 2026-05-24
- **يستكمل عمل:** بداية جديدة (fork من `siteboon/claudecodeui`).
- **Work Items:** B-01 (✅ مكتمل), B-02, B-03, B-04, B-05 → `docs/workitems/PHASE-0.md`
- **المخرجات:** repo `Kindi-sa/nassaj-dev` خاص، PM2 process باسم `nassaj-dev` على port 3004، subdomain يعمل، `NASSAJ_DB_PATH` env var مفعَّلة.

### المرحلة 1 — AntigravityProvider Backend
- **الهدف:** تنفيذ backend كامل لتشغيل `agy` CLI واستقبال streaming وحفظ history.
- **المسؤول:** backend-dev (بدعم architect عند قرارات معمارية)
- **الحالة:** ⏳ معلّقة
- **يستكمل عمل:** المرحلة 0 (تعتمد على repo + DB المستقلة).
- **Work Items:** B-10, B-11, B-12, B-13, B-14, B-15, B-16, B-17, C-18, C-19, C-20 → `docs/workitems/PHASE-1.md`
- **المخرجات:** `AntigravityProvider` class، WS message type `antigravity-command`، قراءة history من `transcript.jsonl`، abort logic، auth check.
- **تحذير حرج (R-2):** B-10 يجب أن يُختبر أولاً للتحقق من دعم `agy -p` للـ streaming الحقيقي. إن فشل، يُجمَّد التقدم ويُرفع m-60 (PTY) إلى Blocking.

### المرحلة 2 — Frontend Integration
- **الهدف:** واجهة كاملة للتفاعل مع AntigravityProvider (model picker + sub-agents badge + history view).
- **المسؤول:** frontend-dev
- **الحالة:** ⏳ معلّقة
- **يستكمل عمل:** المرحلة 1 (تعتمد على backend جاهز و WS contract محدد).
- **Work Items:** C-30, C-31, C-32, C-33, C-34 → `docs/workitems/PHASE-2.md`
- **المخرجات:** Provider selector في UI، tool_use rendering مع badge "Sub-agent"، history rendering من transcript، settings panel لـ agy.

### المرحلة 3 — RTL & Arabic (مستقل)
- **الهدف:** دعم عربي/RTL كامل عبر 7 namespaces بدون كسر LTR.
- **المسؤول:** frontend-dev (بدعم design-system للمراجعة البصرية)
- **الحالة:** ⏳ معلّقة
- **يستكمل عمل:** المرحلة 0 (مستقل عن 1 و 2؛ يمكن أن يتوازى معهما).
- **Work Items:** B-40, B-41, B-42, B-43, B-44, C-45, C-46, C-47 → `docs/workitems/PHASE-3.md`
- **المخرجات:** `dir="rtl"` ديناميكي، `tailwindcss-rtl` plugin مفعَّل، خطوط `Tajawal`، ملفات i18n عربية لـ sidebar/chat/settings/auth/errors/tools/common.

### المرحلة PK — Passkey (WebAuthn/FIDO2)
- **الهدف:** إضافة دعم Passkey كطريقة مصادقة ثانية بجانب كلمة المرور (لا تحلّ محلّها في MVP).
- **المسؤول:** backend-dev + frontend-dev
- **الحالة:** ⏳ معلّقة — **تعتمد على اكتمال Phase MU (Auth الأساسي)**
- **يستكمل عمل:** Phase MU (تعتمد على وجود جدول `users` + JWT + `user_credentials`).
- **Work Items:** m-PK-1, m-PK-2, M-PK-1..3, C-PK-1..3, B-PK-1..3 → `docs/workitems/PHASE-PK.md`
- **المخرجات:** جدولا `passkey_credentials` و `passkey_challenges`، 6 API endpoints، `PasskeyRegisterSection`، `PasskeyLoginButton`، `usePasskey` hook.
- **القيود الأمنية الحرجة:**
  - `userVerification: required` إلزامي (nassaj-dev يُتيح تنفيذ أوامر على السيرفر).
  - التحقق من `rpID` و `origin` server-side في كل assertion.
  - Challenge لمرة واحدة مع TTL ≤ 5 دقائق.
  - `signCount` يُتحقق منه ويُحدَّث atomically مع JWT.

### المرحلة 4 — Hardening
- **الهدف:** اختبارات شاملة، regression suite، توثيق نهائي، تجهيز شرط الانتقال.
- **المسؤول:** qa-tester + backend-dev + frontend-dev
- **الحالة:** ⏳ معلّقة
- **يستكمل عمل:** المراحل 1 و 2 و 3 (تعتمد على اكتمالها جميعاً).
- **Work Items:** M-50, M-51, M-52, M-53, M-54, M-55, M-56 → `docs/workitems/PHASE-4.md`
- **المخرجات:** test suite كامل (≥ 70% للمنطق الأساسي)، تقرير regression لـ Claude provider، توثيق ADRs النهائية، checklist شرط الانتقال موقَّع.

### المرحلة MU — Multi-User (Phase-MU)
- **الهدف:** جعل `nassaj-dev` متعدّد المستخدمين لفريق نسَّاج: **عزل اعتماد per-user**
  (Claude إلزامي، Gemini) مع **مشاركة حيّة كاملة** للمحادثات والملفات والتعليمات، وطبقة
  **Auth مدمجة داخل التطبيق** (لا proxy منفصل).
- **المسؤول:** backend-dev + frontend-dev (بدعم architect للقرارات، scribe للتوثيق)
- **الحالة:** ⏳ معلّقة
- **يستكمل عمل:** المراحل 0→4 (single-user مكتملة)؛ تبني عليها لتُحوّل النسخة إلى multi-user.
- **Work Items:** C-AUTH-1..4, B-ISO-RESOLVER, B-ISO-CLAUDE, B-ISO-GEMINI, B-ISO-CODEX, B-ISO-PROVISION, B-ISO-AGYLOCK, C-UI-1..3, m-*, M-ISO-E2E → `docs/workitems/PHASE-MU.md`
- **القرارات المعتمدة (ملخص):**
  1. **Auth مدمج داخل التطبيق** — لا auth-proxy، لا cli-wrappers، لا تبديل cloudflared. كل
     شيء في DB الموجودة `db.sqlite` (ADR-015).
  2. **JWT stateless** (لا جدول sessions)، أدوار `owner`/`admin`/`user`، تسجيل
     **بالدعوة فقط** (invite-only)، تجزئة **argon2id**، **bootstrap owner** عند أول تشغيل.
  3. **عزل اعتماد Claude إلزامي (أولوية قصوى):** `CLAUDE_CONFIG_DIR` لكل مستخدم في
     `~/.nassaj-users/<userId>/.claude`، مع symlink لـ `projects/` (محادثات) و
     `CLAUDE.md`/`NASSAJ.md` (تعليمات) نحو الجذر المشترك (ADR-014).
  4. **Gemini:** عزل اعتماد عبر `GEMINI_CLI_HOME`؛ المحادثات مشتركة.
  5. **Codex:** عزل مؤجَّل (استخدام شبه معدوم).
  6. **agy مشترك** باعتماد المالك في V1 — brain ثابت مشترك، عزل مؤجَّل للإنتاج (ADR-016).
  7. **التزامن:** لا قفل عام؛ مشاركة حيّة كاملة + قفل discovery ضيّق على brain UUID (ADR-017).
  8. **طبقة محورية:** `resolveProviderEnv(userId, provider)` مصدر الحقيقة الوحيد للعزل.
- **المخرجات:** جداول `users`+`audit_log`، JWT auth + bootstrap owner، middleware HTTP+WS،
  invite flow، `resolveProviderEnv`، عزل Claude/Gemini، provisioning `~/.nassaj-users/<uid>`،
  قفل discovery، شاشات RTL (login/users/invites)، اختبار E2E لمستخدمين باعتمادين مختلفين/نفس brain.
- **مسار الترحيل:** بعد التحقق على `:3004`، تُنقل طبقة العزل ومجلد `~/.nassaj-users/` كما هما
  إلى الإنتاج `nassaj.alkindy.tech`.

#### معايير القبول لمرحلة MU (Acceptance Criteria)
1. **عزل اعتماد Claude يعمل:** مستخدمان مختلفان يشغّلان Claude باعتمادين منفصلين
   (`CLAUDE_CONFIG_DIR` مختلف فعلياً لكل userId).
2. **مشاركة المحادثات:** المستخدمان يريان نفس المحادثات (symlink لـ `projects/` فعّال)،
   بما فيها النشطة لحظياً (مشاركة حيّة).
3. **نفس brain لـ agy:** مستخدمان يريان نفس brain/محادثات agy المشتركة دون خلط.
4. **عزل Gemini:** `GEMINI_CLI_HOME` مختلف لكل مستخدم؛ المحادثات تبقى مشتركة.
5. **invite-only E2E:** لا تسجيل عام؛ مستخدم جديد يدخل فقط عبر دعوة من owner/admin
   (مسار دعوة → قبول → دخول يعمل end-to-end).
6. **bootstrap owner:** أول تشغيل على DB فارغة يُنشئ owner، ولا يُكرَّر بعدها.
7. **حراسة WS+HTTP:** طلب HTTP بلا JWT صالح يردّ 401؛ WebSocket upgrade بلا JWT صالح يُرفض.
8. **RTL في شاشة auth:** شاشة تسجيل الدخول وإدارة المستخدمين والدعوات تعمل بـ RTL عربي صحيح.
9. **`resolveProviderEnv` مصدر وحيد:** كل spawn لأي مزوّد يبني env عبر هذه الطبقة لا غيرها.
10. **provisioning عند الدعوة:** قبول دعوة يُنشئ `~/.nassaj-users/<uid>/.claude` + symlinks
    تلقائياً، و chmod 600 على DB قائم، و rate limit مفعّل على endpoints الـ auth.

---

## 🏗️ القرارات المعمارية (Decision Log)

> ADRs الكاملة تُحفظ في `docs/decisions/NNN-name.md` (تُكتب لاحقاً عند بدء كل مرحلة).

- **ADR-001** — استخدام `child_process.spawn` مع `agy -p` (لا `node-pty` في المرحلة الأولى). السبب: تبسيط الاعتمادات وتفادي build الأصلي.
- **ADR-002** — قراءة التاريخ من `transcript.jsonl` لا من ملفات `.pb` (Protocol Buffers). السبب: JSONL أبسط في الـ parsing ومتاح كـ source of truth.
- **ADR-003** — `AntigravityProvider` كلاس مستقل لا يمس `GeminiProvider`. السبب: عزل المخاطر ومنع regression.
- **ADR-004** — RTL عبر `dir="rtl"` ديناميكي + `tailwindcss-rtl` plugin + خطوط `Tajawal`. السبب: مرونة التبديل + تكامل مع Tailwind القائم.
- **ADR-005** — WS message type = `antigravity-command` (منفصل عن `claude-command` و `gemini-command`). السبب: routing واضح في الـ backend.
- **ADR-006** — Sub-agents تظهر كـ `tool_use` عادي مع badge بصري "Sub-agent" في المرحلة الأولى. تأجيل nested rendering لمرحلة لاحقة.
- **ADR-007** — Auth = فحص وجود `agy` binary + token + ping فقط (لا login flow كامل). السبب: الـ binary مهيَّأ على مستوى النظام.
- **ADR-008** — DB منفصلة إلزامياً عبر `NASSAJ_DB_PATH` env var. السبب: تفادي تعارض بين port 3001 (إنتاج) و 3004 (تطوير).
- **ADR-018** — Passkey باستخدام `@simplewebauthn/server` v10 (لا WebAuthn API الخام). السبب: يُغلّف CBOR/attestation/assertion تلقائياً، TypeScript native، بدون متطلبات خارجية.
- **ADR-019** — Passkey طريقة مصادقة إضافية لا بديلة في MVP (Fallback إلى كلمة المرور إلزامي). السبب: تجنّب lockout في غياب جهاز Passkey.
- **ADR-020** — `pwd_iat` = `null` في JWT الصادر عبر Passkey + `auth_method: 'passkey'` claim. السبب: Passkey لا يرتبط بإصدار كلمة مرور؛ middleware يتجاهل شرط `pwd_iat` عند `auth_method: 'passkey'`.

**قرارات مرحلة Multi-User (محفوظة في `~/.claude/alkindy/decisions/`):**
- **ADR-014** — [نطاق عزل الاعتمادات](~/.claude/alkindy/decisions/014-credential-isolation-scope.md): عزل اعتماد per-user فقط (Claude/Gemini) مع مشاركة حيّة كاملة للمحادثات والملفات والتعليمات.
- **ADR-015** — [Auth مدمج مقابل proxy منفصل](~/.claude/alkindy/decisions/015-auth-in-app-vs-proxy.md): دمج Auth داخل التطبيق (JWT stateless، invite-only، argon2id، bootstrap owner) — لا proxy؛ يحلّ محلّ ADR-010/012.
- **ADR-016** — [agy مشترك في V1](~/.claude/alkindy/decisions/016-agy-shared-credential-v1.md): agy باعتماد المالك مشترك، عزل مؤجَّل للإنتاج (البايناري Go بلا env knob).
- **ADR-017** — [brain مشترك + قفل discovery ضيّق](~/.claude/alkindy/decisions/017-shared-brain-live-concurrency.md): لا قفل عام؛ قفل لحظي فقط على نافذة اكتشاف brain UUID.

---

## ⚠️ المخاطر والتخفيفات

| المخاطرة | الاحتمال | الأثر | التخفيف |
|---|---|---|---|
| **R-2** `agy -p` لا يدعم streaming حقيقي | متوسط | عالٍ (حرج) | التحقق في B-10 أولاً قبل بقية Phase 1. عند الفشل: رفع m-60 (PTY support) إلى Blocking وتعليق Phase 1. |
| **R-8** تعارض DB بين port 3001 و 3004 | عالٍ | عالٍ | `NASSAJ_DB_PATH` مختلف إلزامياً عبر `.env`، مع فحص runtime في startup. |
| **R-5** `tailwindcss-rtl` يكسر styles قائمة | متوسط | متوسط | تفعيل تدريجي namespace-by-namespace، مع snapshot tests قبل/بعد لكل مكوّن. |
| **R-L1** AGPL-3.0 licensing | منخفض (داخلي) | عالٍ (عند النشر العام) | تنسيق مع `legal-compliance-advisor` قبل أي نشر خارجي. الكود معدَّل ويستلزم الإفصاح عند تقديم الخدمة عبر الشبكة لطرف خارجي. |

---

## 🔗 التبعيات الخارجية

- **خدمات/APIs:** `agy` CLI v1.0.2 في `~/.local/bin/agy` (Google AI Pro).
- **مشاريع أخرى:**
  - `claudecodeui-official` (الإنتاج، port 3001) — مرجع لمنع regression. (port 3001 يخص الإنتاج فقط.)
  - `nassaj.alkindy.tech` — الوجهة النهائية للميزات بعد اجتياز شرط الانتقال.
- **فرق/أشخاص:** فريق نسَّاج الداخلي للاختبار.
- **البنية التحتية:** سيرفر `nassaj` (192.168.8.3)، PM2، Nginx، subdomain `nassaj-dev.alkindy.tech`.

---

## ✅ شرط الانتقال للنسخة الرئيسية (nassaj.alkindy.tech)

لا يُنقل أي كود من `nassaj-dev` إلى الإنتاج إلا بعد تحقق **جميع** الشروط التالية:

1. `agy` يعمل E2E بدون أخطاء (chat + history + abort).
2. RTL يعمل في `sidebar` و `chat` و `settings` بدون كسر بصري.
3. لا regression على Claude provider (تقرير اختبار موقَّع).
4. ≥ 10 جلسات حقيقية على `nassaj-dev` بدون مشاكل حرجة.

---

## 🌐 البيئة

| المتغير | nassaj-dev (تطوير) | nassaj الرئيسية (إنتاج) |
|---|---|---|
| المسار | `/home/nassaj/Project/nassaj-dev/` | `/home/nassaj/Project/claudecodeui-official/` |
| النطاق | `nassaj-dev.alkindy.tech` | `nassaj.alkindy.tech` |
| Port | 3004 | 3001 |
| PM2 process | `nassaj-dev` | `claudecodeui` |
| DB | معزولة عبر `NASSAJ_DB_PATH` | افتراضية |
| GitHub | `Kindi-sa/nassaj-dev` (private fork) | `Kindi-sa/...` |

**أدوات مشتركة:**
- `agy` CLI: `~/.local/bin/agy` (v1.0.2)
- السيرفر: `nassaj` (192.168.8.3)

---

## 📚 المصادر والروابط

- **المستودع:** `github.com/Kindi-sa/nassaj-dev` (private)
- **المصدر الأصلي:** `github.com/siteboon/claudecodeui` (AGPL-3.0)
- **الذاكرة المرتبطة:** `~/.claude/projects/-home-nassaj/memory/project_nassaj-dev.md` (يُنشئها `scribe`)
- **الملخص التنفيذي:** `PROJECT_STATUS.md`
- **Work Items:** `docs/workitems/`
- **القرارات المعمارية:** `docs/decisions/`
- **مرجع السيرفر:** `/home/nassaj/nassaj-server-docs.md`
