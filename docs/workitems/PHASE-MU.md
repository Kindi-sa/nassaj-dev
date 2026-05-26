# Phase MU — Multi-User ⏳

**الحالة:** معلّقة — مخطّطة 2026-05-26
**المسؤول:** backend-dev + frontend-dev (architect للقرارات، scribe للتوثيق)
**القرارات المرجعية:** ADR-014, ADR-015, ADR-016, ADR-017 (في `~/.claude/alkindy/decisions/`)

> **الهدف:** تحويل `nassaj-dev` إلى multi-user لفريق نسَّاج: عزل اعتماد per-user
> (Claude إلزامي، Gemini)، مع مشاركة حيّة كاملة للمحادثات والملفات والتعليمات، عبر
> Auth مدمجة داخل التطبيق وطبقة عزل مركزية `resolveProviderEnv`.

---

## Auth (C-AUTH-*)

### C-AUTH-1: جداول `users` + `audit_log`
- **الوصف:** إضافة جدول `users` (id, username, password_hash[argon2id], role[owner/admin/user],
  created_at, status) وجدول `audit_log` (id, user_id, action, metadata, timestamp) داخل DB
  الموجودة `db.sqlite`. لا جدول `sessions` (JWT stateless).
- **التبعيات:** لا شيء (نقطة البداية).
- **معيار القبول:** migration يُنشئ الجدولين على DB قائمة دون فقد بيانات؛ schema snapshot test يمرّ.

### C-AUTH-2: JWT stateless + bootstrap owner
- **الوصف:** إصدار/تحقق JWT بلا حالة خادم (secret من `.env`). عند أول تشغيل على DB فارغة من
  المستخدمين، إنشاء owner تلقائياً (bootstrap)، لا يُكرَّر بعد وجود مستخدم.
- **التبعيات:** C-AUTH-1.
- **معيار القبول:** أول تشغيل يُنشئ owner واحداً؛ تشغيل لاحق لا يُكرّره؛ JWT صالح يُتحقَّق منه بلا قراءة DB للجلسة.

### C-AUTH-3: auth middleware (HTTP 401 + WS upgrade)
- **الوصف:** middleware يحرس كل طلبات HTTP المحمية (يردّ **401** بلا JWT صالح) ويحرس
  **WebSocket upgrade** (يرفض الاتصال بلا JWT صالح). يستخرج `userId` ويمرّره للطبقات الأدنى.
- **التبعيات:** C-AUTH-2.
- **معيار القبول:** طلب HTTP بلا/بـ JWT غير صالح → 401؛ WS upgrade بلا JWT صالح → رفض؛
  طلب صالح يمرّر `userId` الصحيح.

### C-AUTH-4: invite flow
- **الوصف:** إنشاء دعوة (owner/admin) → token دعوة → قبول الدعوة بإنشاء كلمة مرور →
  حساب `user`. لا تسجيل عام إطلاقاً (invite-only).
- **التبعيات:** C-AUTH-2.
- **معيار القبول:** دعوة → قبول → دخول يعمل E2E؛ محاولة تسجيل بلا دعوة مرفوضة.

---

## Isolation (B-ISO-*)

### B-ISO-RESOLVER: `resolveProviderEnv(userId, provider)`
- **الوصف:** الطبقة المحورية — **مصدر الحقيقة الوحيد** للعزل. تبني env المعزول لكل spawn
  حسب المزوّد وتُستهلَك من كل المزوّدين. تُرجِع المسارات/المتغيرات الصحيحة لكل من
  Claude/Gemini/Codex/agy.
- **التبعيات:** C-AUTH-3 (يوفّر `userId` الموثَّق).
- **معيار القبول:** كل spawn لأي مزوّد يمرّ عبر هذه الدالة لا غيرها؛ تُرجِع env مختلف
  per-user لـ Claude/Gemini و env المالك المشترك لـ agy.

### B-ISO-CLAUDE: `CLAUDE_CONFIG_DIR` + symlinks
- **الوصف:** ضبط `CLAUDE_CONFIG_DIR=~/.nassaj-users/<userId>/.claude` (اعتماد معزول)، مع
  symlink لـ `projects/` و `CLAUDE.md` و `NASSAJ.md` نحو الجذر المشترك (محادثات/تعليمات مشتركة).
- **التبعيات:** B-ISO-RESOLVER.
- **معيار القبول:** مستخدمان مختلفان لهما `CLAUDE_CONFIG_DIR` مختلف فعلياً؛ كلاهما يرى نفس
  `projects/` والتعليمات عبر symlink.

### B-ISO-GEMINI: `GEMINI_CLI_HOME`
- **الوصف:** عزل اعتماد Gemini عبر `GEMINI_CLI_HOME` لكل مستخدم (نمط قائم في
  `server/gemini-cli.js:83`)؛ المحادثات تبقى مشتركة.
- **التبعيات:** B-ISO-RESOLVER.
- **معيار القبول:** `GEMINI_CLI_HOME` مختلف per-user؛ المحادثات مشتركة بين المستخدمين.

### B-ISO-CODEX: عزل Codex (مؤجَّل)
- **الوصف:** عزل اعتماد Codex مؤجَّل (استخدام شبه معدوم). يبقى مشتركاً مؤقتاً، مع توثيق
  نقطة الإدراج في `resolveProviderEnv` لتفعيله لاحقاً.
- **التبعيات:** B-ISO-RESOLVER.
- **معيار القبول:** Codex يعمل كما هو دون كسر؛ بند مسجَّل كـ deferred لا blocking.

### B-ISO-PROVISION: provisioning `~/.nassaj-users/<uid>` + symlinks
- **الوصف:** عند **قبول الدعوة** (C-AUTH-4)، إنشاء `~/.nassaj-users/<userId>/.claude`
  (و `.gemini` حسب الحاجة) بصلاحيات مقيّدة + symlinks المحادثات/التعليمات تلقائياً.
- **التبعيات:** C-AUTH-4, B-ISO-CLAUDE, B-ISO-GEMINI.
- **معيار القبول:** قبول دعوة يُنشئ المجلد والـ symlinks تلقائياً؛ المستخدم الجديد يشغّل
  Claude باعتماده الخاص فوراً ويرى المحادثات المشتركة.

### B-ISO-AGYLOCK: قفل discovery ضيّق
- **الوصف:** قفل in-process ضيّق لحظي على **نافذة اكتشاف brain UUID** في مسار بدء agy فقط
  (لا قفل عام)، يُحرَّر فور إسناد الـ UUID — لتفادي خلط المحادثات تحت التزامن.
- **التبعيات:** B-ISO-RESOLVER.
- **معيار القبول:** spawnان متزامنان لـ agy لا يختلطان في إسناد brain UUID؛ القفل لا يحجب
  قراءات المحادثات ولا spawnات المزوّدين الآخرين.

---

## UI (C-UI-*)

### C-UI-1: تسجيل دخول RTL
- **الوصف:** شاشة تسجيل دخول (username + password) بدعم RTL عربي كامل.
- **التبعيات:** C-AUTH-2, C-AUTH-3.
- **معيار القبول:** الدخول يعمل؛ الشاشة RTL صحيحة بصرياً.

### C-UI-2: إدارة مستخدمين RBAC
- **الوصف:** لوحة إدارة المستخدمين (قائمة، أدوار، تعطيل/حذف) حسب الصلاحية
  (owner/admin يديران؛ user لا يرى اللوحة).
- **التبعيات:** C-AUTH-3.
- **معيار القبول:** owner/admin يديرون المستخدمين؛ user محجوب؛ الإجراءات تُسجَّل في audit_log.

### C-UI-3: دعوات
- **الوصف:** واجهة إنشاء دعوة وعرض الدعوات المعلّقة ونسخ رابط/token الدعوة.
- **التبعيات:** C-AUTH-4, C-UI-2.
- **معيار القبول:** owner/admin ينشئ دعوة ويحصل على رابط؛ الدعوة المقبولة تختفي من المعلّقة.

---

## Hardening / Cross-cutting (m-*) و E2E

### m-DBPERM: chmod 600 على DB
- **الوصف:** `chmod 600` على `db.sqlite` (+ WAL/SHM والنسخ الاحتياطية) ليقرأها `nassaj` حصراً.
- **التبعيات:** C-AUTH-1.
- **معيار القبول:** صلاحيات DB = 600؛ لا قارئ آخر على الجهاز.

### m-RATELIMIT: rate limit على auth
- **الوصف:** rate limiting على endpoints الـ auth (login، قبول الدعوة) لمنع brute force.
- **التبعيات:** C-AUTH-2, C-AUTH-4.
- **معيار القبول:** تجاوز الحد يردّ 429؛ الاستخدام الطبيعي غير متأثّر.

### m-RUNBOOK: runbook ثنائي اللغة
- **الوصف:** runbook (عربي سرد + إنجليزي للأوامر/الحقول) لـ bootstrap owner، إنشاء دعوة،
  provisioning، والترحيل للإنتاج ونقل `~/.nassaj-users/`.
- **التبعيات:** كل البنود التنفيذية أعلاه.
- **معيار القبول:** runbook يغطّي bootstrap + invite + provision + migration بخطوات قابلة للتنفيذ.

### M-ISO-E2E: اختبار مستخدمين باعتمادين مختلفين / نفس brain
- **الوصف:** اختبار E2E: مستخدمان عبر دعوتين، كلٌّ باعتماد Claude مختلف
  (`CLAUDE_CONFIG_DIR` منفصل)، يريان نفس المحادثات المشتركة ونفس brain agy دون خلط تحت التزامن.
- **التبعيات:** كل B-ISO-* و C-AUTH-* و C-UI-*.
- **معيار القبول:** الاختبار يثبت: عزل اعتماد Claude فعلي + مشاركة محادثات + نفس brain +
  لا خلط تحت spawn متزامن → بوابة المرحلة (GATE) تُجتاز.

---

## Critical Path

```
C-AUTH-1 → C-AUTH-2 → C-AUTH-3 → B-ISO-RESOLVER
                                      ├─▶ B-ISO-CLAUDE ─┐
                                      └─▶ B-ISO-GEMINI ─┤
                                                        ▼
                                              B-ISO-PROVISION
                                                        ▼
                                                  C-UI-1/2/3
                                                        ▼
                                                   M-ISO-E2E
                                                        ▼
                                                      GATE
```

- `B-ISO-CLAUDE ∥ B-ISO-GEMINI` متوازيان بعد `B-ISO-RESOLVER`.
- `C-AUTH-4` (invite) فرع من `C-AUTH-2`، شرط لـ `B-ISO-PROVISION` و `C-UI-3`.
- `B-ISO-CODEX` مؤجَّل (deferred، خارج المسار الحرج).
- `B-ISO-AGYLOCK` فرع من `B-ISO-RESOLVER`، يُتحقَّق منه في `M-ISO-E2E`.
- `m-*` (DBPERM/RATELIMIT/RUNBOOK) cross-cutting، تُغلَق قبل GATE.
