# خطة المراجعة والإصلاح والترقية — nassaj-dev v1.35.0
## Review, Remediation & Upgrade Plan — 2026-07-09

> مراجعة معمارية شاملة (للقراءة فقط) على فرع `integration/publish`. المرجع الحي للقاعدة: `~/.local/share/nassaj-dev/db.sqlite`.
> Read-only architectural audit. Live DB: `~/.local/share/nassaj-dev/db.sqlite`.

---

## 1. ملخّص تنفيذي · Executive Summary

**العربية:** نسّاج مستقر وظيفياً لكن يحمل ديناً أمنياً متراكماً في طبقة المسارات (TaskMaster) وعزل المزوّدين. أخطر ثلاثة: (1) اجتياز مسار في TaskMaster يتيح لأي مستخدم مُصادَق قراءة/كتابة أي ملف على الخادم (يشمل `.env`/JWT_SECRET/قاعدة التوكنز)؛ (2) عزل Codex لكل مستخدم غير مُفعَّل إطلاقاً → كل المستخدمين على اشتراك OpenAI للمالك + تسرّب نصوص الجلسات (مخالفة ToS)؛ (3) كتابة ملفات المشاريع العامة تُصرَّح عبر حارس قراءة فقط. أولوية المالك رقم 1 — "الخروج العشوائي" — مُشخَّص بأدلة حيّة: انتهاء صلاحية JWT عند 7 أيام مع فجوات في التجديد المنزلق، لا تعارض JWT_SECRET (توقّف `bad_signature` نهائياً في 2026-06-30).

**English:** Functionally stable but carrying security debt in path handling (TaskMaster) and provider isolation. Top three: (1) TaskMaster path traversal → authenticated arbitrary file read/write incl. secrets; (2) Codex per-user isolation never wired → all users share the owner's OpenAI subscription + cross-user transcript leak (ToS); (3) public-project writes authorized by a read-only guard. The owner's #1 issue, "random logout", is diagnosed from live evidence as 7-day JWT hard-expiry plus sliding-refresh gaps — NOT a JWT_SECRET conflict (`bad_signature` ceased permanently 2026-06-30).

---

## 2. تشخيص الخروج العشوائي · Random-Logout Diagnosis (الأولوية رقم 1)

### الآلية المؤكّدة بالأدلة الحيّة · Confirmed mechanism

سلسلة السببية (متحقَّقة في الكود + audit_log):
1. جلسة طويلة العمر (تبويب مفتوح أو PWA مثبّت — ظهر UA أندرويد في `no_token`) لا تعبر نصف عمر التوكن بنشاط REST، فلا يُجدَّد التوكن المنزلق.
2. عند اليوم السابع ينتهي التوكن فعلياً. لا يمكن للتجديد المنزلق إنقاذ توكن منتهٍ (الخادم يجدّد فقط توكناً **صالحاً** تجاوز نصف عمره — `server/middleware/auth.js`).
3. أول نداء REST دوري (كل ~10 دقائق، `claimedUserId=2`) يصل بتوكن منتهٍ → `401 + token present` → `api.js:34-35` يطلق `auth:unauthorized`.
4. `AuthContext.tsx:178-186` → `clearSession()` + إعادة توجيه إلى `/login` = **الخروج**. النداءات التالية بلا توكن → `no_token`.

**الدليل الحيّ (audit_log):** أزواج متطابقة في نفس الثانية على فترات 10 دقائق: `expired|rest|uid=2` + `no_token|rest` بتواريخ حتى 2026-07-09 (اليوم). حادثة 2026-07-06: 17 رفض `expired|ws` متتالٍ (05:05→06:25، حلقة إعادة اتصال WS بتوكن ميت عند سقف backoff 30s) ثم انتقال إلى `expired|rest` + `no_token` = الخروج الفعلي. `bad_signature` آخر ظهور 2026-06-30 14:48 ثم توقّف → تعارض JWT_SECRET (B-70) **محسوم**.

### آليتان متمايزتان تغذّيان العَرَض
- **REST expiry → redirect (سبب الخروج المرئي):** ما ورد أعلاه. يرتبط بـ B-131.
- **WS يحمل توكن React قديماً (finding `logout-regression-1`):** `api.js:41` يكتب `X-Refreshed-Token` إلى localStorage فقط ولا يُحدِّث حالة React؛ `WebSocketContext.tsx:64,94,110` يعيد الاتصال بالتوكن الأصلي أبداً → عند اليوم السابع حلقة رفض WS دائمة (تفسّر عنقود 2026-07-06 ws). يقتل البث الحي/الحضور دون خروج كامل، لكنه يسبق الخروج ويضاعفه.

### الفرضيات مرتّبة · Ranked hypotheses
1. **[مؤكّد ~0.9] انتهاء JWT 7 أيام + فجوة تجديد للجلسات الخاملة/PWA.** الإصلاح: (أ) تجديد استباقي قبل الانتهاء بغضّ النظر عن نشاط REST (مؤقّت عميل يفحص عمر التوكن)؛ (ب) نشر `X-Refreshed-Token` إلى AuthContext عبر حدث `auth:token-refreshed` (يعكس نمط `auth:unauthorized`)؛ (ج) قراءة WS لأحدث توكن من localStorage عند كل (إعادة) اتصال كما يفعل `shell/utils/socket.ts:11`؛ (د) عند `expired` حاول refresh صامت مرّة قبل clearSession بدل الطرد الفوري.
2. **[منخفض ~0.05] عودة تعارض JWT_SECRET.** مستبعد: `bad_signature` توقّف 2026-06-30. تأكيد نفي: أي ظهور `bad_signature` جديد.
3. **[منخفض ~0.05] طرد pwd_iat (تغيير كلمة/OIDC backchannel).** لا سجلّات `password_changed_at` متزامنة؛ راقب بعد تفعيل OIDC (finding `auth-security-2`).

### الخطوة التشخيصية التالية الدقيقة (تأكيد نهائي قبل أي إصلاح)
```sql
-- على القاعدة الحيّة (للقراءة فقط):
SELECT date(created_at) d, json_extract(metadata,'$.reason') reason,
       json_extract(metadata,'$.transport') tr,
       json_extract(metadata,'$.claimedUserId') uid, COUNT(*) c
FROM audit_log WHERE action='auth_rejected' AND created_at>datetime('now','-21 day')
GROUP BY d, reason, tr, uid ORDER BY d DESC;
```
إن بقيت النتيجة `expired`/`no_token` حصراً (بلا `bad_signature`) فالفرضية 1 مؤكّدة نهائياً ويُشرع في الإصلاح (أ→د). أضف على العميل تسجيل `iat/exp` للتوكن لحظة أول 401 لتأكيد أن الفجوة هي الخمول لا خطأ ساعة.

---

## 3. الأخطاء المؤكّدة · Confirmed Defects (findings table)

| # | العنوان | الخطورة | الملف:السطر | الحالة مقابل اللوحة |
|---|---------|---------|-------------|---------------------|
| F1 | Codex بلا عزل لكل مستخدم — مشاركة اشتراك المالك + تسرّب نصوص | high | `server/openai-codex.js:283` | جديد |
| F2 | اجتياز مسار: قراءة ملف عشوائي (GET /prd) | high | `server/routes/taskmaster.js:438` | جديد |
| F3 | اجتياز مسار: كتابة ملف عشوائي (apply-template) | high | `server/routes/taskmaster.js:1394` | جديد |
| F4 | كتابة مشاريع عامة تُصرَّح بحارس قراءة فقط | high | `server/index.js:881` | جديد |
| F5 | التوكن المجدَّد لا يصل React → حلقة WS "expired" | medium | `src/utils/api.js:41` | معروف-مفتوح (B-131) |
| F6 | تعداد drain يتجاهل kimi/deepseek/glm | medium | `server/index.js:2295` | جديد |
| F7 | check-session-status بلا تحقّق رؤية → تسرّب بث/سجل | medium | `chat-websocket.service.ts:521` | جديد |
| F8 | OIDC backchannel-logout يقبل توكناً مزوَّراً (بلا توقيع) | medium | `server/routes/oidc.js:373` | معروف-مفتوح (T-211) |
| F9 | login enumeration عبر توقيت argon2 | medium | `server/routes/auth.js:143` | جديد |
| F10 | اجتياز مسار في parse-prd | medium | `server/routes/taskmaster.js:815` | جديد |
| F11 | تثبيت الإضافات = RCE لأي مستخدم مُصادَق | medium | `server/routes/plugins.js:140` | جديد |
| F12 | Service worker يخزّن استجابات 502 لـ /assets → كسر دائم | medium | `public/sw.js:51` | جديد |
| F13 | load-env fallback صامت لقاعدة بيانات خاطئة | medium | `server/load-env.js:24` | جديد |
| F14 | acceptInvite يتخطّى تحقّق اسم المستخدم | low | `server/services/invite.service.js:104` | جديد |
| F15 | get-active-sessions يُسقط kimi/deepseek/glm | low | `chat-websocket.service.ts:612` | جديد |
| F16 | commands يقرأ .claude/commands من projectPath عشوائي | low | `server/routes/commands.js:904` | جديد |
| F17 | push unsubscribe بلا تحقّق ملكية (IDOR) | low | `server/routes/settings.js:629` | جديد |
| F18 | ترحيل session_agents يُسقط عمود agent_model | low | `server/modules/database/migrations.ts:706` | جديد |
| F19 | reconcile يؤرشف عند تعذّر FS عابر بلا استرجاع | low | `project-reconcile.service.ts:76` | جديد |
| F20 | message_authors/starred_sessions نمو غير محدود | low | `server/modules/database/schema.ts:228` | جديد |

تفاصيل نهج الإصلاح لكل بند في المخرج المنظَّم (StructuredOutput → bugs).

---

## 4. عناصر Upstream للتبنّي · Upstream Adoption

- **PR #898 (restart-required banner) — تبنّي، أولوية عالية.** أضِف حقل النسخة إلى `/health` وشريط "حُدِّث الخادم ولم يُعَد تشغيله". يعالج أكبر ألم تشغيلي في نسّاج (تغييرات dist-server لا تسري حتى safe-restart). **مذكرة دمج:** كيّف الآلية على خط نسخ نسّاج (1.35.0 مستقل) وتدفّق `safe-restart.sh`؛ لا تتبنَّ منطق التحديث التلقائي لأعلى.
- **PR #943 (Codex effort) — كيّف، أولوية منخفضة.** فقط إن رأى Codex استخداماً فعلياً.
- **commit 6a53c31e (changelog كـ markdown في VersionUpgradeModal) — كيّف، منخفضة.** يقترن جيّداً مع #898 عند لمس سطح النسخة.
- **تخطّي/مراقبة:** #887 (إعادة كتابة WS gateway) — عالي التعارض/منخفض القيمة مع مكدّس نسّاج المتباعد (session-registry/drain/B-80/presence)، وليس إصلاحاً للخروج. Electron/CloudCLI Desktop (v1.35.0) — لا قيمة (نسّاج خادمي متعدّد المستخدمين). #854/#903/#920 مدموجة مسبقاً.

---

## 5. آلية الدمج · Merge Mechanism

1. **الفرع:** `git checkout -b fix/security-remediation-2026-07-09 integration/publish`. فرع فرعي لكل عائلة (auth / taskmaster / provider-isolation).
2. **Commits:** Conventional Commits، **كل سطر ≤ 100 محرف** (حدّ commitlint الصارم). ذيّل بـ `Co-Authored-By`. commit محلي لكل إصلاح؛ لا `git add -A` — أسماء ملفات محدّدة (بروتوكول الجلسات المتوازية).
3. **الاختبار:** vitest الموجود في المستودع. أضِف اختبار عزل Codex (يعكس `claude-engine-provider.test.ts`)، واختبارات اجتياز مسار TaskMaster (read/write/parse يرفض `../`)، واختبار حارس الكتابة للمشاريع العامة. شغّل `npm test` واقرأ النتائج بنفسك (لا تثق بادعاء وكيل).
4. **البناء:** `npm run build:client` لتغييرات الواجهة، `build:server` لتغييرات الخادم (تذكّر `--include=dev` تحت production).
5. **النشر:** **حصراً `bash scripts/safe-restart.sh --exec`** — ممنوع منعاً باتّاً `pm2 restart nassaj-dev` الخام (drain يحبس المنفذ 3004 → 502 ممتد).
6. **التحقّق بعد النشر:** `curl /health`، فحص audit_log لغياب رفض جديد، تحقّق حيّ في المتصفح للخروج/العزل.
7. **AGPL-3.0:** المستودع AGPL؛ §13 يلزم إتاحة المصدر المخدوم شبكياً. تبنّي upstream (AGPL أيضاً) متوافق؛ احفظ إسناد المصدر في رسائل الـcommit.

---

## 6. التسلسل · Sequencing

1. **حرِج/فوري:** F1 عزل Codex (ToS + تسرّب)، F2+F3+F10 اجتياز مسار TaskMaster (تحقّق regex مشترك + احتواء مسار)، F4 حارس كتابة المشاريع العامة، **تشخيص+إصلاح الخروج (B-131/F5)**.
2. **عالٍ:** F11 حصر تثبيت الإضافات على owner/admin، F7 تحقّق رؤية check-session-status، F13 fail-fast في load-env.
3. **متوسط:** F6+F15 توحيد سجلّ المزوّدين للـdrain/الجلسات، F12 حارس response.ok في SW، F9 decoy hash، F8 تحقّق JWKS **قبل** تفعيل OIDC.
4. **سبرنت تثبيت (≥ 8 medium مفتوحة → إلزامي):** ادمج الـmediums + الـlows (F14/F16/F17/F18/F19/F20) في سبرنت تثبيت واحد داخل نفس الخطة.
5. **تبنّي upstream:** #898 بعد استقرار الأمن.

---

## 7. تحديثات اللوحة · Board Updates

انظر StructuredOutput → `board_updates` للقيم الدقيقة (kind/id/title/severity/priority/area) لكل بند جديد. البنود المعروفة (B-131، T-211) لا تُكرَّر بل تُحدَّث ملاحظاتها.

---
*خطة واحدة، backlog واحد — لا "خطة إصلاح" منفصلة. كل بند أعلاه مهمة في `docs/project-state.json`.*
