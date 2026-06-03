# PHASE-SYNC-V133 — مزامنة upstream (siteboon/claudecodeui v1.32.0 → v1.33.0)

> **الحالة:** **معتمد بشروط — رُفع فيتو qa-critic بعد مراجعة ثانية، 2026-06-03** — مخطّط، لم يُعتمد التنفيذ بعد (خطة توثيق فقط).
> **التاريخ:** 2026-06-03 (نسخة منقّحة — مراجعة ثانية)
> **المالك:** i.rukhaimi
> **النطاق:** سدّ فجوة `nassaj-dev` مع upstream `siteboon/claudecodeui` من **v1.32.0 → v1.33.0** (15 commit).

---

## ⚠️ سبب التنقيح (Why this revision)

النسخة السابقة رُفضت بفيتو من **qa-critic** بسبب **عيب منهجي في قياس التعارضات**:

- التقدير السابق استخدم `git merge-tree <parent> main <commit-مفرد>`. لكن **merge-base بين `main` والـ commit المفرد هو v1.32.0** (commit `10f721c` = "chore(release): v1.32.0")، فأظهرت المحاكاة تعارضات **الموجة كاملة** منسوبةً خطأً للـ PR المفرد.
- النتيجة: عمودا "نتيجة محاكاة الدمج" و"CLEAN" في النسخة السابقة **باطلان كلياً**.

> **تحديث (إعادة تفعيل Antigravity — بعد إتمام المزامنة):** التعطيل المؤقت بـ `DisabledProvider` المُوصَّف أدناه **أُلغي**. أُعيد تفعيل Antigravity فوق طبقة `provider-models` الجديدة عبر `antigravity-models.provider.ts` + `antigravity-catalog.client.ts`: كتالوج موديلات **حيّ** من نقطة CloudCode (نفس ما يستدعيه `agy`) مع **fallback متدرّج** عند فشل التوكن/الشبكة، محميّ بـ abort timeout + circuit breaker. نتيجة الـ fallback تُعلَّم `degraded` فتُخزَّن في كاش `provider-models` بـ TTL قصير (5 دقائق) بدل 3 أيام، فيُعاد الجلب الحيّ سريعاً. الأقسام التالية التي تصف Antigravity كـ "معطّل" تُقرأ بوصفها سياق المزامنة التاريخي.

**تحريرات المراجعة الثانية (qa-critic — شرط رفع الفيتو، 2026-06-03):** ثلاث تصحيحات دقّة نصية بلا تغيير بنيوي:
> 1. تحديد آلية تعطيل Antigravity كـ `DisabledProvider` stub (لا حذف تسجيل) لأن `resolveProvider` يرمي `UNSUPPORTED_PROVIDER` — §تعطيل Antigravity. **(تاريخي — أُعيد التفعيل لاحقاً، انظر تحديث إعادة التفعيل أعلاه.)**
> 2. تصحيح عدد تعارضات #804 من 1 إلى **2 ملف** (إضافة `AgentsSettingsTab.tsx`) — جدول التعارضات + موجة 2.
> 3. توضيح بقاء حالتي `provider='agy'` في `isolation.e2e.test.ts` ضمن gate الانحدار — §Gates.

**ما أُثبت بأرقام حقيقية في هذه النسخة (rebase/cherry-pick تجريبي تسلسلي على worktree مؤقت `/tmp/sync-trial`، أُزيل بالكامل بعد القياس — لا أثر في `main` أو working tree):**

| القياس | النتيجة الحقيقية |
|---|---|
| `git merge-tree --write-tree main upstream/main` (الموجة كاملة) | **37 ملف متعارض** (منها modify/delete واحد على `shared/modelConstants.js`) |
| cherry-pick تسلسلي للـ 15 commit | التعارضات **تتركّز في #762** (30 ملف)؛ بقية الـ 14 commit ≤ 2 ملف لكل واحد |
| #594 (الذي ادّعى التقدير السابق أنه CLEAN، وادّعى qa-critic أنه ~10 تعارضات) | **CLEAN فعلاً** — يلمس ملفاً واحداً فقط (`plugin-websocket-proxy.service.ts`، 4 أسطر)؛ ادعاء الـ ~10 تعارضات كان هو الآخر artifact من نفس merge-tree المعطوب |

> **ملاحظة منهجية مثبتة:** نقطة الانفصال (merge-base) = `10f721c` = إصدار **v1.32.0** بالضبط. الوسم `v1.32.0` (`83c338e`) كائن وسم منفصل يشير لنفس الإصدار. الـ fork **متقدّم 21 / متأخّر 15**.

---

## الهدف (Goal)

سدّ الفجوة بترقية القاعدة من **v1.32.0** إلى **v1.33.0** عبر دمج **15 commit** تدريجياً per-PR، بترتيب تسلسلي مُحقَّق فعلياً.

> PR **#715** (DB-driven) **مدموجة مسبقاً**، والـ fork مبني فوق **v1.32.0**.

---

## القرارات المعتمدة من المالك (Owner Decisions)

| # | القرار | التفصيل | الأثر |
|---|--------|---------|-------|
| 1 | **Antigravity** | يُعطَّل مؤقتاً **fail-safe** (لا مجرد إخفاء UI) عند نقطة واحدة في `provider.registry`. تفصيل في §تعطيل Antigravity. | يوفّر 1–2 يوم الآن. |
| 2 | **Cursor** | يُضاف (#804). | ميزة جديدة. |
| 3 | **OpenCode / Codex (#762)** | تُدمج طبقة `provider-models` كاملة + المزوّدان. | الأساس + بؤرة التعارض. |
| 4 | **سياسة تزامن مستقبلية** | متكرّر صغير مع كل minor release. | منع تراكم الديون. |

---

## جدول التعارضات الحقيقي التراكمي (Cumulative Conflict Table)

> **المصدر:** cherry-pick تسلسلي فعلي بالترتيب الزمني لـ upstream على worktree مؤقت. العمود = عدد الملفات المتعارضة **عند تلك الخطوة بالذات** بعد دمج كل ما قبلها. عمود "CLEAN" حُذف نهائياً.

| الخطوة | commit | PR | الوصف | **ملفات متعارضة (تسلسلي)** | الملفات المتأثرة |
|---|---|---|---|---|---|
| **1** | `374e9de` | #762 | OpenCode + تجريد `provider-models` | **30** + modify/delete | `server/index.js`, `modules/database/index.ts`, `project-management.service.ts`, `projects-with-sessions-fetch.service.ts`, `provider.routes.ts`, `session-synchronizer.service.ts`, `chat-websocket.service.ts`, `shared/types.ts`, **`shared/modelConstants.js` (modify/delete)**, `useChatComposerState.ts`, `useChatProviderState.ts`, `ChatInterface.tsx`, `ChatMessagesPane.tsx`, `MessageComponent.tsx`, `ProviderSelectionEmptyState.tsx`, `useSessionsSource.ts`, `SessionProviderLogo.tsx`, `mcp/constants.ts`, `AgentConnectionsStep.tsx`, `provider-auth/types.ts`, `settings/constants.ts`, `AgentListItem.tsx`, `AgentsSettingsTab.tsx`, `AgentSelectorSection.tsx`, `AccountContent.tsx`, `sidebar/utils.ts`, `useProjectsState.ts`, `en/chat.json`, `en/settings.json`, `types/app.ts` |
| **2** | `997cf9f` | #804 | Cursor model | **2** | `ProviderSelectionEmptyState.tsx`, `AgentsSettingsTab.tsx` |
| **3** | `3b79aab` | #806 | fallback models for claude | **CLEAN (0)** | — |
| **4** | `295bad9` | #793 | star button location | **1** | `SidebarProjectItem.tsx` |
| **5** | `27e509a` | #782 | tooltip + i18n (أضف `ar`) | **1** | `SidebarSessionItem.tsx` |
| **6** | `951f587` | #781 | session rename input visible | **1** | `SidebarSessionItem.tsx` |
| **7** | `8694809` | #808 | group plugin settings (أضف `ar`) | **CLEAN (0)** | — |
| **8** | `38bf21d` | #807 | refine token usage reporting | **1** | `server/claude-sdk.js` |
| **9** | `dbc41dc` | #719 | منع الإرسال المزدوج (موبايل) | **CLEAN (0)** | — |
| **10** | `1e125f3` | #617 | refresh claude auth after login | **1** | `claude-auth.provider.ts` |
| **11** | `36b860e` | #594 | preserve WS frame type | **CLEAN (0)** | — (يلمس `plugin-websocket-proxy.service.ts` فقط، 4 أسطر) |
| **12** | `f132a21` | #815 | router basename root prefix | **1** | `src/App.tsx` |
| **13** | `b988e0d` | — | chore(release): v1.33.0 | **2** | `package.json`, `package-lock.json` (bump إصدار فقط) |
| **14** | `43c33d5` | #818 | recognize claude auth token env | **CLEAN (0)** | — |
| **15** | `d9e9df1` | #817 | plugin svg sanitization (XSS) | **CLEAN (0)** | — |

**الخلاصة الكمية:** 99٪ من جهد الدمج في **#762**. الباقي تعارضات سطحية بسطر/ملف واحد، وأربعة commits نظيفة تماماً + الإصدار (lockfile bump).

> **مفاجآت الـ rebase التجريبي:**
> 1. #762 وحده يستهلك 30 ملف — ليس "97 hunk معظمها accept-both" كما زعمت النسخة السابقة. **97 hunk فيها مراجعة يدوية إلزامية، لا accept-both افتراضي** (§موجة 4).
> 2. #594 و#818 و#817 و#719 و#806 و#808 = **نظيفة تماماً تسلسلياً** بعد امتصاص #762 للموجة.
> 3. `package.json/lock` لا يتعارضان إلا في commit الإصدار `b988e0d` (الخطوة 13)، لا قبله — لأن #762 لا يبدّل رقم الإصدار.

---

## موجة 0 — التجهيز (إلزامي قبل أي دمج)

### 0.1 العمل المحلي غير المُلتزَم — **مكتمل، يتبقّى الالتزام**

الحالة الفعلية (`git status`): **10 ملف معدّل + 5 untracked**. الـ 21 commit المتقدّمة **دُفعت للريموت فعلاً** (origin/main محدَّث = نسخة أمان على الريموت). يتبقّى التزام العمل المحلي في commits منطقية:

| المجموعة | الملفات |
|---|---|
| WS/SDK race fix | `server/claude-sdk.js`, `chat-websocket.service.ts`, `websocket-server.service.ts` |
| استبعاد جلسات subagents | `claude-session-synchronizer.provider.ts` |
| تصليب AuthContext | `src/components/auth/context/AuthContext.tsx` |
| live participants polling | `src/components/participants/hooks.ts` |
| UI sidebar / QuickSettingsHandle | `AppContent.tsx`, `QuickSettingsHandle.tsx` |
| توثيق | `PROJECT_PLAN.md`, `docs/workitems/PHASE-PK.md`, `CHANGES.md` |

### 0.2 الاستبعادات والتنظيف (Exclusions)

- `package.json.bak-pre-sdk-upgrade` + `package-lock.json.bak-pre-sdk-upgrade` (غير متتبَّعة) → **حذف**. شاهد على ترقية الـ fork لـ `claude-agent-sdk` (commit `b455706` → 0.3.152) → مهم لسياسة الـ lockfile (§0.5 / Gates).
- `server/modules/providers/list/antigravity/antigravity-token-reader.ts` (يتيم، **غير مستورَد في أي مكان** — تحقّقتُ بـ `git grep`) → **استبعاد/حذف** ضمن مسار تعطيل Antigravity.

### 0.3 النسخ الاحتياطي ونقطة الأمان

```bash
git tag backup/pre-upstream-v1.33 HEAD
cp /home/nassaj/.cloudcli/auth.db /home/nassaj/backups/nassaj-dev/auth.db.pre-v133.$(date +%Y%m%d-%H%M%S)
```

> origin/main محدَّث الآن (نسخة أمان ثانية على الريموت).

### 0.4 فرع العمل

```bash
git checkout -b chore/sync-upstream-v1.33
```

> **تحذير parallel sessions:** قد تعمل جلسة Claude أخرى على نفس working tree — تحقّق من `git status` قبل أي التزام.

### 0.5 baseline اختبارات — **gate جديد إلزامي**

```bash
npm test 2>&1 | tee /tmp/baseline-tests-pre-v133.txt
```

سجّل النتيجة الكاملة. **معلوم مسبقاً:** `mcp.test.ts` **فاشل قبل الدمج**. يُسجَّل في الـ baseline ولا يُحتسب ضده. القاعدة: **لا اختبار ينتقل من ناجح → فاشل** (انظر Gates).

---

## بيئة الاختبار — **منفصلة عن الإنتاج (إلزامي)**

الإنتاج: `nassaj-dev.alkindy.tech:3004` (PM2). الاختبار **لا يلمسه**:

| المورد | الإنتاج | الاختبار |
|---|---|---|
| المنفذ | 3004 | **3005** (مستقل) |
| قاعدة البيانات | ملف الإنتاج | **نسخة DB منفصلة** (نسخ ملف SQLite اختباري) |
| العملية | PM2 الإنتاج | **عملية مستقلة** (PM2 باسم مختلف أو تشغيل مباشر خارج PM2) |

أي تشغيل فعلي للموجات يكون على :3005 + DB اختبار، لا على :3004.

---

## الموجات — rebase/cherry-pick تدريجي per-PR (لا merge كتلي)

> الترتيب يتبع التسلسل الزمني المُحقَّق في upstream. بعد كل خطوة تعارض محلولة: **commit فوري + build** (نقطة استرجاع).

### موجة 1 — الأساس عالي الخطر: #762 (model layer)

**الخطوة 1 وحدها = 30 ملف متعارض + modify/delete.** تُقسَّم إلى خطوات فرعية مع commit بعد كل خطوة:

| الخطوة | الوصف |
|---|---|
| **1a** | دمج الملفات الإضافية الصرفة (`opencode/*`, `codex/*`, `*-models.provider.ts`, `provider-models.service.ts`). commit. |
| **1b** | **معالجة modify/delete على `shared/modelConstants.js`** (§أدناه — لا قبول صامت للحذف). commit. |
| **1c** | حل `provider.registry.ts` + `provider.routes.ts` بـ **مراجعة يدوية لكل hunk** (لا accept-both افتراضي — ملفات الـ fork الكثيفة). commit. |
| **1d** | **تعطيل Antigravity fail-safe** بتسجيل `DisabledProvider` stub تحت مفتاح `antigravity` (لا حذف التسجيل — انظر الآلية في §تعطيل Antigravity). commit. **(تاريخي — لاحقاً أُعيد تفعيل Antigravity فوق طبقة provider-models بكتالوج حيّ + fallback؛ انظر تحديث إعادة التفعيل أعلى الملف.)** |
| **1e** | حل بقية ملفات chat/settings/sidebar/i18n الـ 30. commit. build. |

#### معالجة modify/delete على `shared/modelConstants.js` (بند صريح)

- **#762 يحذف** `shared/modelConstants.js`؛ والـ fork **يعدّله** في commitين: `78d9d0d` (Phase-MU) و `1fa4098` (Antigravity/RTL). (مؤكَّد بـ `git log`.)
- **الإجراء الإلزامي:** قبل قبول الحذف:
  1. استخرج إضافات الـ fork في الملف (`git diff 10f721c..main -- shared/modelConstants.js`).
  2. انقلها إلى طبقة `provider-models` الجديدة (الموديلات تُعرَّف عبر `*-models.provider.ts`).
  3. اختبار تحقق يثبت أن الموديلات المنقولة تظهر فعلياً في القوائم.
  4. **عندها فقط** اقبل حذف `modelConstants.js`. **لا قبول صامت.**

### موجة 2 — Cursor + fallback models (تعتمد على موجة 1)

| الخطوة | commit | PR | تعارض حقيقي |
|---|---|---|---|
| 2 | `997cf9f` | #804 | 2 ملف (`ProviderSelectionEmptyState.tsx`, `AgentsSettingsTab.tsx`) |
| 3 | `3b79aab` | #806 | CLEAN |

> **تصحيح ترتيب موجة 4 السابق:** الترتيب الزمني الصحيح في upstream هو **762 → 804 → 806** (لا 806 قبل 804). تبعية 762 → {804, 806} مؤكَّدة. (#806 fallback models يعتمد على طبقة 762؛ #804 Cursor يضيف مزوّداً فوقها.)

### موجة 3 — UX / Sidebar / i18n

| الخطوة | commit | PR | تعارض حقيقي | ملاحظة |
|---|---|---|---|---|
| 4 | `295bad9` | #793 | 1 (`SidebarProjectItem.tsx`) | تجميلي |
| 5 | `27e509a` | #782 | 1 (`SidebarSessionItem.tsx`) | **أضف ترجمة `ar`** |
| 6 | `951f587` | #781 | 1 (`SidebarSessionItem.tsx`) | — |
| 7 | `8694809` | #808 | CLEAN | **أضف ترجمة `ar`** |
| 9 | `dbc41dc` | #719 | CLEAN | منع الإرسال المزدوج |

### موجة 4 — token usage + auth + router (متوسط/منخفض)

| الخطوة | commit | PR | تعارض حقيقي | ملاحظة |
|---|---|---|---|---|
| 8 | `38bf21d` | #807 | 1 (`claude-sdk.js`) | يحذف `TokenUsagePie` لصالح `TokenUsageSummary` — مراجعة يدوية للـ hunk |
| 10 | `1e125f3` | #617 | 1 (`claude-auth.provider.ts`) | — |
| 12 | `f132a21` | #815 | 1 (`src/App.tsx`) | — |

### موجة 5 — الإصدار + أمني (نظيف تقريباً)

| الخطوة | commit | PR | تعارض حقيقي | ملاحظة |
|---|---|---|---|---|
| 13 | `b988e0d` | — | 2 (`package.json` + lock) | **سياسة lockfile**: `git checkout --theirs package.json && npm install` (لا accept-either) — الـ fork رقّى `claude-agent-sdk` |
| 14 | `43c33d5` | #818 | CLEAN | recognize claude auth token env (قيمة عالية) |
| 15 | `d9e9df1` | #817 | CLEAN | plugin svg sanitization (XSS — قيمة أمنية) |

---

## تعطيل Antigravity — **fail-safe routing (لا مجرد إخفاء UI)**

> **تاريخي:** هذا القسم يصف التعطيل المؤقت أثناء المزامنة فقط. **أُعيد تفعيل Antigravity** فوق طبقة `provider-models` بكتالوج حيّ + fallback متدرّج (`degraded` ⇒ TTL قصير). انظر «تحديث إعادة التفعيل» أعلى الملف.

**البصمة:** `git grep -il antigravity` = **58 ملف**، منها routing حساس **مؤكَّد**:
`provider.registry.ts`, `provider.routes.ts`, `chat-websocket.service.ts`, `session-synchronizer.service.ts`, `resolve-provider-env.js`, `useChatProviderState.ts`, `useSessionsSource.ts`.

**المبدأ:** التعطيل عند **نقطة واحدة في `provider.registry`** ترجع مساراً آمناً، لا أخطاء runtime ولا إخفاء UI سطحي يترك المسارات الخلفية فعّالة.

**القيد التقني الحاسم (Why a stub, not deletion):**

- `resolveProvider` في `server/modules/providers/provider.registry.ts` (حوالي السطر 29–40) **يرمي `AppError(statusCode: 400, code: UNSUPPORTED_PROVIDER)`** لأي مفتاح غير موجود في الـ registry.
- لذا **مجرّد حذف سطر تسجيل** `antigravity: new AntigravityProvider()` **لا يحقّق fail-safe** — بل يُنتج **throw 400** على مسار resume لجلسات `agy` القائمة في DB. المستدعون المتأثرون مؤكَّدون: `session-synchronizer.service.ts:67`, `sessions.service.ts:88`, `sessions.service.ts:110`. وهذا **يخالف معيار القبول** ("لا خطأ runtime، تظهر معطّل مؤقتاً").

**الآلية المطلوبة (Mechanism):**

- **الخيار المفضّل:** **تسجيل `DisabledProvider` stub تحت مفتاح `antigravity`** في `provider.registry` — يبقى المفتاح مسجَّلاً فلا يُرمى `UNSUPPORTED_PROVIDER`، ويرجع الـ stub حالة "معطّل مؤقتاً" بشكل **graceful** على كل عمليات المزوّد بدل تنفيذها.
- **البديل (إن تعذّر الـ stub):** **التقاط `UNSUPPORTED_PROVIDER` صراحةً عند مواقع الاستدعاء على مسار الجلسات** (`session-synchronizer.service.ts:67`, `sessions.service.ts:88,110`) وتحويله إلى حالة "معطّل مؤقتاً" بدل تمرير الخطأ.

**fail-safe routing لجلسات agy (بند صريح):**

- **السؤال الحرج:** ماذا يحدث لجلسات `agy` القائمة في DB عند `resume`؟
- **المطلوب:** عند طلب provider = `antigravity`/`agy` (سواء من جلسة DB قائمة أو request جديد)، يرجع `provider.registry` عبر الـ `DisabledProvider` stub **مساراً معطّلاً بأمان** ("المزوّد معطّل مؤقتاً") **بدلاً من throw `UNSUPPORTED_PROVIDER` / undefined provider**. الجلسات القائمة تُعرَض كـ معطّلة، لا تُسقِط الواجهة ولا تُنتج 400/500.
- **معيار القبول (مرتبط مباشرةً بالآلية أعلاه):** resume لجلسة agy قائمة عبر `session-synchronizer.service.ts` / `sessions.service.ts` لا يُنتج خطأ runtime ولا `UNSUPPORTED_PROVIDER`؛ يظهر للمستخدم حالة "معطّل مؤقتاً".
- نقطة إعادة التفعيل **نُفِّذت** عبر `antigravity-models.provider.ts` + `antigravity-catalog.client.ts` فوق طبقة `provider-models` الجديدة (كتالوج حيّ + fallback `degraded` بـ TTL قصير). انظر «تحديث إعادة التفعيل» أعلى الملف.
- `antigravity-token-reader.ts` اليتيم → يُحذف ضمن هذا المسار.

---

## بوابات بعد كل موجة (Gates — منقّحة)

بعد **كل** موجة:

1. **Build:** `npm run build` ينجح. (`server/services/isolation` = boundaries element في eslint.)
2. **اختبارات + gate عدم الانحدار:**
   - `npm test` ويُقارَن بـ baseline موجة 0.
   - **gate صارم: لا اختبار ينتقل من ناجح → فاشل.** (`mcp.test.ts` فاشل مسبقاً → مستثنى من المقارنة، لكنه لا يُسمح بفشل جديد.)
   - isolation e2e (14/14)، auth integration.
   - **المستثنى = اختبارات وظيفة Antigravity فقط** (المزوّد معطّل). أمّا `server/services/isolation/isolation.e2e.test.ts` (المطلوب بقاؤه 14/14) فيحوي حالتي `provider='agy'` (حوالي السطرين 199 و208) تختبران **isolation seam المستقل عن تفعيل المزوّد** — لذا **تبقيان ضمن gate الانحدار** ولا تُستثنيان. تُعدَّلان صراحةً فقط مع توثيق السبب إن لزم تقنياً.
3. **lockfile:** عند تعارض package.json → `git checkout --theirs package.json && npm install` (يعيد توليد lock نظيفاً)، **لا accept-either**.
4. **تشغيل فعلي:** على **المنفذ 3005 + DB اختبار + عملية مستقلة** — **لا الإنتاج (3004)**.
5. **commit + build داخل الموجة** عند كل نقطة تعارض محلولة (نقطة استرجاع).

---

## التراجع (Rollback — أقوى)

| المستوى | الإجراء |
|---|---|
| **per-خطوة** | كل تعارض محلول = commit مستقل → `git reset --hard HEAD~1` يرجع خطوة واحدة |
| **per-موجة** | `git reset --hard <tag/commit آخر موجة ناجحة>` |
| **شامل** | `git reset --hard backup/pre-upstream-v1.33` + استعادة نسخة DB |
| **الريموت** | `origin/main` محدَّث (نسخة أمان مدفوعة) |

---

## بنود مفتوحة / مخاطر

| البند | الحالة / التخفيف |
|---|---|
| **#762 بؤرة الخطر** | 30 ملف؛ مقسَّم 1a–1e مع commit/build بعد كل خطوة. |
| **modelConstants.js modify/delete** | معالَج صراحةً (نقل لطبقة provider-models قبل قبول الحذف + اختبار). |
| **migrations** | لا migration upstream في الـ 15 commit. خطر مستقبلي إن أعاد upstream بناء `sessions`/`users`. التخفيف: نسخة DB دائماً. |
| **RTL مقابل i18n** | لا تعارض (RTL toggle مستقل عن اللغة). |
| **إعادة تفعيل Antigravity** | **منجَز** — فوق طبقة `provider-models` عبر `antigravity-models.provider.ts` + `antigravity-catalog.client.ts` (كتالوج حيّ + fallback `degraded` بـ TTL قصير). |
| **claude-agent-sdk** | الـ fork رقّاه (`b455706`)؛ سياسة lockfile تحفظه عبر `--theirs package.json` + `npm install`. |

---

## ترتيب التنفيذ (Execution Order)

```
موجة 0 (commits محلية + حذف bak + tag + branch + baseline npm test)
   ↓
موجة 1 (#762: 1a→1b→1c→1d→1e، model layer + modelConstants + Antigravity fail-safe)  →  Gate
   ↓
موجة 2 (#804 Cursor → #806 fallback)  →  Gate
   ↓
موجة 3 (#793 → #782 → #781 → #808 → #719: sidebar/i18n/ar)  →  Gate
   ↓
موجة 4 (#807 token → #617 auth → #815 router)  →  Gate
   ↓
موجة 5 (v1.33.0 release + #818 + #817)  →  Gate
```
