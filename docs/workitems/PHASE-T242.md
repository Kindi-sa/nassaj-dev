# PHASE-T242 — مؤشّر/إشعار موثوق للعمل الخلفي (إعادة التصميم بعد فيتو qa-critic)

> طبقة الرؤية في «مشكلة B» / ADR-051 المرحلة 1.
> الحالة: تصميم (لا تنفيذ). يُراجَع بفيتو qa-critic قبل تفويض أي بند تنفيذ.
> تاريخ: 2026-06-30. يحلّ محل تصميم T-242 السابق المرفوض بمراجعة aaa570b.

---

## 0. لماذا رُفض التصميم السابق (الفيتوات الستة، ومعالجتها هنا)

| # | الفيتو (السابق) | الجذر المؤكَّد كوداً | العلاج في هذا التصميم |
|---|------|---------|----------------------|
| 1 | عتبة 180s / mtime لتمييز الحياة | `journal.jsonl` بلا timestamp لكل سطر (`{type,key,agentId}` فقط — `workflow-reconcile.service.ts:156`)؛ وكيل بطيء حيّ (177s+) لا يُميَّز عن ميّت بالـmtime | لا mtime ولا عتبة زمنية للحياة إطلاقاً. الحياة = **حياة العملية الحقيقية** عبر مصدرين مدمجين: `isClaudeSDKSessionActive(sessionId)` (`activeSessions` غير المُعلَّم) + `claudeSessionRegistry.isActive` + `countLiveMirrors`. mtime يبقى مستخدَماً فقط داخل reconcile القائم لتمييز completed/settled (لا يُمَسّ). |
| 2 | تعريف orphan غامض | — | orphan = `started ⊄ result` (journal) **و** العملية غائبة من سجلّ الحياة **و** journal هادئ ≥ `DEFAULT_QUIET_MS`. الشروط الثلاثة معاً، لا أحدها. |
| 3 | بيضة-دجاجة (العميل لا يعرف أن يستطلع بعد موت العملية) | مصدر علم العميل `complete.pendingWorkflows` يموت بموت العملية | التصنيف يُحسب **خادمياً في مسار `fetchHistory`** (يعمل والعملية ميتة، يُحسب عند فتح الجلسة). الاستطلاع/البثّ تحسين لا ضمانة. |
| 4 | المتطلَّب global، التصميم per-session | — | endpoint app-level `GET /workflows/active` يُعدّد جلسات المالك ويصنّفها — مؤشّر عام لا per-session فقط. |
| 5 | عزل per-user مفقود | — | كل مسار جديد يمرّ ببوّابة `participantsDb.isParticipant` (B-105، منشورة حيّاً). الـapp-level يُعدّد عبر `getSessionIdsForUser` الجديد (per-user by construction). |
| 6 | لا تمسّ الجيّد | completed/settled مُصلّب وحيّ (reconcile) | لا تعديل على `workflow-reconcile.service.ts` المنطق القائم. التصنيف الجديد طبقة **فوقه** تشاركه قراءة journal نفسها. |

---

## 1. النموذج الذهني — أربع حالات نهائية لكلّ workflow

تُشتقّ كلّها من قراءة journal واحدة + سجلّ حياة العملية. **لا اعتماد على mtime لتمييز الحياة**:

```
                 العملية حيّة في السجلّ؟
                  ┌──────────┴──────────┐
                 نعم                    لا
                  │                      │
              RUNNING            started ⊆ result ?
          (شغّال فعلاً،         ┌────────┴────────┐
       لا تصنيف نهائي بعد)     نعم               لا
                                │                 │
                          COMPLETED        journal هادئ ≥ QUIET؟
                       (reconcile القائم)  ┌──────┴──────┐
                                          نعم            لا
                                           │              │
                                        ORPHAN        RUNNING*
                                  (started⊄result      (قد يكون وكيل
                                   + ميت + هادئ)      حيّ يكتب الآن —
                                                      لا يُحسم بعد)
```

- `SETTLED` (من reconcile القائم) = حالة فرعية من «ميت + started⊄result + هادئ + mtime>stopped»: عندما يوجد سياق `run.stopped` يُصحَّح. ORPHAN هو نفس الشكل لكن **بلا اشتراط mtime>stopped** ودون توليد رسالة تصحيح — مجرّد حالة عرض «يتيم».
- **RUNNING\*** (السطر الأخير): العملية غائبة من السجلّ لكن journal ليس هادئاً بعد. هذا هو بالضبط ما يحمي من الإيجابية الكاذبة على «وكيل بطيء 177s+»: لا نعلن ORPHAN حتى يهدأ journal ≥ QUIET. (وإن كانت العملية حيّة أصلاً نُصنّف RUNNING فوراً دون انتظار الهدوء.)

> **القاعدة الذهبية ضدّ فيتو #1:** الحياة تُقرأ من سجلّ العملية أولاً. mtime/QUIET يُستخدم **حصراً** لحسم «ميت + هادئ ⇒ يتيم» مقابل «ميت + يكتب ⇒ ربما لم ينتهِ بعد، عامله running». لا يُستخدم mtime أبداً ليقول «هذا حيّ».

---

## 2. مصدر الحقيقة لكل إشارة (data flow)

| الإشارة | المصدر | الملف:السطر | ملاحظة |
|--------|--------|------------|--------|
| العملية حيّة (المنسّق) | `isClaudeSDKSessionActive(sessionId)` → `activeSessions.get(sid).status==='active'` | `claude-sdk.js:1919,807,101` | **غير مُعلَّم بعلم** — يعمل دائماً. هذا المصدر الأساس. |
| العملية حيّة (بثّ مُسجَّل) | `claudeSessionRegistry.isActive(sid)` | `session-registry.js:209` | مُعلَّم بـ`SESSION_REGISTRY_claude`. **مكمّل لا أساس** (انظر §6 edge). |
| مشاهدون أحياء | `countLiveMirrors(sid)` | `websocket-writer.service.ts:87` | يدلّ على وجود socket حيّ يتلقّى البثّ. |
| started/result keys | `readJournalKeySets(journalPath)` | `workflow-reconcile.service.ts:129` | يُعاد استخدامه — تُصدَّر دالّته. |
| تصنيف completed/settled | `classifyWorkflowSettlement` | `workflow-reconcile.service.ts:199` | يُعاد استخدامه كما هو. |
| هدوء journal | `now - mtime(journal) >= QUIET_MS` | `workflow-reconcile.service.ts:291` | mtime لـ**الهدوء فقط**، لا للحياة. |
| ملكية الجلسة | `participantsDb.isParticipant(sid,userId)` | `participants.db.ts:138` | B-105، منشورة. |
| جلسات المالك (app-level) | `participantsDb.getSessionIdsForUser(userId)` **(جديد)** | `participants.db.ts` | على غرار `getProjectPathsForUser:253`. |

### دالّة التصنيف الموحّدة (خادمية، نقية فيما عدا قراءة القرص)

تُضاف إلى `workflow-reconcile.service.ts` (نفس الملف، فوق المنطق القائم — لا تعديله):

```
classifyWorkflowLiveness(sessionDir, sessionId, opts): Promise<WorkflowLivenessRow[]>
  لكل wf_<id> في subagents/workflows/:
    { startedKeys, resultKeys } = readJournalKeySets(journal)   // معاد استخدامه
    processAlive = isSessionProcessAlive(sessionId)             // تُحقن من الأعلى
    if processAlive: status = 'running'
    else:
      settle = classifyWorkflowSettlement(startedKeys, resultKeys)  // معاد
      if settle === 'completed': status = 'completed'
      else:
        quiet = (now - mtime) >= QUIET_MS
        status = quiet ? 'orphan' : 'running'   // ميت غير هادئ ⇒ عامله running
    push { wfId, status, agentsDone, agentsTotal }
```

- `isSessionProcessAlive(sessionId)` تُحقن من المُستدعي (الموفّر) كدالّة، لتبقى `workflow-reconcile.service.ts` خالية من اعتماد على `claude-sdk.js` (تجنّب دورة استيراد). تعريفها في الموفّر:
  `isClaudeSDKSessionActive(sid) || claudeSessionRegistry.isActive(sid) || countLiveMirrors(sid) > 0`.
- **لا تمسّ** `findReconciledWorkflows`/`reconcileWorkflowMessages`/`classifyWorkflowSettlement`/`buildReconcileMessage`. الجديد دالّة منفصلة بجانبها.

---

## 3. كيف تصل الحالة للعميل

### 3.أ مسار per-session (fetchHistory) — الضمانة (يعالج فيتو #3)

نقطة الحقن: نفس موضع reconcile القائم في `claude-sessions.provider.ts:215-223`، حيث `sessionDir = path.dirname(subagentsDir)` و`sessionId` متوفّران.

- يُستدعى `classifyWorkflowLiveness(sessionDir, sessionId, { isSessionProcessAlive })`.
- النتيجة لا تُحقَن كرسائل تصحيح (هذا دور reconcile)، بل تُرفَع كحقل **جديد على غلاف `FetchHistoryResult`** (انظر §4) — حتى تظهر الحالة لحظة فتح الجلسة **والعملية ميتة**. هذا هو حلّ بيضة-الدجاجة: لا حاجة لأن «يعرف العميل أن يستطلع».
- البوّابة الأمنية (B-105) قائمة بالفعل قبل هذه النقطة في `sessions.service.fetchHistory:258` — الحقل الجديد يرث عزلها مجاناً.

### 3.ب مسار app-level (endpoint جديد) — المتطلَّب global (يعالج فيتو #4)

`GET /api/providers/workflows/active` (داخل الراوتر المعزول بـ`authenticateToken`):
1. `userId = readRequesterUserId(req)` → `null` ⇒ `{ workflows: [] }` (fail-closed).
2. `sessionIds = participantsDb.getSessionIdsForUser(userId)` (per-user by construction، فيتو #5).
3. لكل sessionId مملوك: حلّ `sessionDir` ثم `classifyWorkflowLiveness`، واجمع فقط `status ∈ {running, orphan}` (المكتمل لا يُعرض في مؤشّر «جارٍ الآن»).
4. أعد قائمة مسطّحة `{ sessionId, projectPath, workflows:[{wfId,status,agentsDone,agentsTotal}] }`.
- سقف وقائي: حدّ أقصى لعدد الجلسات الممسوحة لكل نداء (مثل آخر 200 نشطة) لتجنّب مسح قرص ثقيل؛ والمسح كسول (يتوقف عن قراءة journal لجلسة بلا مجلّد `workflows`).

### 3.ج البثّ/الاستطلاع — تحسين لا ضمانة

- مؤشّر app-level يُغذّى بـ**polling خفيف** من العميل (مثل كل 15–30s، أو عند focus) على endpoint §3.ب. لا يعتمد على بقاء عملية Claude.
- البثّ الحيّ القائم (`pendingWorkflows`/المرايا) يبقى كما هو لتجربة لحظية حين العملية حيّة؛ موته لا يُفقد الرؤية لأن الاستطلاع يلتقطها من القرص.

---

## 4. عقود الـAPI

### 4.أ توسعة `FetchHistoryResult` (per-session)

حقل اختياري جديد، إضافي غير كاسر:

```ts
type WorkflowLivenessStatus = 'running' | 'orphan' | 'completed';

type WorkflowLivenessRow = {
  wfId: string;
  status: WorkflowLivenessStatus;
  agentsDone: number;      // resultKeys matched
  agentsTotal: number;     // max(startedKeys, resultKeys)
};

// يُضاف إلى FetchHistoryResult:
backgroundWorkflows?: WorkflowLivenessRow[];   // غائب/فارغ ⇒ لا عمل خلفي
```

- موجود فقط في حالة `limit !== null` و`limit === null` على السواء (يُرفق على الغلاف لا على مصفوفة الرسائل).
- العزل: مضمون بـ`fetchHistory:258` القائم — لا تغيير في بوّابة الملكية.

### 4.ب `GET /api/providers/workflows/active` (app-level)

```
Auth: authenticateToken (الراوتر كلّه خلفه)
Request: لا بارامترات (يُشتقّ المالك من req.user)
200 Response:
{
  "sessions": [
    {
      "sessionId": "…",
      "projectPath": "…",
      "workflows": [
        { "wfId": "wf_abc", "status": "running", "agentsDone": 3, "agentsTotal": 6 }
      ]
    }
  ]
}
عزل: userId=null ⇒ { "sessions": [] }. لا تسريب وجود جلسة غير مملوكة.
```

- لا يُعيد `completed` (مؤشّر «جارٍ الآن» فقط). المكتمل يُرى في سياق الجلسة عبر reconcile القائم.

---

## 5. تفكيك بنود التنفيذ (قابلة للتفويض)

### Backend

| البند | الوصف | الملف | التبعية | الوكيل |
|------|-------|-------|---------|--------|
| **T-242-B1** | تصدير `readJournalKeySets` + ثابت QUIET من reconcile، وإضافة `classifyWorkflowLiveness(sessionDir, sessionId, {isSessionProcessAlive, quietMs?, now?})` بجانب المنطق القائم دون تعديله | `workflow-reconcile.service.ts` | — | backend-dev |
| **T-242-B2** | `participantsDb.getSessionIdsForUser(userId): string[]` على غرار `getProjectPathsForUser:253` (prepared statement، fail-closed لغير integer) | `participants.db.ts` | — | backend-dev |
| **T-242-B3** | في `getSessionMessages`/`fetchHistory` للموفّر: حقن `isSessionProcessAlive` (دمج `isClaudeSDKSessionActive` + `claudeSessionRegistry.isActive` + `countLiveMirrors`) واستدعاء B1، وإرفاق `backgroundWorkflows` على `FetchHistoryResult` | `claude-sessions.provider.ts` (حول 215) + `types.ts` للغلاف | B1 | backend-dev |
| **T-242-B4** | endpoint `GET /workflows/active`: خدمة تُعدّد `getSessionIdsForUser`، تحلّ sessionDir لكلٍّ، تستدعي B1، تصفّي running/orphan، مع سقف مسح | `provider.routes.ts` + خدمة جديدة `workflow-status.service.ts` | B1,B2 | backend-dev |
| **T-242-B5** | اختبارات: running (عملية حيّة)، orphan (ميت+هادئ+started⊄result)، running\* (ميت غير هادئ ⇒ ليس orphan)، completed، عزل per-user (مستخدم آخر ⇒ صفر)، علم registry مطفأ (يُحسم بـactiveSessions وحده) | `__tests__/` | B1–B4 | tester |

### Frontend

| البند | الوصف | التبعية | الوكيل |
|------|-------|---------|--------|
| **T-242-F1** | عرض `backgroundWorkflows` عند فتح الجلسة (شارة per-session: «جارٍ N»/«يتيم») يقرأ غلاف fetchHistory | T-242-B3 | frontend-dev |
| **T-242-F2** | مؤشّر app-level عام (شريط/أيقونة برأس التطبيق) يستطلع `/workflows/active` كل 15–30s ويعرض إجمالي running/orphan عبر كل جلسات المالك، مع RTL وi18n (ar/en) | T-242-B4 | frontend-dev |
| **T-242-F3** | حالات فارغة/تحميل/فشل استطلاع تتلاشى بهدوء (لا راحة زائفة عند 404/شبكة) | F1,F2 | frontend-dev |

> تحذير ملفات مشتركة (درس `feedback_parallel_subagent_shared_files`): i18n (`sidebar.json` وأي مفتاح جديد) يُسنَد لوكيل frontend واحد فقط؛ يُتحقَّق من صحّة JSON بعد العودة.

---

## 6. المخاطر وحالات الحافة (يجب أن يعالجها التنفيذ صراحةً)

1. **علم `SESSION_REGISTRY_claude` مطفأ** (الواقع الافتراضي): `claudeSessionRegistry.isActive` يعيد `false` دائماً. لذلك **`isClaudeSDKSessionActive` (`activeSessions`، غير مُعلَّم) هو مصدر الحياة الأساس**، والـregistry/المرايا مكمّلان فقط. اختبار B5 يثبت الصواب والعلم مطفأ.
2. **العملية تخرج وسط الموجة (SIGKILL/قطع ssh)**: لا تبلغ `setActive(false)` ولا `removeSession`. لكن `activeSessions` تُمسح بخروج العملية (ذاكرة)، فبعد restart الجلسة غائبة من `activeSessions` ⇒ تُصنَّف عبر مسار «ميت» ⇒ orphan/completed حسب journal. صحيح.
3. **وكيل بطيء حيّ (177s+)، العملية حيّة**: `isSessionProcessAlive=true` ⇒ RUNNING فوراً. لا إعلان orphan خاطئ. (الفيتو #1 محلول.)
4. **وكيل ميت لكن journal كُتب قبل ثوانٍ (لم يهدأ)**: ميت + غير هادئ ⇒ RUNNING\* (محافظ)، لا orphan متسرّع. عند الاستطلاع التالي بعد الهدوء يُحسم orphan/completed.
5. **إعادة فتح الجلسة**: fetchHistory يعيد الحساب من القرص في كل فتح ⇒ الحالة محدّثة بلا حالة عميل عالقة.
6. **عدة مشاهدين**: كلّهم يقرؤون نفس القرص؛ `countLiveMirrors>0` يدلّ على حياة بثّ. لا تعارض — القرص مصدر واحد.
7. **workflow مكتمل لكن العميل لم يره**: reconcile القائم يولّد رسالة التصحيح في سياق الجلسة (لا يُمَسّ)؛ والمؤشّر app-level لا يعرض completed أصلاً، فيختفي الـworkflow من «جارٍ» عند اكتماله — السلوك المرغوب.
8. **تكلفة مسح القرص app-level**: سقف عدد الجلسات + تخطّي جلسات بلا مجلّد `workflows` + استطلاع غير عدواني (15–30s). قابل للترقية لاحقاً بكاش/علم.
9. **بوّابتا journal المشتركتان مع B/C** (`T-C0` ثبات صيغة journal على نسخة SDK، `T-C1` تحقّق على transcript فعلي لا fixtures — درس `feedback_synthetic_fixtures_false_confidence`): تنطبق هنا لأن B1 يقرأ نفس `journal.jsonl`. اختبارات B5 يجب أن تُشتقّ fixtures من transcript حقيقي (مثل `wf_ef5ba242`).

---

## 7. ما لا يُمَسّ (فيتو #6)

`workflow-reconcile.service.ts` المنطق القائم (`findReconciledWorkflows`, `classifyWorkflowSettlement`, `reconcileWorkflowMessages`, `buildReconcileMessage`, `findLatestStoppedNotificationMs`)، ومسار حقنه في `claude-sessions.provider.ts:215-223`، ومسار drain/B-N-DRAIN. الجديد يُضاف بجانبها ويعيد استخدام `readJournalKeySets` + `classifyWorkflowSettlement` فقط.
