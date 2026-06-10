# حالة المشروع — nassaj-dev

> آخر تحديث: 2026-06-10

## الحالة الراهنة
✅ المراحل (0→4) single-user مكتملة. 🟢 **شريحة B-MU-UX (عزو/حضور) مكتملة + دفعة UI/إصلاحات 2026-06-10** (أبرزها إصلاح عزو رسائل المستخدم B-MU-UX-FIX-MSG-AUTHOR). 🟢 **ميزة Passkey/WebAuthn منفَّذة كاملة (ADR-026)**. 🟡 **مرحلة Multi-User (Phase-MU): طبقة التفعيل V1 معتمدة (ADR-023، 2026-06-08) — بوابة-0 تالية؛ التفعيل الإنتاجي محجوب بالتحقق القانوني (ToS) + PDPL**. 🟢 **مرحلة SR-0 (Session Recovery, non-claude): شريحة الترميز + التحصينات مكتملة، فيتو qa-critic مرفوع (202/0)**؛ **العلم مُطفأ**؛ **التفعيل الإنتاجي مسموح بعد بوابة B-N-DRAIN فقط** (ADR-021/022 معتمدة 2026-06-06؛ آخر commits: 1631f87/423f2b8/42d0b46).

## مرحلة SR-0 — Session Recovery (non-claude) — 🟢 مكتملة ومحصَّنة، فيتو مرفوع / تفعيل بعد B-N-DRAIN فقط
القرار معتمد: **ADR-021** (Session Survival & Replay، + Amendment تحصينات ما بعد المراجعة 2026-06-06، **فيتو qa-critic مرفوع 2026-06-06**) + **ADR-022** (PM2 + SIGTERM drain). التفاصيل: `docs/workitems/PHASE-SR-0.md`.
- **المشكلة:** `pm2 restart` يقتل جلسات agy النشطة + بثّ الحالة pull لا push.
- **القرار:** لا فصل worker (مستحيل لـ claude/codex — SDK يملك الابن). البديل: **graceful drain** للنشر + **replay buffer** للاسترداد، لـ **non-claude فقط** (agy→codex) خلف `SESSION_REGISTRY_<P>`.
- **✅ slice الترميز (مدموج، مجتاز بوابة الدمج):** B-N5 (connectionId→rekey) + B-N7 (مصدر active موحَّد) + B-N-ATTACH (replay تفاضلي قراءة فقط، بلا swap writer) — خلف `SESSION_REGISTRY_agy` (العلم **مُطفأ افتراضياً**).
- **✅ تحصينات ما بعد المراجعة (architect + backend-dev + tester + qa-critic، 2026-06-06 — مكتملة، فيتو مرفوع 202/0):**
  - **B-N-DROP** (دورة حياة البفر، دمج B-N-EVICT + B-N-RESUME): `BUFFER_RETENTION_MS=120000` (drop مؤجَّل بـ`setTimeout.unref`) + `MAX_LIVE_SESSIONS=200` (LRU لغير النشطة فقط) + `RING_CAPACITY=2000`؛ resume = drop-then-open (بفر نظيف)؛ `lastSeq` غياب/غير رقمي → 0 = التشغيل الحالي فقط.
  - **B-N7 (إتمام):** إسقاط fallback `|| activeSessions.has()` عند تفعيل العلم + حذف فرع rekey-onto-existing → `throw` صريح.
  - **✅ اختبار التكامل agy↔registry الحقيقي** (كان شرط فيتو) — منفَّذ ومجتاز (commit 42d0b46).
- **🟢 فيتو qa-critic مرفوع (2026-06-06):** بعد إعادة المراجعة فوق commitَي التحصينات (423f2b8 backend-dev، 42d0b46 tester) — البنود الخمسة (دورة الحياة، RESUME، اختبار التكامل الحقيقي، B-N7، عدم الانحدار) **مغلقة، 202/0**. **التفعيل الإنتاجي مسموح بعد B-N-DRAIN فقط.**
- **🟠 بوابة النشر (الوحيدة الحاجبة للتفعيل):** **B-N-DRAIN** فقط (drain موقوت + `kill_timeout` PM2)؛ بقية البنود مغلقة.
- **🗂️ مؤجَّل (بوابة قبل codex):** **B-N-PORT** — استخراج `ProviderSessionPort` (تجريد stdout/PID لـagy مقابل SDK لـcodex) شرط مسبق إلزامي لأي عمل codex (يمنع نسخ فرع antigravity مرة رابعة).
- **🗒️ backlog (تحسين، غير حاجب):** (1) **تسرّب مؤقّت drop ثانوي** عند طرد `_enforceCap` لإدخال غير نشط (≤200 مؤقّت، `.unref`، ذاتي التنظيف) — يُربَط طرد السجل بإلغاء المؤقّت لاحقاً؛ (2) **فرع rekey المملوء ميت إنتاجياً** (حارس دفاعي مقبول).
- **حقن RingBuffer:** عند `agy-cli.js:461` (`safeSend(stream_delta)`)، **لا** `normalizeMessage` (طبقة ميتة تُرجع `[]`).
- **خارج النطاق (فيتو باقٍ):** claude (B-N1/B-N6) + drain-lock الكامل (B-N3/B-N4).
- **التالي:** تنفيذ **B-N-DRAIN** ثم تفعيل `SESSION_REGISTRY_agy` إنتاجياً؛ بعدها **B-N-PORT** قبل أي عمل codex.

## مرحلة Multi-User (Phase-MU) — 🟡 مخطّطة ومعتمدة، بوابة-0 تالية
القرارات معتمدة (ADR-014..017 في `~/.claude/alkindy/decisions/`) + **ADR-023** (طبقة التفعيل V1، معتمد 2026-06-08). التفاصيل: `docs/workitems/PHASE-MU.md`.

**🟡 طبقة التفعيل V1 — عزل الاشتراك (ADR-023):** مخطّطة ومعتمدة — **بوابة-0 تالية**؛ **التفعيل الإنتاجي محجوب بالتحقق القانوني (ToS) + موافقة PDPL** (B-MU-LEGAL + B-MU-PDPL، حاجبان للإطلاق العلني فقط لا للعمل الداخلي).
- **الحكم:** البنية مبنية ~80%؛ **مسار chat/SDK سليم** (`claude-sdk.js:784`، عملية `claude` فرعية بـenv خاص per-user → التزامن محلول)؛ **العطل في مسار PTY فقط**.
- **القرارات الأربعة المحسومة:** (1) BYO OAuth Pro/Max per-user (عزل=فوترة، ToS داخلي مقبول)؛ (2) تصليب OS «وثّق واقبل» (uid واحد + 0600/0700 + audit، لا container)؛ (3) MCP/أدوات/ملفات مشتركة بالكامل؛ (4) onboarding PTY مُصلَّح لـV1 ← توكن مشفّر في DB تالياً.
- **تصحيحان موثّقان:** الافتراضي فعلاً `provider-sharing.js:38 → claude:'isolated'` (يُؤكَّد وقت التشغيل في بوابة-0)؛ SDK = `0.3.152` (يُثبَّت بدقّة).
- **المسار الحرج (V1):** بوابة-0 (TOS/ENVINV/DEFAULT/SDKPIN) → م1 سدّ ثغرتي PTY → م2 تفعيل العزل (flip + E2E) → م3 حوكمة+تصليب ∥ م4 onboarding+تزامن+امتثال.
- **التالي:** بوابة-0 (لا كود قبلها) — قراءة فقط، لا يُعدَّل `ecosystem.config.cjs` (قيم env تُسلَّم للمستخدم).

**🟢 شريحة B-MU-UX — طبقة العزو والحضور (UX layer): مكتملة (2026-06-10).** جعلت مساحة العمل **المشتركة بالقصد** (إخوة، ثقة كاملة، وصول كامل) **مقروءة** — **رؤية/عزو لا عزل**. نُفِّذت كاملة (7 commits ميزات a54dd04→b24c7b1): `B-MU-UX-API` → شارة المالك ∥ هويّة منسّق/وكيل ∥ فلتر «مشاريعي/الكل»؛ حضور لحظي؛ هويّة git per-user؛ إصلاحا المرآة (B-5) وتدوير التوكن (B-6). التفاصيل: `docs/workitems/PHASE-MU.md` (قسم B-MU-UX).
- **ملاحظة التصميم:** مساحة مشتركة بالقصد؛ الدفع per-user يتراجع **للحساب المشترك** عند غياب توكن المستخدم.

**🟢 دفعة UI/إصلاحات 2026-06-10 (امتداد الشريحة) — مكتملة عدا بند معلّق.** التفاصيل: `docs/workitems/PHASE-MU.md` (قسم الدفعة):
- **B-MU-UX-FIX-MSG-AUTHOR (الأهم):** إصلاح عزو رسائل المستخدم — الخادم يختم كل رسالة مستخدم بـ`userId` المُرسِل (جدول sidecar ‏`message_authors` بمطابقة hash؛ transcript الـCLI لا يُمَس) ويبثّها في WS والتاريخ؛ الواجهة تعرض أفاتار المؤلّف الحقيقي وتفصل تجميع الفقاعات عند اختلاف المؤلف؛ مؤلف مجهول = أفاتار محايد ‏(437a8f3 + 5b84e8d).
- **تحسينات UX:** اعتمادات Claude/Antigravity إلى صفحة Agents ‏(73c7fa5)؛ فلتر «مشاريعي/الكل» بدل تبويبَي الشريط ‏(16dd566 — ⚠️ قيد: لا مدخل واجهة للبحث العابر للمشاريع حالياً، endpoint باقٍ)؛ لوحة حضور أفاتارات متراكبة ‏(75cb132)؛ تمرير `avatarUrl` لكل أماكن العزو ‏(d4501b2)؛ شريط المشاركين ظاهر افتراضياً ‏(1b7d775)؛ حالة فراغ إرشادية للوحة المشروع + زر نسخ skeleton — تشخيص «no project state file» ليس باگ ‏(e75af2b).
- **⏸️ معلّق (بانتظار قرار تصميمي):** الثيمات في Appearance (C-MU-UX-THEMES/T-31) — لا ثيمات موجودة مسبقاً؛ يلزم Design Brief من ui-designer لتعريف لوحات الألوان قبل التنفيذ.
- **تشغيلياً:** تغييرات الخادم ‏(437a8f3، d4501b2) تتطلب `pm2 restart nassaj-dev --update-env` **ينفّذه المستخدم بطرفيته** (حارس العميل).

## ميزة Passkey/WebAuthn — 🟢 منفَّذة كاملة (2026-06-10، ADR-026)
خطة architect المعتمدة **B-PK-1..4 + C-PK-1..3** منفَّذة كاملة. التفاصيل: `docs/decisions/026-passkey-webauthn.md` + `docs/workitems/PHASE-PK.md`.
- **خادم:** جدول `webauthn_credentials` + repository ‏(81948fe)؛ env ‏`WEBAUTHN_RP_ID/ORIGIN/RP_NAME` + مخزن challenge في الذاكرة TTL ‏5 دقائق ‏(a55e0d5)؛ خدمة + مسارات `/api/auth/webauthn` — تسجيل مصادَق، دخول عام discoverable credentials **بنفس عقد `/login`**، rate-limit، audit، ‏`@simplewebauthn/server@13.3.1` ‏(8c142cf).
- **واجهة:** زر «الدخول بمفتاح مرور» في LoginForm + طبقة `@simplewebauthn/browser` ‏(d72a38e)؛ قسم إدارة المفاتيح في Profile ‏(9c1fe98).
- **الاختبارات:** suite الخادم خضراء 283+15 (منها +21 جديدة).
- **قيود معروفة:** challenge في الذاكرة (عملية واحدة)؛ rpID مثبّت على النطاق؛ fallback كلمة المرور باقٍ.
- **تشغيلياً:** يتطلب `pm2 restart nassaj-dev --update-env` ينفّذه المستخدم بطرفيته؛ ‏`WEBAUTHN_*` مضبوطة في `ecosystem.config.cjs`.

**البنية الأساسية (Phase-MU الكاملة):**
- **العزل:** اعتماد per-user فقط (Claude إلزامي + Gemini)؛ المحادثات/الملفات/التعليمات **مشتركة حيّاً**.
- **Auth:** مدمج داخل التطبيق، JWT stateless، invite-only، argon2id، bootstrap owner (لا proxy منفصل).
- **agy:** مشترك باعتماد المالك في V1 (عزل مؤجَّل للإنتاج).
- **التزامن:** لا قفل عام؛ قفل discovery ضيّق على brain UUID.
- **طبقة محورية:** `resolveProviderEnv(userId, provider)` مصدر الحقيقة الوحيد.
- **المسار الحرج (Auth):** C-AUTH-1→2→3 → B-ISO-RESOLVER → (B-ISO-CLAUDE ∥ B-ISO-GEMINI) → B-ISO-PROVISION → C-UI-* → M-ISO-E2E → GATE.

## شرط الانتقال للنسخة الرئيسية
- [ ] agy يعمل E2E بدون أخطاء (chat, history, abort) — **اختبر يدوياً**
- [ ] RTL يعمل في sidebar/chat/settings بدون كسر بصري — **اختبر يدوياً**
- [ ] لا regression على Claude provider — **اختبر يدوياً**
- [ ] ≥10 جلسات حقيقية على nassaj-dev بدون مشاكل حرجة — **يحتاج وقتاً**

## المراحل المكتملة

### Phase 0 — Foundation ✅
| B-01 | fork + clone | Kindi-sa/nassaj-dev (private, AGPL-3.0) |
| B-02 | package.json | name=nassaj-dev, homepage=nassaj-dev.alkindy.tech |
| B-03 | LLMProvider union | 'antigravity' في 10 ملفات |
| B-04 | PM2 ecosystem | port 3004, DATABASE_PATH مستقل |
| B-05 | Cloudflare tunnel | nassaj-dev.alkindy.tech → 127.0.0.1:3004 |

### Phase 1 — AntigravityProvider Backend ✅
| B-10 | agy-cli.js | spawn agy -p, streaming حقيقي, SIGTERM/SIGKILL |
| B-11 | antigravity-auth | فحص وجود agy + brain dir |
| B-12 | antigravity-sessions | transcript.jsonl parser |
| B-13 | antigravity-session-synchronizer | scan brain/<UUID>/ → DB |
| B-14 | antigravity-skills | stub فارغ |
| B-15 | antigravity-mcp | stub (agy عميل MCP لا خادم) |
| B-16 | antigravity.provider | Composition Root |
| B-17 | provider.registry | تسجيل AntigravityProvider |
| C-18 | chat-websocket | antigravity-command dispatch |
| C-19 | notification-orchestrator | PDPL audit log (M-56) |
| C-20 | abort logic | SIGTERM + SIGKILL بعد 5s |

### Phase 2 — Frontend Integration ✅
| C-30 | Provider selector | Antigravity (agy), ⚡ logo, emerald theme |
| C-31 | Auth badge | Connected/Disconnected via auth/status API |
| C-32 | Settings tab | CLI instructions + model info |
| C-33 | History view | generalized pipeline — لا تغيير مطلوب |
| C-34 | Sub-agent badge | Task tool_use → purple "Sub-agent" pill |

### Phase 3 — RTL Arabic ✅
| B-40 | Locale ar | 7 namespaces عربية |
| B-41 | languages.js | ar مع dir: 'rtl' |
| B-42 | i18n config | استيراد ترجمات ar |
| B-43 | RTL toggle | Appearance Settings → "RTL Layout" (مستقل عن اللغة) |
| B-44 | tailwindcss-rtl | مثبّت ومُفعَّل |
| C-45 | خطوط Tajawal | من Google Fonts، تُطبَّق عند dir=rtl |
| C-46 | LTR صريح | code editor, terminal, git diff, file paths |

### Phase 4 — Hardening ✅
| M-50 | Unit tests auth | 7 اختبار |
| M-51 | Integration test sync | 9 اختبار |
| M-53 | Schema snapshot | 13 اختبار |
| M-54 | Exit code handling | رسائل خطأ واضحة لكل كود |
| M-55 | Rate limiting | 60 req/min/IP على /api/providers/antigravity/ |
| M-56 | Audit log PDPL | metadata فقط (sessionId, exitCode, timestamp) |

**إجمالي: 29/29 اختبار ناجح**

## البيئة
- URL: https://nassaj-dev.alkindy.tech
- Port: 3004, PM2: nassaj-dev
- DB: /home/nassaj/.local/share/nassaj-dev/db.sqlite
- GitHub: Kindi-sa/nassaj-dev (private, AGPL-3.0)

## ملاحظات مهمة
- **AGPL-3.0**: أي نشر خارجي يستلزم إتاحة الكود (نسّق مع legal-compliance-advisor)
- **RTL**: اختياري من Appearance Settings → RTL Layout toggle
- **project_path لـ agy sessions**: placeholder `/__antigravity__` — لا يمكن تحديد workspace بسهولة من transcript
- **agy TTFB**: ~8 ثوانٍ طبيعي — loading indicator مطلوب في UX

## القرارات المفتوحة
- [ ] AGPL-3.0 compliance review
- [ ] antigravity sessions في per-project sidebar (تحتاج تعديل session-fetch service)
- [ ] agy model selector في Settings (حالياً يستخدم نموذج agy الافتراضي)
- [ ] RTL audit بصري كامل (C-47 — اختبار يدوي)
