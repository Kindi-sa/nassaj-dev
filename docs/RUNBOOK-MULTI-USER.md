# Runbook: nassaj-dev Multi-User (Phase-MU)

> الإصدار: 1.0 — 2026-05-26
> النطاق: تشغيل وإدارة نسخة `nassaj-dev` متعددة المستخدمين (Phase-MU) وميزة مشاركة الـ providers من لوحة الإدارة.
> الخدمة: `nassaj-dev` على المنفذ `3004` — محلياً `http://localhost:3004`، عبر الويب `https://nassaj.alkindy.tech`.

> Version: 1.0 — 2026-05-26
> Scope: Operating and administering the multi-user `nassaj-dev` install (Phase-MU) and the admin provider-sharing feature.
> Service: `nassaj-dev` on port `3004` — locally `http://localhost:3004`, public `https://nassaj.alkindy.tech`.

ثنائي اللغة: كل قسم بالعربية أولاً ثم الإنجليزي. أسماء الكود والأوامر إنجليزية دائماً.

---

## 1. المتطلبات / Prerequisites

**العربية**

- Node.js (نفس إصدار الإنتاج) و `pm2` مثبّت عالمياً.
- `sqlite3` CLI لاستعلامات الصيانة.
- البناء تم مرة واحدة: `npm run build` ينتج `dist-server/` الذي يشير إليه `ecosystem.config.cjs` (`script: 'dist-server/server/index.js'`).
- ملف `ecosystem.config.cjs` الموجود في جذر المشروع (لا تستبدله بـ `.js`؛ الامتداد `.cjs` مقصود لأن `package.json` فيه `"type": "module"`).
- المنفذ `3004` غير مشغول من خدمة أخرى.
- مسار قاعدة البيانات قابل للكتابة: `/home/nassaj/.local/share/nassaj-dev/db.sqlite`.

**English**

- Node.js (matching production) and `pm2` installed globally.
- `sqlite3` CLI for maintenance queries.
- One-time build done: `npm run build` produces `dist-server/`, referenced by `ecosystem.config.cjs` (`script: 'dist-server/server/index.js'`).
- The `ecosystem.config.cjs` at the project root (do not rename to `.js`; the `.cjs` extension is intentional because `package.json` declares `"type": "module"`).
- Port `3004` is free.
- DB path is writable: `/home/nassaj/.local/share/nassaj-dev/db.sqlite`.

---

## 2. أول تشغيل / First Boot

### 2.1 متغيرات البيئة المطلوبة / Required env vars

**العربية**

تُضبط داخل كتلة `env` في ملف العقدة `ecosystem.<node>.config.cjs` (قيم `env` هنا تطغى على `.env` عند التشغيل عبر pm2). القالب المتعقَّب `ecosystem.config.example.cjs` يحمل فقط مفاتيح B-N-DRAIN البنيوية المرجعية؛ القيم الخاصة بالمضيف أدناه تأتي من ملف العقدة أو `.env` (B-115). المضبوطة فعلياً اليوم:

| المتغير | القيمة الافتراضية في الملف | الفاعل؟ | الغرض |
|---|---|---|---|
| `SERVER_PORT` | `3004` | نعم | المنفذ الذي يقرأه التطبيق فعلاً |
| `PORT` | `3004` | تحوّط | يُمرَّر احتياطاً؛ الوسيط `--port 3004` هو المسار الموثّق |
| `HOST` | `0.0.0.0` | نعم | الاستماع على كل الواجهات |
| `DATABASE_PATH` | `/home/nassaj/.local/share/nassaj-dev/db.sqlite` | نعم | يمنع الكتابة على DB الإنتاج |
| `NASSAJ_DB_PATH` | نفس المسار | لا (توافق فقط) | غير مُستهلَك من الكود؛ `DATABASE_PATH` هو الفاعل |
| `JWT_SECRET` | معلَّق (placeholder) | عند ضبطه | سرّ توقيع JWT ‏(≥ 32 محرفاً) |
| `BOOTSTRAP_OWNER_USERNAME` | معلَّق | عند ضبطه | اسم مستخدم الـ owner الأول |
| `BOOTSTRAP_OWNER_PASSWORD` | معلَّق | عند ضبطه | كلمة مرور الـ owner الأول ‏(≥ 12 محرفاً) |

سلوك `JWT_SECRET` إن تُرك فارغاً: يُولَّد سرّ per-install ويُحفظ في `app_config` (يعمل، لكن ضبطه عبر env مُفضَّل للإنتاج).

توليد سرّ JWT قوي:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

سلوك الـ bootstrap owner (راجع `server/services/bootstrap-owner.service.js`):
1. `BOOTSTRAP_OWNER_USERNAME` + `BOOTSTRAP_OWNER_PASSWORD` مضبوطان → يُنشأ بهما (المُوصى به). كلمة المرور ≥ 12 محرفاً.
2. `BOOTSTRAP_OWNER_USERNAME` فقط → تُولَّد كلمة مرور قوية وتُطبع **مرة واحدة** في سجل الخادم.
3. لا شيء مضبوط → اسم المستخدم الافتراضي `owner` مع كلمة مرور مولَّدة تُطبع مرة واحدة.

كلمة المرور المولَّدة لا تُحفظ أبداً نصاً ولا في `audit_log`؛ يجب التقاطها من السجل وتغييرها بعد أول دخول.

**English**

Set inside the `env` block of the node file `ecosystem.<node>.config.cjs` (these `env` values override `.env` under pm2). The tracked `ecosystem.config.example.cjs` holds only the structural B-N-DRAIN reference keys; the host-specific values below come from the node file or `.env` (B-115). Actually wired today:

| Variable | Default in file | Active? | Purpose |
|---|---|---|---|
| `SERVER_PORT` | `3004` | Yes | The port the app actually reads |
| `PORT` | `3004` | Fallback | Passed defensively; `--port 3004` arg is the documented path |
| `HOST` | `0.0.0.0` | Yes | Listen on all interfaces |
| `DATABASE_PATH` | `/home/nassaj/.local/share/nassaj-dev/db.sqlite` | Yes | Prevents writing to the production DB |
| `NASSAJ_DB_PATH` | same path | No (compat only) | Not consumed by code; `DATABASE_PATH` is the active one |
| `JWT_SECRET` | commented placeholder | When set | JWT signing secret (≥ 32 chars) |
| `BOOTSTRAP_OWNER_USERNAME` | commented | When set | Initial owner username |
| `BOOTSTRAP_OWNER_PASSWORD` | commented | When set | Initial owner password (≥ 12 chars) |

If `JWT_SECRET` is empty: a per-install secret is generated and stored in `app_config` (works, but env is preferred for production).

Generate a strong JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Bootstrap owner behavior (see `server/services/bootstrap-owner.service.js`):
1. Both `BOOTSTRAP_OWNER_USERNAME` + `BOOTSTRAP_OWNER_PASSWORD` set → created with them (recommended). Password ≥ 12 chars.
2. Only `BOOTSTRAP_OWNER_USERNAME` → a strong password is generated and printed **once** to the server log.
3. Neither set → username defaults to `owner` with a generated password printed once.

The generated password is never persisted in plaintext nor in `audit_log`; capture it from the log and rotate it after first login.

### 2.2 التشغيل عبر pm2 / Start with pm2

**العربية**

```bash
# من جذر المشروع
cd /home/nassaj/Project/nassaj-dev

# بناء لمرة واحدة إن لم يكن dist-server/ موجوداً
npm run build

# تشغيل (B-115): من ملف العقدة الخاص بهذا المضيف، لا من القالب المتعقَّب.
# استبدل <node> باسم عقدتك (مثل ecosystem.nassaj.config.cjs)؛ يولّده bootstrap-node.sh
# بكل قيم المضيف inline. القالب المتعقَّب ecosystem.config.example.cjs مرجعي فقط ولا
# يُشغَّل (بلا .env يسقط على المنفذ 3001 → EADDRINUSE؛ حادثة traventure 2026-06-30).
env -u PORT pm2 start ecosystem.<node>.config.cjs

# حفظ القائمة لتنجو من إعادة الإقلاع
pm2 save
```

**English**

```bash
# From the project root
cd /home/nassaj/Project/nassaj-dev

# One-time build if dist-server/ is missing
npm run build

# Start (B-115): from THIS host's node file, not the tracked template. Replace
# <node> with your node name (e.g. ecosystem.nassaj.config.cjs); bootstrap-node.sh
# generates it with all host values inline. The tracked ecosystem.config.example.cjs
# is reference-only and must NOT be run (with no .env it falls back to port 3001 →
# EADDRINUSE; traventure outage 2026-06-30).
env -u PORT pm2 start ecosystem.<node>.config.cjs

# Persist the list so it survives reboots
pm2 save
```

### 2.3 التحقق من إنشاء حساب الـ owner / Verify the owner account was created

**العربية**

أولاً، التقط بيانات الـ owner من السجل (تظهر مرة واحدة عند أول إقلاع على DB بلا owner):

```bash
pm2 logs nassaj-dev --lines 50 --nostream | grep -A4 "BOOTSTRAP OWNER CREATED"
```

ثانياً، تحقق عبر الـ API العام أن النظام لم يعد بحاجة إلى إعداد (`needsSetup: false` يعني أن الـ owner موجود):

```bash
curl -s http://localhost:3004/api/auth/status
# المتوقع بعد الإنشاء: {"needsSetup":false,"isAuthenticated":false}
```

ثالثاً، تأكيد على مستوى DB:

```bash
sqlite3 /home/nassaj/.local/share/nassaj-dev/db.sqlite \
  "SELECT id, username, role, status FROM users WHERE role='owner';"
```

رابعاً، سجّل الدخول للحصول على JWT (نستخدمه في بقية الأقسام):

```bash
curl -s -X POST http://localhost:3004/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"owner","password":"<OWNER_PASSWORD>"}'
# المتوقع: {"success":true,"user":{...},"token":"<JWT>"}
```

**English**

First, capture the owner credentials from the log (printed once on first boot against an owner-less DB):

```bash
pm2 logs nassaj-dev --lines 50 --nostream | grep -A4 "BOOTSTRAP OWNER CREATED"
```

Second, verify via the public API that setup is no longer needed (`needsSetup: false` means the owner exists):

```bash
curl -s http://localhost:3004/api/auth/status
# Expected after creation: {"needsSetup":false,"isAuthenticated":false}
```

Third, confirm at the DB level:

```bash
sqlite3 /home/nassaj/.local/share/nassaj-dev/db.sqlite \
  "SELECT id, username, role, status FROM users WHERE role='owner';"
```

Fourth, log in to obtain a JWT (used throughout the rest of this runbook):

```bash
curl -s -X POST http://localhost:3004/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"owner","password":"<OWNER_PASSWORD>"}'
# Expected: {"success":true,"user":{...},"token":"<JWT>"}
```

> ملاحظة: في كل أوامر `curl` التالية استبدل `<JWT>` بالقيمة من حقل `token` أعلاه. / In the `curl` commands below, replace `<JWT>` with the `token` value above.

---

## 3. إدارة المستخدمين / User Management

> الأدوار: `owner` (أعلى) > `admin` > `user`. الدعوات تُنشئ فقط أدوار `admin`/`user`، و `admin` يُدعى من الـ owner فقط.
> Roles: `owner` (highest) > `admin` > `user`. Invites create only `admin`/`user`; an `admin` invite can be minted only by the owner.

### 3.1 إنشاء دعوة / Create an invite

**العربية**

عبر API (owner/admin). `ttlHours` افتراضي `72` ساعة، الحد الأقصى `720` (30 يوماً). الجسم اختياري بالكامل (الافتراضي دور `user`):

```bash
curl -s -X POST http://localhost:3004/api/auth/invites \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","email":"teammate@example.com","ttlHours":72}'
# المتوقع: {"success":true,"invite":{"token":"<INVITE_TOKEN>","expiresAt":"...","role":"user"}}
```

الـ `token` يظهر **مرة واحدة فقط** — لا يُخزَّن نصاً (يُحفظ هاش SHA-256 فقط). سلِّمه للمدعوّ عبر قناة آمنة.

عبر الواجهة: Settings → Users → زر دعوة مستخدم (يبني رابط `/join?token=...` تلقائياً عبر `InviteUserModal`).

قائمة الدعوات (هاشات الـ token لا تُكشف أبداً):

```bash
curl -s http://localhost:3004/api/auth/invites -H "Authorization: Bearer <JWT>"
```

إلغاء دعوة معلَّقة:

```bash
curl -s -X DELETE http://localhost:3004/api/auth/invites/<INVITE_ID> \
  -H "Authorization: Bearer <JWT>"
```

**English**

Via API (owner/admin). `ttlHours` defaults to `72` h, max `720` (30 days). Body is fully optional (defaults to role `user`):

```bash
curl -s -X POST http://localhost:3004/api/auth/invites \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","email":"teammate@example.com","ttlHours":72}'
# Expected: {"success":true,"invite":{"token":"<INVITE_TOKEN>","expiresAt":"...","role":"user"}}
```

The `token` is shown **once** — never stored in plaintext (only a SHA-256 hash). Deliver it over a secure channel.

Via UI: Settings → Users → Invite user button (auto-builds a `/join?token=...` link through `InviteUserModal`).

List invites (token hashes are never exposed):

```bash
curl -s http://localhost:3004/api/auth/invites -H "Authorization: Bearer <JWT>"
```

Revoke a pending invite:

```bash
curl -s -X DELETE http://localhost:3004/api/auth/invites/<INVITE_ID> \
  -H "Authorization: Bearer <JWT>"
```

### 3.2 قبول الدعوة / Accept the invite (/join)

**العربية**

المدعوّ يفتح الرابط (عام، بدون مصادقة): `https://nassaj.alkindy.tech/join?token=<INVITE_TOKEN>` ويختار اسم مستخدم وكلمة مرور.

ما يحدث خلف الكواليس (POST إلى `/api/auth/invite/accept`، محدود المعدل):

```bash
curl -s -X POST http://localhost:3004/api/auth/invite/accept \
  -H "Content-Type: application/json" \
  -d '{"token":"<INVITE_TOKEN>","username":"teammate","password":"<min 8 chars>"}'
# المتوقع: {"success":true,"user":{...},"token":"<JWT>"}
```

القيود: اسم المستخدم ≥ 3 محارف، كلمة المرور ≥ 8 محارف. الدعوة أحادية الاستخدام وتُستهلَك ذرّياً.

**English**

The invitee opens the link (public, no auth): `https://nassaj.alkindy.tech/join?token=<INVITE_TOKEN>` and picks a username and password.

Behind the scenes (POST to `/api/auth/invite/accept`, rate-limited):

```bash
curl -s -X POST http://localhost:3004/api/auth/invite/accept \
  -H "Content-Type: application/json" \
  -d '{"token":"<INVITE_TOKEN>","username":"teammate","password":"<min 8 chars>"}'
# Expected: {"success":true,"user":{...},"token":"<JWT>"}
```

Constraints: username ≥ 3 chars, password ≥ 8 chars. The invite is single-use and consumed atomically.

### 3.3 إعادة تعيين كلمة المرور (admin) / Admin password reset

**العربية**

owner/admin يعيد تعيين كلمة مرور مستخدم آخر إلى مؤقتة تُعاد **مرة واحدة** نصاً. المستخدم الهدف يُلزَم بتغييرها (`must_change_password = 1`) وكل توكناته القديمة تُبطَل:

```bash
curl -s -X POST http://localhost:3004/api/auth/users/<USER_ID>/reset-password \
  -H "Authorization: Bearer <JWT>"
# المتوقع: {"tempPassword":"<16-char temp>"}
```

ملاحظات:
- لا يمكن إعادة تعيين كلمة مرورك بهذا المسار — استخدم `/me/password`.
- فقط `owner` يعيد تعيين كلمة مرور `owner` آخر.

تغيير كلمة مرورك (لأي مستخدم مصادق):

```bash
curl -s -X PATCH http://localhost:3004/api/auth/me/password \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"<old>","newPassword":"<new min 8>"}'
# المتوقع: {"success":true,"token":"<new JWT>"}
```

تغيير دور مستخدم (owner فقط) أو تعطيل/تفعيله:

```bash
curl -s -X PATCH http://localhost:3004/api/auth/users/<USER_ID>/role \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"role":"admin"}'

curl -s -X PATCH http://localhost:3004/api/auth/users/<USER_ID>/status \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"status":"disabled"}'   # أو "active"
```

ضمانات: لا يمكنك تغيير دورك/حالتك بنفسك، ولا تعطيل/خفض آخر `owner`.

**English**

An owner/admin resets another user's password to a temporary one returned **once** in plaintext. The target is forced to change it (`must_change_password = 1`) and all their old tokens are invalidated:

```bash
curl -s -X POST http://localhost:3004/api/auth/users/<USER_ID>/reset-password \
  -H "Authorization: Bearer <JWT>"
# Expected: {"tempPassword":"<16-char temp>"}
```

Notes:
- You cannot reset your own password via this route — use `/me/password`.
- Only an `owner` may reset another `owner`'s password.

Change your own password (any authenticated user):

```bash
curl -s -X PATCH http://localhost:3004/api/auth/me/password \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"<old>","newPassword":"<new min 8>"}'
# Expected: {"success":true,"token":"<new JWT>"}
```

Change a user's role (owner only) or disable/enable them:

```bash
curl -s -X PATCH http://localhost:3004/api/auth/users/<USER_ID>/role \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"role":"admin"}'

curl -s -X PATCH http://localhost:3004/api/auth/users/<USER_ID>/status \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"status":"disabled"}'   # or "active"
```

Guards: you cannot change your own role/status, and the last `owner` cannot be demoted/disabled.

### 3.4 رفع الصورة الشخصية / Upload an avatar

**العربية**

multipart/form-data بحقل `avatar`. الأنواع المسموحة: jpeg/png/webp/gif، الحجم الأقصى 2 ميجابايت. تُكتب إلى `~/.nassaj-users/<userId>/avatar.<ext>` وتُعرض على `/avatars/<userId>.<ext>`:

```bash
curl -s -X PATCH http://localhost:3004/api/auth/me/avatar \
  -H "Authorization: Bearer <JWT>" \
  -F "avatar=@/path/to/photo.png"
# المتوقع: {"success":true,"avatarUrl":"/avatars/<userId>.png"}
```

اسم الملف يُشتق من `userId` الموثوق (من الـ JWT) لا من مدخل العميل — لا خطر path traversal.

**English**

multipart/form-data with an `avatar` field. Allowed types: jpeg/png/webp/gif, max 2 MB. Written to `~/.nassaj-users/<userId>/avatar.<ext>` and served at `/avatars/<userId>.<ext>`:

```bash
curl -s -X PATCH http://localhost:3004/api/auth/me/avatar \
  -H "Authorization: Bearer <JWT>" \
  -F "avatar=@/path/to/photo.png"
# Expected: {"success":true,"avatarUrl":"/avatars/<userId>.png"}
```

The filename is derived from the trusted (JWT) `userId`, never from client input — no path-traversal risk.

---

## 4. عزل الاعتمادات / Credential Isolation

### 4.1 isolated مقابل shared / isolated vs shared

**العربية**

`resolveProviderEnv(userId, provider)` هو المصدر الوحيد لعزل الاعتمادات (ADR-014). لكل provider وضعان:

- **isolated**: لكل مستخدم اعتمادات خاصة. تُضبط متغيرة بيئة per-user عند الاستدعاء.
- **shared**: كل المستخدمين يشاركون اعتمادات المُشغِّل (operator). البيئة الأساسية تُعاد دون تغيير.

عندما يكون `userId` فارغاً/null (نظام/مجهول/وضع منصة) لا يُطبَّق أي عزل — حفاظاً على سلوك المستخدم الواحد القديم.

المحادثات والتعليمات تبقى **مشتركة دائماً** عبر symlinks (راجع 4.3) — عزل الاعتمادات لا يفرّع تاريخ المحادثات.

**English**

`resolveProviderEnv(userId, provider)` is the sole credential-isolation seam (ADR-014). Each provider has two modes:

- **isolated**: each user gets private credentials. A per-user env var is set on spawn.
- **shared**: all users share the operator's credentials. The base env is returned unchanged.

When `userId` is empty/null (system/anonymous/platform mode) no isolation is applied — preserving the prior single-user behavior.

Conversations and instructions stay **always shared** via symlinks (see 4.3) — isolating credentials never forks chat history.

### 4.2 مسارات الملفات لكل provider / Per-provider file paths

**العربية**

عند الوضع isolated، الجذر لكل مستخدم: `~/.nassaj-users/<userId>/`. المتغيرات المضبوطة:

| Provider | المتغيّر المضبوط | المسار (isolated) |
|---|---|---|
| `claude` | `CLAUDE_CONFIG_DIR` | `~/.nassaj-users/<userId>/.claude` |
| `gemini` | `GEMINI_CLI_HOME` | `~/.nassaj-users/<userId>/` (الـ CLI يحلّ `~/.gemini` نسبةً إليه) |
| `codex` | `CODEX_HOME` | `~/.nassaj-users/<userId>/.codex` |
| `agy` | `HOME` | `~/.nassaj-users/<userId>/` (لا يملك knob مخصّص؛ يحلّ brain تحت `~/.gemini/antigravity-cli` نسبة لـ HOME) |
| `cursor` | لا يوجد knob بعد | shared دائماً حتى يُضاف |

**English**

In isolated mode, the per-user root is `~/.nassaj-users/<userId>/`. Variables set:

| Provider | Env var set | Path (isolated) |
|---|---|---|
| `claude` | `CLAUDE_CONFIG_DIR` | `~/.nassaj-users/<userId>/.claude` |
| `gemini` | `GEMINI_CLI_HOME` | `~/.nassaj-users/<userId>/` (CLI resolves `~/.gemini` relative to it) |
| `codex` | `CODEX_HOME` | `~/.nassaj-users/<userId>/.codex` |
| `agy` | `HOME` | `~/.nassaj-users/<userId>/` (no dedicated knob; resolves its brain under `~/.gemini/antigravity-cli` relative to HOME) |
| `cursor` | none yet | always shared until added |

### 4.3 الـ symlinks المشتركة / Shared symlinks

**العربية**

`provisionUserDirs(userId)` تُنشئ شجرة كل مستخدم (mode `0750`) idempotently عند كل spawn. التخطيط:

```
~/.nassaj-users/<userId>/
  .claude/                              (اعتمادات معزولة)
    projects   -> ~/.claude/projects    (محادثات مشتركة)
    CLAUDE.md  -> ~/.claude/CLAUDE.md    (تعليمات مشتركة، إن وُجد)
    NASSAJ.md  -> ~/.claude/NASSAJ.md    (تعليمات مشتركة، إن وُجد)
  .gemini/
    projects   -> ~/.gemini/projects     (مشترك، إن وُجد)
  .codex/                                (معزول؛ لا subtree مشترك بعد)
```

أول إنشاء لجذر مستخدم يُسجَّل مرة واحدة في `audit_log` كـ `user_dirs_provisioned`.

**English**

`provisionUserDirs(userId)` creates each user's tree (mode `0750`) idempotently on every spawn. Layout:

```
~/.nassaj-users/<userId>/
  .claude/                              (isolated credentials)
    projects   -> ~/.claude/projects    (shared conversations)
    CLAUDE.md  -> ~/.claude/CLAUDE.md    (shared instructions, if present)
    NASSAJ.md  -> ~/.claude/NASSAJ.md    (shared instructions, if present)
  .gemini/
    projects   -> ~/.gemini/projects     (shared, if present)
  .codex/                                (isolated; no shared subtree yet)
```

The first creation of a user root is recorded once in `audit_log` as `user_dirs_provisioned`.

---

## 5. إعدادات مشاركة الـ Providers (Admin) / Provider Sharing Config

### 5.1 السياسة الافتراضية / Default policy

**العربية**

الافتراضي يطابق السلوك قبل الميزة تماماً (ADR-016) — install بلا config مخزَّن يتصرف كما كان:

| Provider | الوضع الافتراضي |
|---|---|
| `claude` | `isolated` |
| `gemini` | `isolated` |
| `codex` | `isolated` |
| `agy` | `shared` |
| `cursor` | `shared` |

الـ providers المعروفة: `claude`, `gemini`, `codex`, `agy`, `cursor`. الأوضاع المسموحة: `shared`, `isolated`. أي مفتاح أو وضع آخر يُرفض.

**English**

The default mirrors pre-feature behavior exactly (ADR-016) — an install with no stored config behaves as before:

| Provider | Default mode |
|---|---|
| `claude` | `isolated` |
| `gemini` | `isolated` |
| `codex` | `isolated` |
| `agy` | `shared` |
| `cursor` | `shared` |

Known providers: `claude`, `gemini`, `codex`, `agy`, `cursor`. Allowed modes: `shared`, `isolated`. Any other key or mode is rejected.

### 5.2 الوصول للواجهة / UI access

**العربية**

Settings → Users → قسم Provider Sharing (`ProviderSharingSettings`). متاح للأدوار owner/admin فقط.

**English**

Settings → Users → Provider Sharing section (`ProviderSharingSettings`). Visible to owner/admin roles only.

### 5.3 الـ API وأمثلة curl / API and curl examples

**العربية**

قراءة السياسة الحالية:

```bash
curl -s http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>"
# المتوقع: {"config":{"claude":"isolated","gemini":"isolated","codex":"isolated","agy":"shared","cursor":"shared"}}
```

تحديث السياسة (patch جزئي مسموح — الـ providers غير المذكورة تحتفظ بوضعها):

```bash
curl -s -X PUT http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"agy":"isolated"}'
# المتوقع: السياسة الكاملة المخزَّنة بعد الدمج
```

مثال رفض (provider غير معروف):

```bash
curl -s -X PUT http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"foo":"shared"}'
# المتوقع: 400 {"error":"Unknown provider: foo"}
```

**English**

Read the current policy:

```bash
curl -s http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>"
# Expected: {"config":{"claude":"isolated","gemini":"isolated","codex":"isolated","agy":"shared","cursor":"shared"}}
```

Update the policy (partial patch allowed — unspecified providers keep their mode):

```bash
curl -s -X PUT http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"agy":"isolated"}'
# Expected: the full stored policy after merge
```

Rejection example (unknown provider):

```bash
curl -s -X PUT http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"foo":"shared"}'
# Expected: 400 {"error":"Unknown provider: foo"}
```

### 5.4 تحذير agy (عزل تجريبي عبر HOME) / agy warning (experimental HOME isolation)

**العربية**

`agy` لا يملك متغيّر بيئة مخصّصاً للعزل. عند ضبطه `isolated` يُعزَل عبر تجاوز `HOME` إلى جذر المستخدم، فيحلّ مخزن الـ brain تحت `~/.gemini/antigravity-cli` داخل شجرة المستخدم المعزولة. هذا **تجريبي**: تجاوز `HOME` قد يؤثر على أي شيء آخر يعتمد عليه `agy` من مجلد المنزل. ابقِ `agy` على `shared` ما لم تختبر العزل فعلياً في جلسات حقيقية.

**English**

`agy` has no dedicated isolation env var. When set to `isolated` it is isolated by overriding `HOME` to the user root, so its brain store under `~/.gemini/antigravity-cli` resolves inside the isolated tree. This is **experimental**: overriding `HOME` may affect anything else `agy` keys off the home directory. Keep `agy` on `shared` unless you have actually tested isolation in real sessions.

### 5.5 التأثير الفوري (لا حاجة لإعادة تشغيل) / Immediate effect (no restart needed)

**العربية**

السياسة محفوظة في `app_config` تحت المفتاح `provider_sharing` ومخزَّنة مؤقتاً في الذاكرة (in-process cache). كل كتابة عبر الـ API تُحدّث الـ cache متزامِنةً، فالتغيير يسري على أول spawn تالٍ في نفس العملية **بدون إعادة تشغيل**. (هذا التثبيت يشغّل عملية خادم واحدة.)

**English**

The policy is stored in `app_config` under key `provider_sharing` and cached in-process. Every API write refreshes the cache synchronously, so the change takes effect on the very next spawn in the same process **with no restart**. (This install runs a single server process.)

---

## 6. استكشاف الأخطاء / Troubleshooting

### 6.1 EADDRINUSE (المنفذ مشغول) / EADDRINUSE (port in use)

**العربية**

غالباً بسبب متغيّر `PORT` عالق في بيئة pm2 المحفوظة يتعارض مع `--port 3004`. أعد التشغيل مع تجريد `PORT`:

```bash
env -u PORT pm2 restart nassaj-dev --update-env
pm2 logs nassaj-dev --lines 20 --nostream
```

تحقّق أيضاً من شاغل المنفذ: `pm2 list` ثم `ss -ltnp | grep 3004`.

**English**

Usually a stale `PORT` in the saved pm2 env conflicting with `--port 3004`. Restart with `PORT` stripped:

```bash
env -u PORT pm2 restart nassaj-dev --update-env
pm2 logs nassaj-dev --lines 20 --nostream
```

Also check the port holder: `pm2 list` then `ss -ltnp | grep 3004`.

### 6.2 مستخدم يرى اعتمادات زميله / A user sees a teammate's credentials

**العربية**

السبب الأرجح: الـ provider مضبوط `shared` بينما يُتوقَّع `isolated`. تحقّق من السياسة:

```bash
curl -s http://localhost:3004/api/admin/provider-sharing -H "Authorization: Bearer <JWT>"
```

اضبطه `isolated` (مثال claude):

```bash
curl -s -X PUT http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"claude":"isolated"}'
```

تذكّر: المحادثات والتعليمات مشتركة بالتصميم (symlinks) — رؤية المحادثات المشتركة ليست تسريب اعتمادات.

**English**

Most likely the provider is set `shared` while `isolated` is expected. Check the policy:

```bash
curl -s http://localhost:3004/api/admin/provider-sharing -H "Authorization: Bearer <JWT>"
```

Set it `isolated` (claude example):

```bash
curl -s -X PUT http://localhost:3004/api/admin/provider-sharing \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"claude":"isolated"}'
```

Remember: conversations and instructions are shared by design (symlinks) — seeing shared chats is not a credential leak.

### 6.3 login 401 / login returns 401

**العربية**

- تحقّق من بيانات الاعتماد أولاً (`Invalid username or password` رسالة عامة لمنع enumeration).
- إذا كانت كل عمليات الدخول تفشل بعد تغيير الإعداد، تحقّق من اتساق `JWT_SECRET` في `ecosystem.config.cjs`: تغييره يُبطل كل التوكنات الصادرة سابقاً. أعد التشغيل مع تحديث env بعد أي تعديل:

```bash
pm2 restart nassaj-dev --update-env
```

- بعد 10 محاولات فاشلة خلال 15 دقيقة من نفس IP يُفعَّل rate limiting (`Too many attempts...`) — انتظر النافذة.

**English**

- Verify credentials first (`Invalid username or password` is a generic message to prevent enumeration).
- If all logins fail after a config change, check `JWT_SECRET` consistency in `ecosystem.config.cjs`: changing it invalidates every previously issued token. Restart with refreshed env after any edit:

```bash
pm2 restart nassaj-dev --update-env
```

- After 10 failed attempts in 15 min from one IP, rate limiting kicks in (`Too many attempts...`) — wait out the window.

### 6.4 مجلد brain مفقود بعد عزل agy / Missing brain directory after agy isolation

**العربية**

بعد تبديل `agy` إلى `isolated`، أول جلسة لمستخدم تبدأ من `HOME` معزول جديد بلا brain سابق (يُنشأ من الصفر). إذا بدت الجلسة بلا سياق، أعد تشغيل الجلسة لإتاحة إنشاء الشجرة المعزولة. تحقّق من وجودها:

```bash
ls -la ~/.nassaj-users/<userId>/.gemini/antigravity-cli/ 2>/dev/null
```

إن كان السلوك غير مقبول، أعِد `agy` إلى `shared` (راجع 5.4 — العزل تجريبي).

**English**

After switching `agy` to `isolated`, a user's first session starts from a fresh isolated `HOME` with no prior brain (created from scratch). If the session seems context-less, restart the session so the isolated tree gets provisioned. Verify it exists:

```bash
ls -la ~/.nassaj-users/<userId>/.gemini/antigravity-cli/ 2>/dev/null
```

If the behavior is unacceptable, revert `agy` to `shared` (see 5.4 — isolation is experimental).

---

## 7. أوامر صيانة / Maintenance Commands

**العربية**

pm2:

```bash
pm2 logs nassaj-dev                    # سجلات حية
pm2 logs nassaj-dev --lines 100 --nostream   # آخر 100 سطر دفعة واحدة
pm2 restart nassaj-dev --update-env    # إعادة تشغيل مع تحديث env من ecosystem
pm2 stop nassaj-dev
pm2 describe nassaj-dev                 # حالة + مسارات السجلات
```

مسارات السجلات: `/home/nassaj/.pm2/logs/nassaj-dev-out.log` و `nassaj-dev-error.log`.

استعلامات sqlite3 مفيدة (DB: `/home/nassaj/.local/share/nassaj-dev/db.sqlite`):

```bash
DB=/home/nassaj/.local/share/nassaj-dev/db.sqlite

# المستخدمون
sqlite3 "$DB" "SELECT id, username, role, status, last_login FROM users ORDER BY id;"

# الدعوات المعلَّقة
sqlite3 "$DB" "SELECT id, role, status, expires_at FROM invites WHERE status='pending';"

# آخر 20 حدثاً في سجل التدقيق
sqlite3 "$DB" "SELECT created_at, user_id, action FROM audit_log ORDER BY id DESC LIMIT 20;"

# عدّ محاولات الدخول الفاشلة
sqlite3 "$DB" "SELECT COUNT(*) FROM audit_log WHERE action='login_failure';"

# سياسة مشاركة الـ providers المخزَّنة
sqlite3 "$DB" "SELECT value FROM app_config WHERE key='provider_sharing';"
```

**English**

pm2:

```bash
pm2 logs nassaj-dev                    # live logs
pm2 logs nassaj-dev --lines 100 --nostream   # last 100 lines at once
pm2 restart nassaj-dev --update-env    # restart, refreshing env from ecosystem
pm2 stop nassaj-dev
pm2 describe nassaj-dev                 # status + log paths
```

Log paths: `/home/nassaj/.pm2/logs/nassaj-dev-out.log` and `nassaj-dev-error.log`.

Useful sqlite3 queries (DB: `/home/nassaj/.local/share/nassaj-dev/db.sqlite`):

```bash
DB=/home/nassaj/.local/share/nassaj-dev/db.sqlite

# Users
sqlite3 "$DB" "SELECT id, username, role, status, last_login FROM users ORDER BY id;"

# Pending invites
sqlite3 "$DB" "SELECT id, role, status, expires_at FROM invites WHERE status='pending';"

# Last 20 audit events
sqlite3 "$DB" "SELECT created_at, user_id, action FROM audit_log ORDER BY id DESC LIMIT 20;"

# Count failed logins
sqlite3 "$DB" "SELECT COUNT(*) FROM audit_log WHERE action='login_failure';"

# Stored provider-sharing policy
sqlite3 "$DB" "SELECT value FROM app_config WHERE key='provider_sharing';"
```

> أغلق الخدمة قبل أي كتابة مباشرة على DB لتجنّب التعارض. اقرأ بحرّية أثناء التشغيل.
> Stop the service before any direct DB write to avoid contention. Reads while running are fine.

---

## 8. شروط الترقية لنسخة الإنتاج / Production Promotion Criteria

**العربية**

لا تُرقّى Phase-MU إلى الإنتاج إلا بعد استيفاء كل ما يلي:

- [ ] ‏≥ 10 جلسات حقيقية بمستخدمَين اثنين على الأقل دون أعطال.
- [ ] لا regression في `agy` / `claude` / `gemini` (تشغيل وجلسات سليمة).
- [ ] اختبارات E2E للعزل تمرّ (isolation tests).
- [ ] `JWT_SECRET` مضبوط صراحةً عبر env (لا per-install مولَّد) و `BOOTSTRAP_OWNER_PASSWORD` قوي ومُدار.
- [ ] راجَعَ owner سياسة `provider-sharing` واعتمدها (خاصة قرار `agy` التجريبي).
- [ ] نسخة احتياطية موثَّقة لـ DB ولـ `~/.nassaj-users/`، وخطة استرجاع مُختبَرة.

**English**

Do not promote Phase-MU to production until all of the following hold:

- [ ] ≥ 10 real sessions with at least two distinct users, no faults.
- [ ] No regression in `agy` / `claude` / `gemini` (clean spawns and sessions).
- [ ] E2E isolation tests pass.
- [ ] `JWT_SECRET` set explicitly via env (not the generated per-install one), and `BOOTSTRAP_OWNER_PASSWORD` strong and managed.
- [ ] Owner has reviewed and approved the `provider-sharing` policy (especially the experimental `agy` decision).
- [ ] Documented backup of the DB and `~/.nassaj-users/`, with a tested restore plan.

---

## 9. الصلاحيات وعزل الملفات / Permissions & File Isolation

**العربية**

> تنبيه أمني: العزل هنا **نسبة فوترة لا حدّ أمني** (ADR-023، Decision 2). كل المستخدمين على **uid نظامي واحد**، فأي مستخدم بصلاحية shell محلية يستطيع قراءة ملفات غيره تحت نفس الـ uid. صلاحيات الملفات أدناه تمنع الوصول من **خارج** الـ uid (مستخدمو النظام الآخرون) وتُحصِّن النموذج، لا تفصل المستخدمين بعضهم عن بعض داخل الـ uid.

### 9.1 الصلاحيات المتوقَّعة / Expected modes

| المسار | الوضع المتوقَّع | مصدره في الكود |
|---|---|---|
| `~/.nassaj-users/<userId>/` (جذر المستخدم وكل مجلداته الفرعية) | `0700` | `provision-user-dirs.js` → `DIR_MODE = 0o700` |
| ملفات اعتماد Claude المعزولة `~/.nassaj-users/<userId>/.claude/.credentials.json` | `0600` | يكتبها `claude` CLI نفسه عند `setup-token`؛ وعند تجديد التوكن `claude-usage.service.ts` → `mode: 0o600` |
| `db.sqlite` (+ `db.sqlite-wal` / `db.sqlite-shm`) | `0600` | يُنشئها better-sqlite3؛ تحقَّق منها وأعِد ضبطها يدوياً إن لزم |

> ملاحظة دقّة: جذور المستخدمين تُنشأ بـ `0700` برمجياً (`DIR_MODE = 0o700` في `provision-user-dirs.js`) — تمنع وصول group/other نهائياً. لاحظ أنّ هذا تحصينٌ للنموذج لا حدّ بين المستخدمين: جميعهم تحت uid واحد فالفصل المنطقي بينهم ليس حدّاً أمنياً (ADR-023). لا حاجة لتضييق يدوي؛ أوامر 9.3 تُستخدم فقط لإعادة الضبط إن اتّسعت الصلاحية بعد عملية يدوية.

### 9.2 أوامر التحقق / Verification commands

```bash
NU=~/.nassaj-users
DB=/home/nassaj/.local/share/nassaj-dev/db.sqlite

# جذور المستخدمين وأوضاعها (المتوقَّع 700)
ls -la "$NU"
stat -c '%a %n' "$NU"/*

# اعتماد Claude المعزول لكل مستخدم (المتوقَّع 600 على .credentials.json)
find "$NU" -name '.credentials.json' -exec stat -c '%a %n' {} \;

# ملفات DB (المتوقَّع 600 على الثلاثة)
stat -c '%a %n' "$DB" "$DB"-wal "$DB"-shm 2>/dev/null
```

المتوقَّع: `700` لكل جذر مستخدم، `600` لكل `.credentials.json`، و`600` لملفات DB الثلاثة.

### 9.3 إعادة الضبط يدوياً / Manual re-tightening

عند العثور على صلاحية أوسع من المتوقَّع (مثلاً `755` أو `644` بعد عملية يدوية أو نسخ احتياطي خاطئ):

```bash
NU=~/.nassaj-users
DB=/home/nassaj/.local/share/nassaj-dev/db.sqlite

# جذور ومجلدات المستخدمين → 700 (القيمة البرمجية المضبوطة)
chmod 700 "$NU"/*                 # الجذور فقط
find "$NU" -type d -exec chmod 700 {} \;   # كل المجلدات تحتها

# ملفات الاعتماد → 600
find "$NU" -name '.credentials.json' -exec chmod 600 {} \;
find "$NU" -name '*.json' -path '*/.claude/*' -exec chmod 600 {} \;

# ملفات DB → 600 (أوقف الخدمة أولاً لتفادي التعارض على WAL)
chmod 600 "$DB" "$DB"-wal "$DB"-shm 2>/dev/null
```

> أوقف الخدمة قبل لمس ملفات DB (راجع القسم 7). الكتابة على WAL/SHM أثناء التشغيل تُفسد الاتساق.

**English**

> Security caveat: isolation here is a **billing boundary, not a security boundary** (ADR-023, Decision 2). All users run under a **single system uid**, so any user with local shell access can read another's files under that uid. The modes below keep files unreadable from **outside** the uid (other OS users) and harden the model — they do not separate users from one another within the shared uid.

### 9.1 Expected modes

| Path | Expected mode | Code origin |
|---|---|---|
| `~/.nassaj-users/<userId>/` (user root and all subdirs) | `0700` | `provision-user-dirs.js` → `DIR_MODE = 0o700` |
| Isolated Claude credentials `~/.nassaj-users/<userId>/.claude/.credentials.json` | `0600` | Written by the `claude` CLI itself on `setup-token`; on refresh `claude-usage.service.ts` → `mode: 0o600` |
| `db.sqlite` (+ `db.sqlite-wal` / `db.sqlite-shm`) | `0600` | Created by better-sqlite3; verify and re-tighten manually if needed |

> Precision note: user roots are created `0700` programmatically (`DIR_MODE = 0o700` in `provision-user-dirs.js`) — no group/other access at all. Note this hardens the model rather than separating users: all run under one uid, so the per-user split is not a security boundary (ADR-023). No manual tightening is needed; the 9.3 commands are only for re-tightening if a mode widens after a manual op.

### 9.2 Verification commands

```bash
NU=~/.nassaj-users
DB=/home/nassaj/.local/share/nassaj-dev/db.sqlite

# User roots and their modes (expect 700)
ls -la "$NU"
stat -c '%a %n' "$NU"/*

# Per-user isolated Claude credential (expect 600 on .credentials.json)
find "$NU" -name '.credentials.json' -exec stat -c '%a %n' {} \;

# DB files (expect 600 on all three)
stat -c '%a %n' "$DB" "$DB"-wal "$DB"-shm 2>/dev/null
```

Expected: `700` per user root, `600` per `.credentials.json`, and `600` on the three DB files.

### 9.3 Manual re-tightening

If a mode is looser than expected (e.g. `755` or `644` after a manual op or a bad backup restore):

```bash
NU=~/.nassaj-users
DB=/home/nassaj/.local/share/nassaj-dev/db.sqlite

# User roots and dirs → 700 (the programmatically-set value)
chmod 700 "$NU"/*                 # roots only
find "$NU" -type d -exec chmod 700 {} \;   # every dir beneath

# Credential files → 600
find "$NU" -name '.credentials.json' -exec chmod 600 {} \;
find "$NU" -name '*.json' -path '*/.claude/*' -exec chmod 600 {} \;

# DB files → 600 (stop the service first to avoid WAL contention)
chmod 600 "$DB" "$DB"-wal "$DB"-shm 2>/dev/null
```

> Stop the service before touching DB files (see section 7). Writing to WAL/SHM while running corrupts consistency.

---

## 10. تسجيل اشتراك Claude لكل مستخدم (Onboarding) / Per-User Claude Subscription Onboarding

**العربية**

> المُحفِّز: بعد قلب `provider_sharing.claude` من `shared` إلى `isolated`. متعلّق بـ ADR-023 (Decision 4 — PTY مُصلَّح، م1).

### 10.1 لماذا يلزم تسجيل جديد بعد قلب العزل / Why a fresh login is required after flipping isolation

عند `isolated`، اعتماد كل مستخدم يُقرأ من دليله المعزول `~/.nassaj-users/<userId>/.claude/`. عند أول تفعيل هذا الدليل **فارغ من الاعتماد** لكل غير-المالك (الكود لا يربط `.credentials.json` إلا للمالك — `provision-user-dirs.js:155`). النتيجة:

- **كل مستخدم غير-مالك يجب أن يسجّل اشتراكه بنفسه** عبر الطرفية، وإلا تتعطّل جلسته بخطأ «Claude CLI is not authenticated» حتى يسجّل.
- **المالك استثناء بالتصميم:** دليله المعزول يربط رمزياً (symlink) اعتماد المُشغِّل `~/.claude/.credentials.json`، فلا يحتاج إعادة تسجيل ما دام اعتماد المُشغِّل صالحاً. (إن أُبطل اعتماد المُشغِّل أو انتهى، يسجّل المالك أيضاً بنفس الخطوات أدناه.)

> فرق عن المسوّدة الأولى: ليس مطلوباً من **المالك** إعادة التسجيل تلقائياً — فقط غير-المالكين. تحقَّق من حالة المالك بعد القلب (10.4) قبل افتراض الحاجة.

### 10.2 خطوات التسجيل عبر الطرفية / Terminal login steps

1. يسجّل المستخدم دخوله إلى الواجهة بهويّته (`https://nassaj.alkindy.tech`).
2. يفتح الطرفية المدمجة (Shell / Terminal). جلسة الـ PTY تحقن بيئته المعزولة تلقائياً (`B-MU-PTY-ENV`) فيكتب الاعتماد في **دليله** هو لا دليل غيره.
3. يشغّل أمر تسجيل اشتراك Claude:

```bash
claude setup-token
```

4. يُكمل تدفّق OAuth: ينسخ الرابط الظاهر، يفتحه في متصفّحه، يوافق على الوصول، ويلصق رمز التحقق في الطرفية.
5. عند النجاح يُكتب الاعتماد إلى `~/.nassaj-users/<userId>/.claude/.credentials.json` (يكتبه `claude` CLI نفسه بصلاحية `0600`).

> الواجهة ترصد أمر `setup-token` كأمر تسجيل دخول وتعيد تشغيل جلسة PTY له (`shell-websocket.service.ts:241`)، ومفتاح الجلسة مُسمَّى باسم المستخدم (`B-MU-PTY-KEY`) فلا يلتقط مستخدم جلسة غيره.

### 10.3 ترتيب التفعيل الموصى به / Recommended activation order

1. أبلغ كل المستخدمين أن العزل سيُفعَّل وأن عليهم تسجيل اشتراكهم بعده.
2. اقلب `provider_sharing.claude` إلى `isolated` (القسم 5.3 — بلا restart).
3. كل مستخدم (غير-مالك) ينفّذ خطوات 10.2 قبل جلسته التالية.
4. تحقَّق (10.4) أن كل مستخدم نشط أصبح موثَّقاً.

### 10.4 التحقق من حالة الاعتماد / Verifying credential status

```bash
NU=~/.nassaj-users
# هل كتب المستخدم اعتماده؟ (وجود الملف + صلاحية 600)
find "$NU" -name '.credentials.json' -exec stat -c '%a %n' {} \;
```

عبر الواجهة: كل مستخدم يرى حالة موفّر Claude في إعداداته (موثَّق / غير موثَّق). إن ظهر «غير موثَّق» لمستخدم نشط بعد القلب، يكرّر 10.2.

**English**

> Trigger: after flipping `provider_sharing.claude` from `shared` to `isolated`. Tied to ADR-023 (Decision 4 — fixed PTY, item m1).

### 10.1 Why a fresh login is required after flipping isolation

Under `isolated`, each user's credential is read from their isolated dir `~/.nassaj-users/<userId>/.claude/`. On first activation that dir is **empty of credentials** for every non-owner (the code only links `.credentials.json` for the owner — `provision-user-dirs.js:155`). Consequently:

- **Every non-owner user must register their own subscription** via the terminal, otherwise their session fails with "Claude CLI is not authenticated" until they do.
- **The owner is an exception by design:** their isolated dir symlinks the operator credential `~/.claude/.credentials.json`, so no re-login is needed as long as the operator credential is valid. (If the operator credential is revoked or expired, the owner logs in via the same steps below.)

> Correction vs. the first draft: the **owner** is not automatically required to re-register — only non-owners are. Verify owner status after the flip (10.4) before assuming a re-login is needed.

### 10.2 Terminal login steps

1. The user logs into the UI under their own identity (`https://nassaj.alkindy.tech`).
2. They open the built-in terminal (Shell / Terminal). The PTY session injects their isolated env automatically (`B-MU-PTY-ENV`), so the credential is written to **their** dir, not anyone else's.
3. They run the Claude subscription login command:

```bash
claude setup-token
```

4. They complete the OAuth flow: copy the printed URL, open it in their browser, approve access, paste the verification code back into the terminal.
5. On success the credential is written to `~/.nassaj-users/<userId>/.claude/.credentials.json` (written by the `claude` CLI itself at mode `0600`).

> The UI detects `setup-token` as a login command and restarts a fresh PTY for it (`shell-websocket.service.ts:241`); the session key is namespaced per user (`B-MU-PTY-KEY`) so no user can pick up another's session.

### 10.3 Recommended activation order

1. Notify all users that isolation will be enabled and they must register their subscription afterward.
2. Flip `provider_sharing.claude` to `isolated` (section 5.3 — no restart).
3. Each (non-owner) user runs the 10.2 steps before their next session.
4. Verify (10.4) that every active user is now authenticated.

### 10.4 Verifying credential status

```bash
NU=~/.nassaj-users
# Did the user write their credential? (file present + mode 600)
find "$NU" -name '.credentials.json' -exec stat -c '%a %n' {} \;
```

Via UI: each user sees their Claude provider status in their settings (authenticated / not authenticated). If an active user shows "not authenticated" after the flip, they repeat 10.2.

---

## 11. الذاكرة وحماية OOM تحت حمل متعدّد المستخدمين / Memory & OOM under Multi-User Load

**العربية**

> تبعية موثّقة من ADR-023 (Consequences) وحادثة `nassaj-server-docs.md` (2026-06-06).

### 11.1 لماذا يرتفع RSS مع تعدّد المستخدمين / Why RSS climbs with more users

كل استدعاء chat/SDK يُشغّل عملية `claude` CLI **فرعية حقيقية** بـ env معزول لكل مستخدم (ADR-023، Context). تحت حمل متعدّد المستخدمين:

- جلسات متزامنة لمستخدمين مختلفين = **عمليات claude فرعية متعدّدة متوازية**، كل منها يضيف RSS مستقلاً.
- مجموع RSS قد يتجاوز سقف `max_memory_restart` المضبوط لعملية `nassaj-dev`، فيعيد pm2 تشغيلها (ويقطع الجلسات الحيّة).
- خطر أوسع: نوبة OOM على مستوى النظام إن تجاوز المجموع الذاكرة المتاحة — كما في حادثة 2026-06-06 (crash-loop لخدمة أخرى + ضغط `nassaj-dev` على المنفذ 3004 رفعا الذاكرة حتى reboot يدوي).

> **حارس restart:** `pm2 restart` وأوامر الإنتاج الحسّاسة يعترضها عميل Claude Code. عند الحاجة لإعادة تشغيل، اطلب من المستخدم تنفيذها في طرفيته (راجع `feedback_pm2_restart_guard` / `CLAUDE.md`). كذلك: إعادة تشغيل `nassaj-dev` تقتل أي جلسة Claude ابنة لها — شغّل جلسة العمل على instance آخر.

### 11.2 أوامر المراقبة / Monitoring commands

```bash
# RSS لكل عمليات pm2 (بما فيها nassaj-dev) + السقف والـ restarts
pm2 list

# تفاصيل nassaj-dev: RSS الحالي، max_memory_restart، عدّاد إعادة التشغيل
pm2 describe nassaj-dev | grep -Ei 'memory|restart|status'

# عمليات claude الفرعية الحيّة وRSS كل منها (KB)
ps -eo pid,ppid,rss,comm | grep -i claude

# مجموع RSS لكل عمليات claude الفرعية (ميجابايت)
ps -eo rss,comm | grep -i claude | awk '{s+=$1} END {print s/1024 " MB"}'

# ذاكرة النظام الكلية والمتاحة
free -m
```

### 11.3 ماذا تراقب وما الحدّ / What to watch and the threshold

- **سقف العملية:** قيمة `max_memory_restart` لـ `nassaj-dev` مضبوطة في `ecosystem.config.cjs` (**لا تُلمس هنا** — راجع حادثة 2026-06-06: عُدِّلت إلى `512M` لـ nassaj-dev لكنها **لم تُطبَّق على runtime الحيّ** حتى `pm2 restart` + `pm2 save`). تحقَّق من القيمة الفعّالة الحيّة بـ `pm2 describe`، لا من الملف.
- **القاعدة التشغيلية:** لا تطلق موجات جلسات متزامنة ثقيلة إذا كان مجموع RSS يقترب من سقف العملية أو إذا تجاوز استهلاك النظام الكلي ~80% (يطابق قاعدة موارد `CLAUDE.md`). خفِّف عدد الجلسات المتزامنة بدل المخاطرة بـ OOM.
- **إشارة إنذار مبكّر:** ارتفاع عدّاد `restart` لـ `nassaj-dev` في `pm2 list` بلا سبب نشر = العملية تضرب سقف الذاكرة وتُعاد دورياً تحت الحمل.

**English**

> Documented dependency from ADR-023 (Consequences) and the `nassaj-server-docs.md` incident (2026-06-06).

### 11.1 Why RSS climbs with more users

Every chat/SDK call spawns a **real child `claude` CLI process** with per-user isolated env (ADR-023, Context). Under multi-user load:

- Concurrent sessions for different users = **multiple parallel child claude processes**, each adding independent RSS.
- Total RSS can exceed the configured `max_memory_restart` for the `nassaj-dev` process, making pm2 restart it (and cut live sessions).
- Wider risk: a system-level OOM event if the total exceeds available memory — as in the 2026-06-06 incident (another service's crash-loop plus `nassaj-dev` pressure on port 3004 drove memory up until a manual reboot).

> **restart guard:** `pm2 restart` and sensitive production commands are intercepted by the Claude Code client. When a restart is needed, ask the user to run it in their own terminal (see `feedback_pm2_restart_guard` / `CLAUDE.md`). Also: restarting `nassaj-dev` kills any Claude session that is its child — run your working session on a different instance.

### 11.2 Monitoring commands

```bash
# RSS for all pm2 processes (incl. nassaj-dev) + cap and restarts
pm2 list

# nassaj-dev details: current RSS, max_memory_restart, restart counter
pm2 describe nassaj-dev | grep -Ei 'memory|restart|status'

# Live child claude processes and their individual RSS (KB)
ps -eo pid,ppid,rss,comm | grep -i claude

# Sum of RSS across all child claude processes (MB)
ps -eo rss,comm | grep -i claude | awk '{s+=$1} END {print s/1024 " MB"}'

# Total and available system memory
free -m
```

### 11.3 What to watch and the threshold

- **Process cap:** the `max_memory_restart` value for `nassaj-dev` lives in `ecosystem.config.cjs` (**not touched here** — see the 2026-06-06 incident: it was edited to `512M` for nassaj-dev but **was not applied to the live runtime** until `pm2 restart` + `pm2 save`). Check the live effective value with `pm2 describe`, not the file.
- **Operational rule:** do not launch heavy concurrent session waves if total RSS approaches the process cap or if overall system usage exceeds ~80% (matching the `CLAUDE.md` resource rule). Shed concurrent sessions rather than risk OOM.
- **Early-warning signal:** a rising `restart` counter for `nassaj-dev` in `pm2 list` with no deploy reason = the process is hitting its memory cap and being recycled under load.

### 11.4 Automated RSS monitor / مراقبة RSS الآلية (`scripts/monitor-rss.sh`)

**العربية**

سكربت **قراءة-فقط** يؤتمت الأوامر اليدوية في §11.2 ويطبّق العتبات في §11.3. لا يقتل ولا يعيد تشغيل ولا يعدّل أي إعداد (حارس `pm2 restart` يحجبه أصلاً).

ما يرصده:
- RSS الحيّ لعملية `nassaj-dev` (من `pm2 jlist` → `monit.memory`).
- عدد وRSS عمليات `claude` الفرعية المباشرة (PPID == pid لـ nassaj-dev، عبر `ps`)، و**مجموعها** = ما يهدّد OOM تحت الحمل المتزامن.
- السقف الحيّ `max_memory_restart` من `pm2_env` (لا من الملف — قد يكون `None` رغم `512M` في `ecosystem.config.cjs`، تماماً كحادثة 2026-06-06).
- ذاكرة النظام % من `/proc/meminfo`.

التحذيرات (`[WARN]`، رمز خروج 1):
- `nassaj-dev RSS ≥ THRESHOLD%` من السقف الحيّ (افتراضي 80%) → خطر إعادة تشغيل pm2 وقطع الجلسات.
- `combined RSS ≥ 100%` من السقف → الأطفال يتجاوزون السقف؛ راقب OOM وخفّف الجلسات المتزامنة.
- ذاكرة النظام `≥ SYS_THRESH%` (افتراضي 80%) → لا تطلق موجات جلسات جديدة (قاعدة `CLAUDE.md`).
- إن كان السقف الحيّ `None` (الوضع الحالي 2026-06-09): يُعتمد على عتبة ذاكرة النظام فقط ويُطبع تنبيه ربطاً بحادثة 2026-06-06.

```bash
# لقطة واحدة (للتشخيص اليدوي)
bash scripts/monitor-rss.sh

# مراقبة مستمرة كل 30/60 ثانية (طرفية مخصّصة)
bash scripts/monitor-rss.sh --watch
bash scripts/monitor-rss.sh --watch 60

# خرج JSON للتجميع/التنبيهات الخارجية
bash scripts/monitor-rss.sh --json

# تسجيل إلى ملف + ضبط العتبات
LOG_FILE=~/rss-monitor.log THRESHOLD=80 SYS_THRESH=80 bash scripts/monitor-rss.sh --watch
```

> لا تشغّله كـ child لعملية `nassaj-dev` نفسها في وضع `--watch` الطويل؛ شغّله من طرفية SSH مستقلة أو instance آخر (نفس سبب §11.1: restart يقتل الأطفال).

**English**

A **read-only** script that automates the §11.2 manual commands and enforces the §11.3 thresholds. It never kills, restarts, or edits config (the `pm2 restart` guard blocks that anyway).

It watches: live `nassaj-dev` RSS (`pm2 jlist`), count + RSS of direct child `claude` processes (PPID match via `ps`) and their **sum** (the real OOM driver under concurrency), the live `max_memory_restart` cap from `pm2_env` (not the file — may be `None` despite `512M` in `ecosystem.config.cjs`, exactly the 2026-06-06 case), and system memory % from `/proc/meminfo`.

It emits `[WARN]` (exit 1) when: `nassaj-dev` RSS ≥ `THRESHOLD%` of the live cap (default 80%); combined RSS ≥ 100% of the cap; or system memory ≥ `SYS_THRESH%` (default 80%). When the live cap is `None` (current state 2026-06-09) it falls back to the system-memory threshold and prints a note linking the 2026-06-06 incident.

Same invocation as above. Run `--watch` from an independent SSH terminal (not as a child of `nassaj-dev`), per §11.1.
