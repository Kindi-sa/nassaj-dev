# موافقة معالجة البيانات (PDPL) — nassaj-dev متعدّد المستخدمين / Data Processing Consent (PDPL) — Multi-User nassaj-dev

> ⚠️ **مسوّدة امتثال داخلية — ليست استشارة قانونية.**
> هذا المستند صياغة داخلية لتأطير معالجة بيانات المستخدمين في تثبيت `nassaj-dev` متعدّد المستخدمين (Phase-MU) وفق نظام حماية البيانات الشخصية السعودي (PDPL). **التوقيع النهائي قبل أي إطلاق علني** يتطلّب مراجعة **`legal-compliance-advisor`** + **محامٍ مرخّص**. لا يُعتمد كمصدر التزام قانوني بصيغته الحالية.
>
> ⚠️ **Internal compliance draft — not legal advice.**
> This document is an internal framing of how the multi-user `nassaj-dev` install (Phase-MU) processes user data under the Saudi Personal Data Protection Law (PDPL). **Final sign-off before any public launch** requires review by **`legal-compliance-advisor`** + a **licensed attorney**. It is not a binding legal source as drafted.

| الحقل / Field | القيمة / Value |
|---|---|
| **الإصدار / Version** | 0.1 — Draft |
| **التاريخ / Date** | 2026-06-09 |
| **النطاق / Scope** | تثبيت `nassaj-dev` متعدّد المستخدمين على `nassaj-dev.alkindy.tech:3004` (داخلي) |
| **المالك / Owner** | i.rukhaimi |
| **مرتبط بـ / Related** | ADR-023 (Decision 1 — ToS، الإطلاق العلني) · `[B-MU-LEGAL]` · `docs/RUNBOOK-MULTI-USER.md` |
| **الحالة / Status** | 🟡 مسوّدة داخلية — كافية للاستخدام الداخلي، **حاجبة للإطلاق العلني** |

ثنائي اللغة: سرد عربي + الحقول/المصطلحات الإنجليزية حيث يلزم.

---

## 1. الغرض والنطاق / Purpose & Scope

**العربية**

يصف هذا المستند **ما يُعالَج من بيانات شخصية** ضمن تشغيل `nassaj-dev` متعدّد المستخدمين، وأساس المعالجة، والاحتفاظ، والوصول، وحقوق صاحب البيانات. الاستخدام الحالي **داخلي بحت** (فريق نسّاج، ثقة متبادلة) — لا جمهور خارجي ولا تسجيل عام.

> حدّ معماري مُقرّ (ADR-023، Decision 2): العزل بين المستخدمين **نسبة فوترة لا حدّ أمني**؛ كل المستخدمين على uid نظامي واحد ويتشاركون الملفات والمحادثات. فريق متبادل الثقة بالتصميم. هذا أساس تأطير المخاطرة في هذا المستند.

**English**

This document describes **what personal data is processed** in the multi-user `nassaj-dev` operation, the basis of processing, retention, access, and the data subject's rights. Current use is **strictly internal** (the nassaj team, mutually trusting) — no external public, no open registration.

> Accepted architectural boundary (ADR-023, Decision 2): inter-user isolation is a **billing boundary, not a security boundary**; all users share one system uid and share files and conversations. A mutually-trusting team by design. This frames the risk model herein.

---

## 2. أساس الكفاية الداخلية مقابل الحجب العلني / Internal Sufficiency vs. Public-Launch Gate

**العربية**

| البُعد | الاستخدام الداخلي (الحالي) | الإطلاق العلني (محجوب) |
|---|---|---|
| **من يستخدم** | فريق نسّاج فقط، حسابات مُنشأة بدعوة من المالك/admin | جمهور خارجي / تسجيل ذاتي |
| **كفاية الموافقة** | ✅ **موافقة داخلية كافية** (إقرار موقّع من كل عضو فريق، القالب في §7) | ❌ غير كافية — يلزم موافقة موقّعة لكل مستخدم + سياسة خصوصية منشورة |
| **المراجعة القانونية** | لا تُلزم لبدء العمل الداخلي على `:3004` | **إلزامية** — `legal-compliance-advisor` + محامٍ مرخّص |
| **بوابة ToS (Anthropic)** | مخاطرة رمادية مقبولة داخلياً (ADR-023، Decision 1) | **حاجبة** — OAuth-consumer محظور علنياً؛ المسار الوحيد BYO-API-key تحت Commercial Terms |

**الخلاصة:** هذه الوثيقة + الإقرار الداخلي الموقّع (§7) **يكفيان للاستخدام الداخلي**. أي **إطلاق علني** يتطلّب — كبوابة لا رجعة عنها قبل الإطلاق — استيفاء `[B-MU-LEGAL]` (إغلاق ToS) + موافقة PDPL مكتوبة مُراجَعة قانونياً + سياسة خصوصية منشورة. هذا متّسق مع ADR-023 (Consequences: «حاجب للإطلاق العلني (لا للعمل الداخلي): إغلاق ToS قانونياً + موافقة PDPL مكتوبة»).

**English**

| Dimension | Internal use (current) | Public launch (gated) |
|---|---|---|
| **Who uses it** | nassaj team only; accounts created by owner/admin invite | external public / self-registration |
| **Consent sufficiency** | ✅ **internal consent suffices** (signed acknowledgment per team member, template in §7) | ❌ insufficient — requires signed per-user consent + published privacy policy |
| **Legal review** | not required to begin internal work on `:3004` | **mandatory** — `legal-compliance-advisor` + licensed attorney |
| **ToS gate (Anthropic)** | grey-area risk accepted internally (ADR-023, Decision 1) | **blocking** — OAuth-consumer barred publicly; only path is BYO-API-key under Commercial Terms |

**Bottom line:** this document + the signed internal acknowledgment (§7) **suffice for internal use**. Any **public launch** requires — as a non-negotiable pre-launch gate — completing `[B-MU-LEGAL]` (ToS closure) + a legally-reviewed written PDPL consent + a published privacy policy. This is consistent with ADR-023 (Consequences: "blocking for public launch (not internal work): legally closing ToS + written PDPL consent").

---

## 3. البيانات الشخصية المُعالَجة / Personal Data Processed

**العربية**

| فئة البيانات / Data category | الحقول / Fields | المصدر / المخزن |
|---|---|---|
| **حساب المستخدم / Account** | `username`, `role` (owner/admin/user), `status`, `email` (اختياري في الدعوة), تجزئة كلمة المرور (bcrypt/argon2 — لا نص صريح), `last_login`, `must_change_password` | جدول `users` في `db.sqlite` |
| **الدعوات / Invites** | `role`, `email` (إن قُدّم), `status`, `expires_at`, **هاش SHA-256 للتوكن** (لا التوكن نصاً) | جدول `invites` |
| **الصورة الشخصية / Avatar** | ملف صورة (jpeg/png/webp/gif ≤ 2MB) باسم مشتق من `userId` | `~/.nassaj-users/<userId>/avatar.<ext>` |
| **المحادثات والمشاريع / Conversations & projects** | تاريخ المحادثات، التعليمات، ملفات المشروع — **مشتركة بين كل المستخدمين بالتصميم** (symlinks، ADR-014) | `~/.claude/projects` المشترك (لا تُعزَل) |
| **اعتماد Claude لكل مستخدم / Per-user Claude credential** | توكن OAuth (أو API-key مستقبلاً) في دليل معزول بصلاحية `0600` | `~/.nassaj-users/<userId>/.claude/.credentials.json` |
| **سجل التدقيق / Audit log** | `action`, `user_id`, `created_at`, `metadata` — أحداث مثل `login_success` / `login_failure` / `invite_created` / `invite_accepted` / `role_changed` / `password_changed` / `password_reset` / `username_changed` / `avatar_updated` / `bootstrap_owner` / `admin_provider_sharing_update` / `user_dirs_provisioned` | جدول `audit_log` |

> **تنبيه خصوصية جوهري:** المحادثات وملفات المشاريع **مشتركة بين كل المستخدمين** — أي مستخدم يرى محادثات غيره. هذا قرار تصميمي (ADR-014/ADR-023، Decision 3) وليس تسريباً. **يجب أن يُقرّ كل مستخدم بهذا صراحة** (بند الموافقة §7-ب). لا تُدخل بيانات شخصية حسّاسة لأطراف ثالثة في المحادثات.

**English**

> **Material privacy notice:** conversations and project files are **shared across all users** — any user can see another's chats. This is a design decision (ADR-014/ADR-023, Decision 3), not a leak. **Each user must explicitly acknowledge it** (consent clause §7-b). Do not enter sensitive third-party personal data into conversations.

كلمات المرور تُخزَّن مُجزَّأة (bcrypt/argon2) فقط، ولا تُسجَّل نصاً أبداً ولا في `audit_log`. توكنات الدعوة تُخزَّن كهاش SHA-256. اعتماد Claude لكل مستخدم في دليل معزول بصلاحية `0600`. / Passwords are stored hashed (bcrypt/argon2) only, never logged in plaintext nor in `audit_log`. Invite tokens are stored as SHA-256 hashes. Per-user Claude credentials live in an isolated dir at mode `0600`.

---

## 4. أساس المعالجة والغرض / Lawful Basis & Purpose

**العربية**

- **الأساس:** الموافقة الصريحة من كل عضو فريق (إقرار §7) + المصلحة المشروعة لتشغيل أداة عمل داخلية.
- **الغرض المحدّد:** (1) المصادقة وإدارة الوصول؛ (2) تشغيل جلسات الذكاء الاصطناعي بفوترة منسوبة لكل مستخدم عبر اشتراكه؛ (3) التدقيق الأمني عبر `audit_log`. **لا** تُستخدم البيانات لأي غرض تسويقي أو بيع لطرف ثالث.

**English**

- **Basis:** explicit consent of each team member (acknowledgment §7) + legitimate interest in operating an internal work tool.
- **Specified purpose:** (1) authentication and access control; (2) running AI sessions with billing attributed per user via their subscription; (3) security auditing via `audit_log`. Data is **not** used for any marketing purpose or sold to third parties.

---

## 5. الاحتفاظ والحذف / Retention & Deletion

**العربية**

| البيانات | مدة الاحتفاظ | عند مغادرة العضو |
|---|---|---|
| حساب المستخدم | طوال العضوية | يُعطَّل (`status=disabled`) ثم يُحذف عند الطلب |
| اعتماد Claude المعزول | طوال العضوية | يُحذف دليل `~/.nassaj-users/<userId>/` |
| سجل التدقيق `audit_log` | يُحتفظ به لأغراض الأمن (مدة تُحدَّد قانونياً قبل العلني) | يبقى (مُجهَّل الربط قدر الإمكان) |
| المحادثات المشتركة | مشتركة — لا تُحذف بحذف مستخدم واحد | تبقى ضمن المخزن المشترك |

> حذف مستخدم لا يحذف المحادثات المشتركة (مملوكة جماعياً). يُوضَّح هذا في إقرار §7.

**English**

| Data | Retention | On member departure |
|---|---|---|
| User account | for the duration of membership | disabled (`status=disabled`) then deleted on request |
| Isolated Claude credential | for the duration of membership | the `~/.nassaj-users/<userId>/` dir is deleted |
| `audit_log` | retained for security (period to be legally set before public) | retained (link de-identified where feasible) |
| Shared conversations | shared — not deleted by removing one user | remain in the shared store |

> Deleting a user does not delete shared conversations (collectively owned). This is stated in the §7 acknowledgment.

---

## 6. الوصول والحقوق / Access & Rights

**العربية**

- **الوصول:** owner/admin يديرون الحسابات والأدوار وسياسة مشاركة الموفّرين. كل مستخدم يصل لحسابه وصورته واعتماده. المحادثات مشتركة بين الجميع.
- **حقوق صاحب البيانات (PDPL):** حق العلم، الوصول، التصحيح، الحذف (ضمن قيود §5)، وسحب الموافقة. تُمارَس بطلب للمالك.
- **أمن:** صلاحيات `0750` للدلائل و`0600` للاعتمادات وDB، كلمات مرور مُجزَّأة، JWT موقّع، rate limiting على الدخول، audit log. التفاصيل التشغيلية في `docs/RUNBOOK-MULTI-USER.md` §9.

**English**

- **Access:** owner/admin manage accounts, roles, and provider-sharing policy. Each user accesses their own account, avatar, and credential. Conversations are shared among all.
- **Data-subject rights (PDPL):** right to be informed, to access, to rectify, to erase (within §5 limits), and to withdraw consent. Exercised by request to the owner.
- **Security:** `0750` dir modes, `0600` for credentials and DB, hashed passwords, signed JWT, login rate-limiting, audit log. Operational detail in `docs/RUNBOOK-MULTI-USER.md` §9.

---

## 7. قالب الإقرار والموافقة (قابل للتوقيع) / Acknowledgment & Consent Template (signable)

**العربية**

> يُملأ ويُوقَّع من كل عضو فريق قبل تفعيل حسابه. نسخة موقّعة تُحفظ لدى المالك.

أقرّ أنا الموقّع أدناه بأنني قرأتُ وفهمتُ، وأوافق على ما يلي بخصوص استخدامي لتثبيت `nassaj-dev` الداخلي:

- **(أ) المعالجة:** تُعالَج بياناتي (الحساب، البريد إن قُدّم، الصورة، سجل التدقيق، اعتماد Claude الخاص بي) للأغراض المذكورة في §4 فقط.
- **(ب) المشاركة:** أُقرّ أن **المحادثات وملفات المشاريع والتعليمات مشتركة مع بقية أعضاء الفريق**، وأتعهّد بعدم إدخال بيانات شخصية حسّاسة لأطراف ثالثة فيها.
- **(ج) الفوترة والاعتماد:** أتولّى تسجيل اشتراك Claude الخاص بي بهويّتي عبر الطرفية، والفوترة على حسابي.
- **(د) الحقوق:** أعلم بحقّي في الوصول والتصحيح والحذف وسحب الموافقة (§6)، وأن حذف حسابي لا يحذف المحادثات المشتركة.
- **(هـ) الطبيعة الداخلية:** أعلم أن هذا التثبيت **داخلي**، وأن أي إطلاق علني يتطلّب موافقة منفصلة ومراجعة قانونية.

| الحقل / Field | القيمة / Value |
|---|---|
| Full name / الاسم الكامل | __________________________ |
| Username | __________________________ |
| Role (owner/admin/user) | __________________________ |
| Date / التاريخ | __________________________ |
| Signature / التوقيع | __________________________ |

**English**

> Filled and signed by each team member before their account is activated. A signed copy is retained by the owner.

I, the undersigned, acknowledge that I have read and understood, and I consent to the following regarding my use of the internal `nassaj-dev` install:

- **(a) Processing:** my data (account, email if provided, avatar, audit log, my own Claude credential) is processed only for the purposes in §4.
- **(b) Sharing:** I acknowledge that **conversations, project files, and instructions are shared with the rest of the team**, and I undertake not to enter sensitive third-party personal data into them.
- **(c) Billing & credential:** I register my own Claude subscription under my identity via the terminal; billing is on my account.
- **(d) Rights:** I am aware of my rights to access, rectify, erase, and withdraw consent (§6), and that deleting my account does not delete shared conversations.
- **(e) Internal nature:** I am aware this install is **internal**, and that any public launch requires separate consent and legal review.

---

## 8. بوابة ما قبل الإطلاق العلني / Pre-Public-Launch Gate

**العربية**

قبل أي إطلاق علني (حاجب، لا رجعة عنه قبل الإطلاق):

- [ ] إغلاق ToS قانونياً — `[B-MU-LEGAL]` (ADR-023، Decision 1: المسار العلني الوحيد BYO-API-key تحت Commercial Terms).
- [ ] مراجعة هذا المستند بواسطة `legal-compliance-advisor` + محامٍ مرخّص.
- [ ] سياسة خصوصية منشورة + موافقة موقّعة لكل مستخدم علني.
- [ ] إعادة فحص قانوني بالنسخة السارية من Anthropic Terms وقت الإطلاق.

**English**

Before any public launch (blocking, non-negotiable pre-launch):

- [ ] Legally close ToS — `[B-MU-LEGAL]` (ADR-023, Decision 1: only public path is BYO-API-key under Commercial Terms).
- [ ] This document reviewed by `legal-compliance-advisor` + a licensed attorney.
- [ ] Published privacy policy + signed per-user consent for every public user.
- [ ] Re-check against the Anthropic Terms version in force at launch time.

---

## سجل التغييرات / Changelog

- **2026-06-09** — مسوّدة أولية 0.1 (B-MU-PDPL). نطاق المعالجة، الكفاية الداخلية مقابل الحجب العلني، قالب إقرار قابل للتوقيع. غير مُراجَعة قانونياً بعد.
