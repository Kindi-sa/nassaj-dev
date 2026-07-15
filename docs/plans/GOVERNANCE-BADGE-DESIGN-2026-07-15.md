# تصميم شارة حوكمة المحرّك — T-900 (المرحلة 3) — 2026-07-15

- **التاريخ:** 2026-07-15 · **الحالة:** تصميم للاعتماد · **المؤلف:** architect · **الفرع:** `fix/security-remediation-2026-07-09`
- **المتطلب:** `docs/plans/CODEX-GOVERNANCE-DECOUPLING-2026-07-11.md` §المرحلة 3 (أسطر 86-95): شارة تعكس حالة حوكمة المحرّك الفعلية لكل جلسة.
- **المبدأ الحاكم (T-883، commit d0f97941):** «محكوم» = بصمة sha256 مطابقة للمصدر المحايد، لا مجرد وجود ملف. شارة تكذب أسوأ من لا شارة.
- **تحقُّق حيّ:** `~/.claude/AGENTS.md` ملف فعلي 10347B؛ `~/.config/opencode/AGENTS.md → nassaj-core/AGENTS.md` (نفس مصدر Codex)؛ `~/.claude/CLAUDE.md → NASSAJ.md`.

---

## 1. جدول الدلالة الصادقة لكل مزوّد

| المزوّد | الآلية | الفحص الخادمي (قراءة فقط) | enforced | mechanism |
|---|---|---|---|---|
| **codex** | نسخة 0444 ببصمة مطابقة، حارس fail-closed كل turn | `governanceMatchesSource(CODEX_HOME/AGENTS.md)` — الدالة الدقيقة نفسها (material.js:95) | `true` | `codex-fingerprint` |
| **claude** | آلية CLAUDE.md/NASSAJ.md الأصلية (يقرأها كلود حتماً كل جلسة) | `<CLAUDE_CONFIG_DIR>/CLAUDE.md` (يتبع الرابط) ملف عادي غير فارغ | `false` | `claude-md` |
| **opencode** | يقرأ `~/.config/opencode/AGENTS.md` (رابط مشترك لنفس مصدر Codex)، بلا حارس | قراءة تتبع الرابط + بصمة == `readNeutralGovernance().fingerprint` | `false` | `opencode-agents` |
| **hermes, cursor, gemini, antigravity, kimi, deepseek, glm, sakana** | لا آلية حوكمة في الكود | لا فحص | `false` | `none` → `ungoverned` |

- الحوكمة تُحسب لكل **(مستخدم، مزوّد)** لا لكل جلسة: codex عبر `resolveCodexHomeForUser(userId)`؛ كل جلسات نفس المزوّد للمستخدم تشترك في الحالة.
- **لا تُستدعى** `ensureCodexGovernance` ولا `materializeGovernanceCopy` (تُعيدان التجسيد) — الكشف قراءة بحتة (قيد 1).
- opencode رابط رمزي مشروع؛ لذا لا يُعاد استخدام `governanceMatchesSource` له (ترفض الروابط بـlstat:101) بل مقارنة محتوى تتبع الرابط.

---

## 2. عقد الكشف الخادمي

- **المسار:** `GET /api/providers/:provider/governance` — يحاكي نمط `/:provider/api-key/capability` (routes:529-536): قراءة فقط، بلا سرّ، لكنه **يُمرّر userId** (كـ`/auth/status` routes:415).
- **المصادقة:** الراوتر خلف `authenticateToken`؛ `userId = readAuthenticatedUserId(req)` (routes:46-47). `provider` عبر `parseProvider` (routes:246).
- **الرد (200):** `createApiSuccessResponse({ provider, status, enforced, mechanism })` → `{ success:true, data:{...} }`.
  - `status: 'governed' | 'ungoverned'` · `enforced: boolean` · `mechanism: 'codex-fingerprint'|'claude-md'|'opencode-agents'|'none'`.
- **لا حالة ثالثة في الرد:** «غير معروف» = غياب الرد نفسه (خادم قديم يردّ 404) → العميل يُخفي بصمت. الخادم لا يكذب أبداً بـ`ungoverned` عند تعذُّر القراءة.
- **لحظة الحساب:** الفحص يُجرى وقت الطلب على القرص الحالي — نفس ما سيقرؤه أول فحص للحارس عند spawn (codex-governance.ts:82). لا يُشغّل الإصلاح الذاتي؛ لو أصلح spawn لاحقاً، إعادة الجلب تقلبها.

---

## 3. نقاط اللمس (ملف:سطر)

**خادم (جديد + تعديل):**
- `server/modules/providers/services/provider-governance.service.ts` — **جديد**: switch على المزوّد يحسب الواصف. يستورد `governanceMatchesSource`/`readNeutralGovernance` (material.js:95/69)، `resolveCodexHomeForUser` (codex-home.ts:35)، `resolveProviderEnv` (resolve-provider-env.js:74؛ claude `CLAUDE_CONFIG_DIR`:92، opencode `XDG_CONFIG_HOME`:129).
- `server/modules/providers/provider.routes.ts` — إضافة راوت واحد بعد سطر 536.

**عميل (جديد + تعديل):**
- `src/components/chat/hooks/useProviderGovernance.ts` — **جديد**: يحاكي `useProviderApiKeyCapability.ts` (fail-closed). الفشل/404/شكل غير معروف ⇒ `null` = **مُخفى** (لا `ungoverned` كاذب).
- `src/shared/view/GovernanceBadge.tsx` — **جديد**: يحاكي `WorkflowStatusBadge.tsx` (يُرجع `null` عند غياب الواصف، badge:100-102). Prop: `provider`.
- `src/components/main-content/view/subcomponents/MainContentTitle.tsx` — إدراج `<GovernanceBadge provider={selectedSession.__provider} />` بعد `WorkflowStatusBadge` (سطر 134)، ضمن بوابة `activeTab==='chat' && selectedSession`.
- `src/i18n/locales/{en,ar}/common.json` — إضافة `governanceBadge.*` (نفس ملف `workflowStatus`/`mainContent`؛ ملف واحد لوكيل واحد تفادياً لسباق JSON).

**ملاحظة موضع:** `ClaudeStatus.tsx:278` يختفي قبل أي turn (`if (!isLoading && !status) return null`) فلا يصلح؛ MainContentTitle هو الرأس الدائم للجلسة النشطة.

---

## 4. مواصفة UI (3 حالات + tooltip)

شارة pill صغيرة بجوار عنوان الجلسة، على غرار `WorkflowStatusBadge` (`role="status"`، تمييز بالأيقونة+النص لا اللون فقط، gap منطقي يعكس RTL آلياً):

| الحالة | العرض | tooltip (المفتاح) |
|---|---|---|
| **governed** (`status:'governed'`) | زمردي، `ShieldCheck` + `governanceBadge.governed` | enforced⇒`governanceBadge.tooltip.enforced` / وإلا `governanceBadge.tooltip.present` |
| **ungoverned** (`status:'ungoverned'`) | كهرماني/رمادي، `ShieldOff` + `governanceBadge.ungoverned` | `governanceBadge.tooltip.none` |
| **hidden** (الواصف `null`) | لا عرض إطلاقاً (خادم قديم/خطأ شبكة/مزوّد غير معروف) | — |

- المفاتيح: `governanceBadge.governed/ungoverned` + `governanceBadge.tooltip.{enforced,present,none}` في `common.json`، `useTranslation('common')`.
- **التحديث (MVP):** جلب عند تغيّر `provider` فقط (hook مُفتاحه `[provider]`). مبرَّر: الحوكمة تتغير نادراً وخارج المسار (تهيئة/انحراف/إصلاح)؛ قراءة عند الاختيار = حقيقة القرص الآن = ما سيراه spawn الوشيك. بثّ WS للتحديث اللحظي = خارج النطاق (مستقبل).

---

## 5. التدهور الرشيق (قيد 3 — إلزامي)

build:client يُنشر قبل safe-restart الخادم. عميل جديد على خادم قديم: الراوت غير موجود ⇒ 404 ⇒ الـhook يضبط `null` ⇒ الشارة **تختفي بصمت**. لا خطأ، ولا `ungoverned` كاذبة. (fail = HIDDEN، لا fail = ungoverned — فرق جوهري عن hook الاعتمادات الذي يفشل إلى `none`.)

---

## 6. معايير القبول (قابلة للفحص)

- [ ] جلسة codex بحوكمة مطابقة ⇒ الشارة governed؛ إتلاف/تصفير النسخة ⇒ ungoverned (يطابق حكم `governanceMatchesSource`).
- [ ] جلسة claude بـCLAUDE.md حاضر ⇒ governed؛ إزالته ⇒ ungoverned.
- [ ] جلسة hermes/cursor/gemini ⇒ ungoverned دائماً (بلا آلية).
- [ ] الشارة تعكس ≥3 جلسات بمزوّدات مختلفة بصدق (معيار §المرحلة 3 سطر 95).
- [ ] الكشف قراءة بحتة: لا كتابة/تجسيد على القرص عند استدعاء الراوت (تحقّق بـ mtime لـAGENTS.md قبل/بعد).
- [ ] عميل جديد على خادم بلا الراوت ⇒ لا شارة، لا خطأ في console.

---

## 7. خطة الاختبار

**خادم** (Vitest، يحاكي `codex-governance-material.test.ts`، ثنائيات حقيقية بلا fixtures مصطنعة):
- `provider-governance.service`: codex governed/drifted/symlink/missing (عبر tmp CODEX_HOME + مصدر محايد حقيقي)؛ claude present/missing؛ opencode fingerprint match/drift؛ default⇒ungoverned. تأكيد **عدم** كتابة القرص (تجسّس على fs.writeFileSync/chmodSync).
- الراوت: 200 بالشكل الصحيح لكل مزوّد؛ `parseProvider` يرفض مزوّداً مجهولاً بـ400؛ userId ممرَّر (مستخدمان معزولان يريان حالتيهما).

**عميل** (Vitest + RTL):
- `useProviderGovernance`: 200 governed/ungoverned؛ 404⇒null؛ رمي شبكي⇒null؛ payload مشوّه⇒null.
- `GovernanceBadge`: يعرض pill governed/ungoverned بالنص الصحيح؛ null⇒لا DOM؛ tooltip يختلف بـenforced؛ RTL (ar) سليم.
- تحقّق حيّ ميداني: 3 جلسات (codex/claude/hermes) على nassaj.alkindy.tech بعد safe-restart.

---

## 8. مخاطر وقرارات مالك

- **(م-1) انحراف opencode غير مُنفَذ:** opencode governed=true بصمةً لكنه غير مُلزَم (رابط، بلا حارس). الشارة صادقة (`enforced:false` + tooltip «حاضر لا مُنفَّذ»)، لكن قرار المالك: هل نعرض opencode «محكوم» أصلاً قبل حارس فعلي، أم `enforced:false` كافٍ؟
- **(م-2) نافذة الإصلاح الذاتي:** قد تُظهر الشارة ungoverned لحظة، ثم يُصلح spawn الحوكمة ويعمل governed. الشارة صادقة وقت القراءة؛ لا بثّ لحظي في MVP. مقبول أم يلزم WS؟ (قرار مالك، غير حاجب لـMVP).
- **(م-3) claude فحص وجود لا بصمة:** مصدر claude = NASSAJ.md الكامل (متغيّر، بلا مصدر محايد ثابت) فلا بصمة تُفرض؛ «محكوم» = حاضر. أضعف من codex لكنه صادق (`enforced:false`).
