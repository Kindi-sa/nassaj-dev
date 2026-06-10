# PHASE-PK — Passkey (WebAuthn/FIDO2)

> ## ✅ الحالة: منفَّذة كاملة — 2026-06-10 (ADR-026)
>
> نُفِّذت وفق خطة architect المعتمدة **B-PK-1..4 + C-PK-1..3** (لا بترقيم مسودة هذا الملف أدناه):
>
> | البند | المضمون | Commit |
> |---|---|---|
> | B-PK-1 | جدول `webauthn_credentials` (migration) + repository ‏`webauthnCredentialsDb` | `81948fe` |
> | B-PK-2 | env ‏`WEBAUTHN_RP_ID/ORIGIN/RP_NAME` + مخزن challenge في الذاكرة (TTL ‏5 دقائق، single-use) | `a55e0d5` |
> | B-PK-3+4 | خدمة + مسارات `/api/auth/webauthn` (تسجيل مصادَق، دخول عام discoverable بنفس عقد `/login`، rate-limit، audit، ‏`@simplewebauthn/server@13.3.1`) | `8c142cf` |
> | C-PK-1+2 | زر «الدخول بمفتاح مرور» في LoginForm + طبقة client ‏`@simplewebauthn/browser` | `d72a38e` |
> | C-PK-3 | قسم إدارة المفاتيح في Profile (إضافة/تسمية/حذف، شارة synced/device-bound) | `9c1fe98` |
>
> **الاختبارات:** suite الخادم خضراء 283+15 (منها +21 جديدة).
> **انحرافات عن مسودة الخطة أدناه** (موثّقة ومبرَّرة في **ADR-026**): جدول واحد `webauthn_credentials`
> (لا `passkey_credentials`/`passkey_challenges` — الـchallenge في الذاكرة مع مسار ترقية SQLite)؛
> v13 بدل v10؛ مسارات `/api/auth/webauthn/*` بدل `/api/auth/passkey/*`؛ ‏`userVerification: preferred`؛
> نفس عقد `/login` دون حقول JWT إضافية.
> **قيود معروفة:** challenge في الذاكرة (عملية واحدة)، rpID مثبّت على النطاق، fallback كلمة المرور باقٍ.
> **تشغيلياً:** يتطلب `pm2 restart nassaj-dev --update-env` ينفّذه المستخدم بطرفيته؛ ‏`WEBAUTHN_*` في `ecosystem.config.cjs`.
>
> **ما يلي أدناه هو المسودة التخطيطية الأصلية** — تُحفظ مرجعاً تاريخياً؛ عند التعارض الحجة لـADR-026 والكود.

---

> **تعتمد على:** اكتمال Phase MU (جدول `users` + JWT + `user_credentials` موجودة).
> **المكتبات:** `@simplewebauthn/server` v10 (backend) + `@simplewebauthn/browser` (frontend).

---

## المتطلبات الأمنية (غير قابلة للتفاوض)

- `userVerification: required` في كل registration وauthentication.
- التحقق من `rpID` و `origin` server-side في كل assertion.
- Challenge: nonce عشوائي 32-byte، استخدام مرة واحدة، TTL = 5 دقائق.
- `signCount`: يُتحقق منه ويُحدَّث في نفس transaction مع إصدار JWT.
- JWT عبر Passkey: `pwd_iat: null` + `auth_method: 'passkey'` (ADR-020).
- Passkey endpoints معطّلة عند `IS_PLATFORM = true` (تعيد 501).

---

## Work Items

### m-PK-1 — DB Migration: جدولا passkey_credentials وpasskey_challenges

```sql
CREATE TABLE passkey_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  credential_id  TEXT    NOT NULL UNIQUE,
  public_key     TEXT    NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  device_type    TEXT    NOT NULL,
  backed_up      INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,
  display_name   TEXT,
  aaguid         TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_passkey_creds_user    ON passkey_credentials(user_id);
CREATE INDEX idx_passkey_creds_cred_id ON passkey_credentials(credential_id);

CREATE TABLE passkey_challenges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  challenge    TEXT NOT NULL UNIQUE,
  operation    TEXT NOT NULL, -- 'registration' | 'authentication'
  expires_at   INTEGER NOT NULL, -- Unix ms
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_passkey_challenges_challenge  ON passkey_challenges(challenge);
CREATE INDEX idx_passkey_challenges_expires_at ON passkey_challenges(expires_at);
CREATE INDEX idx_passkey_challenges_user       ON passkey_challenges(user_id);
```

**الملف:** `server/modules/database/migrations/` (migration جديد)

---

### m-PK-2 — Cleanup Job: حذف challenges منتهية الصلاحية

- Cron داخلي كل 10 دقائق: `DELETE FROM passkey_challenges WHERE expires_at < unixepoch() * 1000`
- يُسجَّل عدد السجلات المحذوفة في debug log.
- **الملف:** `server/modules/database/cleanup.ts` أو داخل `passkey.service.ts`

---

### M-PK-1 — passkey.db.ts (Repository)

CRUD للجدولين:
- `createChallenge(userId, operation, challenge, expiresAt)`
- `consumeChallenge(challenge)` — يحذف ويعيد السجل atomically
- `saveCredential(userId, credentialData)`
- `findCredentialById(credentialId)`
- `findCredentialsByUser(userId)`
- `updateCredentialCounter(credentialId, newCounter, lastUsedAt)`
- `deleteCredential(credentialId, userId)` — يتحقق من ملكية userId

**الملف:** `server/modules/database/repositories/passkey.db.ts`

---

### M-PK-2 — passkey.service.ts

منطق التحقق عبر `@simplewebauthn/server`:

```typescript
// Registration
generateRegistrationOptions(user, existingCredentials) → options
verifyRegistration(response, expectedChallenge) → { verified, registrationInfo }

// Authentication
generateAuthenticationOptions(allowCredentials?) → options
verifyAuthentication(response, credential, expectedChallenge) → { verified, authenticationInfo }
```

- يقرأ `WEBAUTHN_RP_ID` و `WEBAUTHN_ORIGIN` من env (إلزامي — بدونهما يرفض الـ startup).
- يتحقق دائماً من `userVerification: required` في نتيجة التحقق.

**الملف:** `server/services/passkey.service.ts`

---

### M-PK-3 — passkey.routes.ts (6 Endpoints)

```
POST /api/auth/passkey/register/begin     → يتطلب JWT صالح
POST /api/auth/passkey/register/finish    → يتطلب JWT صالح
POST /api/auth/passkey/auth/begin         → عام (rate-limited)
POST /api/auth/passkey/auth/finish        → عام (rate-limited: 10/15min/IP)
GET  /api/auth/passkey/credentials        → يتطلب JWT صالح
DELETE /api/auth/passkey/credentials/:id  → يتطلب JWT صالح
```

- `auth/begin` يقبل `username?` في body (يُضيّق `allowCredentials` عند وجوده).
- `auth/finish` يُصدر JWT مع `{ ...user, auth_method: 'passkey', pwd_iat: null }`.
- جميع الـ endpoints ترجع 501 عند `IS_PLATFORM = true`.

**الملف:** `server/routes/passkey.routes.ts`

---

### C-PK-1 — usePasskey Hook

```typescript
// src/hooks/usePasskey.ts
function usePasskey() {
  registerPasskey(displayName?: string): Promise<{ credentialId, displayName }>
  authenticateWithPasskey(username?: string): Promise<{ token, user }>
  isSupported: boolean  // window.PublicKeyCredential !== undefined
}
```

يستخدم `startRegistration`/`startAuthentication` من `@simplewebauthn/browser`.

**الملف:** `src/hooks/usePasskey.ts`

---

### C-PK-2 — PasskeyRegisterSection

مكوّن في صفحة Profile Settings:
- يعرض Passkeys المسجّلة (display_name + last_used_at + device_type badge).
- زر "أضف Passkey" — يستدعي `registerPasskey()` ثم يُحدِّث القائمة.
- زر حذف لكل Passkey مع تأكيد.
- يُخفى تلقائياً إذا `!isSupported`.

**الملف:** `src/components/settings/PasskeyRegisterSection.tsx`

---

### C-PK-3 — PasskeyLoginButton

- زر "ادخل بـ Passkey" في `LoginForm` (تحت حقل كلمة المرور).
- يُظهر spinner أثناء التحقق.
- يُخفى تلقائياً إذا `!isSupported` أو `IS_PLATFORM = true`.
- عند النجاح: يحفظ الـ token ويعيد توجيه المستخدم.

**الملف:** `src/components/auth/PasskeyLoginButton.tsx`

---

### B-PK-1 — إضافة display_name وenv vars

- إضافة `WEBAUTHN_RP_ID` و `WEBAUTHN_ORIGIN` لـ `.env.example` و startup validation.
- قيم افتراضية: `RP_ID=nassaj-dev.alkindy.tech`، `ORIGIN=https://nassaj-dev.alkindy.tech`.

### B-PK-2 — تعديل authenticateToken middleware

- إضافة استثناء: إذا `token.auth_method === 'passkey'` → تجاهل شرط `pwd_iat`.
- تأكد أن الشرط لا يكسر الحالات الحالية (كلمة مرور).

### B-PK-3 — تركيب Routes ومتطلبات الحزم

- تركيب الـ routes الجديدة في `server/app.ts` أو نقطة تجميع الـ routes.
- إضافة `@simplewebauthn/server` و `@simplewebauthn/browser` لـ `package.json`.
- تأكيد: `IS_PLATFORM` guard موجود في auth routes.

---

## ترتيب التنفيذ

```
m-PK-1 → m-PK-2
       ↓
     M-PK-1 → M-PK-2 → M-PK-3
                              ↓
              C-PK-1 → C-PK-2, C-PK-3
                              ↓
              B-PK-1, B-PK-2, B-PK-3 (بالتوازي)
```

---

## معايير القبول

1. Registration E2E: مستخدم مسجّل يُضيف Passkey وتُحفظ في `passkey_credentials`.
2. Authentication E2E: مستخدم يدخل عبر Passkey ويحصل على JWT صالح.
3. `userVerification` مرفوض server-side إذا أعاد المتصفح `userVerified: false`.
4. Challenge لا يُقبل مرتين (الثانية تُعيد 400).
5. Challenge منتهي الصلاحية يُعيد 400.
6. حذف Passkey لا يحذف passkey مستخدم آخر (يتحقق من `user_id`).
7. `IS_PLATFORM = true` → جميع الـ 6 endpoints تُعيد 501.
8. Fallback لكلمة المرور يعمل بعد إضافة/حذف Passkey.
