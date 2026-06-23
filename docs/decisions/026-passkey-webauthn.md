# ADR-026 — الدخول بمفتاح مرور (Passkey / WebAuthn)

> **سجلّ قرار معماري (ADR).** الصيغة: Context → Decisions (1..4) → Deployment → Consequences → Follow-ups.
> يوثّق قرارات تنفيذ ميزة Passkey/WebAuthn (تسجيل المفاتيح، الدخول العام، تخزين الـchallenge، الإعداد عبر env).
>
> *Architectural decision record for the Passkey/WebAuthn feature: library choice, discoverable-credentials-first login, in-memory challenge store with a documented SQLite upgrade path, and env-driven rpID/origin.*

| الحقل / Field | القيمة / Value |
|---|---|
| **Status** | ✅ **Accepted** — 2026-06-10 (منفَّذة كاملة / fully implemented) |
| **التاريخ / Date** | 2026-06-10 |
| **المالك / Owner** | i.rukhaimi |
| **مرتبط بـ / Related** | `docs/workitems/PHASE-PK.md` (الخطة الأصلية والانحرافات الموثّقة) · ADR-023 (Phase-MU auth) |
| **النطاق / Scope** | المصادقة: `server/services/webauthn.service.js`، `server/routes/webauthn.js`، `server/modules/database/` (جدول `webauthn_credentials`)، `src/components/auth/`، `src/components/settings/` |
| **Commits** | B-PK-1: `81948fe` · B-PK-2: `a55e0d5` · B-PK-3+4: `8c142cf` · C-PK-1+2: `d72a38e` · C-PK-3: `9c1fe98` |

---

## Context

كلمة المرور هي مسار الدخول الوحيد. أُريد دخول أسرع وأأمن (phishing-resistant) عبر Passkeys مع إبقاء كلمة المرور fallback. خطة architect (B-PK-1..4 + C-PK-1..3) اعتُمدت ونُفِّذت كاملة في 2026-06-10، مع انحرافات مقصودة عن مسودة `PHASE-PK.md` القديمة موثّقة أدناه.

*Passwords were the only login path. Passkeys add phishing-resistant sign-in while keeping the password fallback. The approved architect plan (B-PK-1..4 + C-PK-1..3) was fully implemented on 2026-06-10, with deliberate, documented deviations from the older PHASE-PK.md draft.*

---

## Decisions

### Decision 1 — المكتبة: `@simplewebauthn` v13

- خادم: `@simplewebauthn/server@13.3.1` (ESM) · واجهة: `@simplewebauthn/browser` v13.
- **بدل** v10 المذكورة في مسودة الخطة القديمة — v13 هي الحالية المدعومة وتغطي discoverable credentials بسلاسة.
- **السبب:** مكتبة مرجعية مفردة للطرفين، تتولّى تفاصيل CBOR/attestation/assertion بدل تنفيذ يدوي هشّ.

### Decision 2 — Discoverable credentials أولاً (دخول عام بلا username)

- `login/options` عام يصدر `allowCredentials: []` — المتصفح يعرض مفاتيح المستخدم المخزّنة (resident keys) دون إدخال username.
- `login/verify` يعيد **نفس عقد `/login`** بالضبط (`{success, user:{id,username,role}, token}`) — لا مسار جلسة موازٍ؛ بوابات `mustChangePassword` وonboarding تعمل كما هي (`AuthContext.loginWithPasskey` يحاكي خطوات الدخول).
- نفس وضعية rate-limit لـ`/login` ‏(10/15min/IP) + audit ‏(`login_success`/`login_failure` بـ`method:'passkey'`، ورسائل عميل عامة مع أكواد داخلية للـaudit فقط).
- التسجيل/الإدارة مصادَقة (JWT): ‏`register/options`، `register/verify`، `GET/PATCH/DELETE credentials` مع فرض الملكية.

### Decision 3 — الـchallenge في الذاكرة مع مسار ترقية لـSQLite

- مخزن في الذاكرة: ‏`Map` بمفتاح الـchallenge ‏`{userId|null, expiresAt}`، ‏TTL ‏**5 دقائق**، استهلاك مرة واحدة (single-use)، prune كسول؛ factory للاختبارات + singleton للعملية.
- **قيد مقبول:** يعمل لعملية واحدة فقط (وضعنا الحالي — PM2 instance واحد). **مسار الترقية الموثّق:** جدول SQLite ‏(`passkey_challenges` بنمط مسودة الخطة) عند التوسّع لأكثر من عملية.
- **السبب:** صفر schema إضافي الآن، وأبسط تنفيذ صحيح؛ الترقية لاحقاً تغيير محصور في store واحد.

### Decision 4 — rpID/origin من env

- `server/constants/webauthn.js`: ‏`WEBAUTHN_RP_ID` / ‏`WEBAUTHN_ORIGIN` (قائمة مفصولة بفواصل مدعومة) / ‏`WEBAUTHN_RP_NAME` من env؛ fallback تطوير ‏(`localhost` + ‏`http://localhost:5173`)؛ تحذير إقلاع عند production بلا `WEBAUTHN_RP_ID`.
- القيم مضبوطة في `ecosystem.config.cjs` و`.env.example` لـ`nassaj.alkindy.tech` (تقاعد `nassaj-dev.alkindy.tech` 2026-06-15 — B-66).
- **قيد مقبول:** ‏rpID مثبّت على النطاق — تغيير النطاق يُبطل المفاتيح المسجّلة (سلوك WebAuthn الفطري).

### انحرافات موثّقة عن مسودة `PHASE-PK.md`

| المسودة | المنفَّذ |
|---|---|
| جدول `passkey_credentials` + `passkey_challenges` | جدول `webauthn_credentials` فقط (migration)؛ الـchallenge في الذاكرة (Decision 3) |
| `@simplewebauthn` v10 | v13 ‏(13.3.1 خادماً) |
| مسارات `/api/auth/passkey/*` | `/api/auth/webauthn/*` (مركّبة بسطر واحد في `routes/auth.js`) |
| `userVerification: required` | `preferred` ‏(+ ‏residentKey) — توازن usability/أمان مع بقاء fallback كلمة المرور |
| JWT بـ`auth_method`/`pwd_iat: null` | نفس عقد `/login` القائم دون حقول إضافية |

---

## Deployment

| الطبقة / Layer | الأثر / Effect |
|---|---|
| واجهة (`dist/`) | ‏`build:client` + تحديث المتصفح. |
| خادم (`dist-server/`) | يتطلب `pm2 restart nassaj-dev --update-env` (لالتقاط `WEBAUTHN_*`) — **محجوب بحارس العميل، ينفّذه المالك في طرفيته**. |
| env | `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_NAME` مضبوطة في `ecosystem.config.cjs`. |

**الاختبارات:** suite الخادم خضراء ‏(283+15، منها **+21 جديدة**: 6 repository ‏+ 5 challenge store ‏+ 10 تكامل endpoints — تشمل challenge مُعاد/منتهٍ، challenge تسجيل لا يصلح للدخول، عبور مستخدمين، مستخدم معطَّل، attestation تالف يفشل مغلقاً).

---

## Consequences

- **إيجابي:** دخول phishing-resistant بنقرة؛ إدارة كاملة للمفاتيح من Profile (تسمية/إعادة تسمية/حذف بتأكيد، شارة synced/device-bound)؛ لا تغيير في عقد الجلسة أو بواباتها؛ audit كامل.
- **قيود مقبولة موثّقة:** challenge في الذاكرة (عملية واحدة — Decision 3)؛ rpID مثبّت على النطاق (Decision 4)؛ fallback كلمة المرور باقٍ (مقصود).
- **i18n:** مفاتيح عربية كاملة؛ بقية اللغات مرآة الإنجليزية.

---

## Follow-ups (TODO)

- [ ] ترحيل مخزن الـchallenge إلى SQLite عند التوسّع لأكثر من عملية (Decision 3).
- [ ] مراجعة رفع `userVerification` إلى `required` بعد فترة استخدام.
- [ ] ترجمة مفاتيح passkey لبقية اللغات (حالياً مرآة الإنجليزية).

---

## سجل التغييرات / Change Log

- **2026-06-10** — اعتماد ADR-026 وتنفيذ الميزة كاملة (B-PK-1..4 + C-PK-1..3): ‏simplewebauthn v13، discoverable credentials أولاً بنفس عقد `/login`، challenge في الذاكرة TTL ‏5 دقائق مع مسار ترقية SQLite، ‏rpID/origin من env. الحالة → Accepted.
