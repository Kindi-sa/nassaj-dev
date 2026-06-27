# Runbook — تصحيح حالة Workflow بعد Restart

**الحالة:** Active (يدوي)  
**الإصدار:** v1.0 (2026-06-27)  
**الصلة:** ADR-048، B-N-DRAIN (ADR-021/022)، حادثة wf_ef5ba242-b4b

---

## المشكلة (Problem)

عند إعادة تشغيل السيرفر (pm2 restart) أثناء جلسة Claude Code تشغّل workflow خلفي:

1. **treekill:false يُبقي وكلاء الـworkflow أحياء** (orphans) فيكملون الكود على القرص.
2. **السيرفر الجديد يُصدر إشعار `run.stopped`** (بدون معلومة اكتمال) لأن `drain` يعدّ الجلسات بالذاكرة فقط ولا يرى الـworkflows.
3. **النتيجة:** الواجهة تعرض «توقّف» رغم اكتمال العمل على القرص (الملف موجود، مثلاً `PLAN-v1.md`).
4. **لا فقدان عمل** — العمل الفعلي اكتمل؛ الخلل في الرؤية فقط.

---

## الأعراض (Symptoms)

- ظهور إشعار `run.stopped` / `No completion record` في واجهة الجلسة.
- الملف المُطلوب موجود فعلاً (مثلاً `PLAN-v1.md` في محفظة المشروع).
- سجلّ سيرفر يظهر restart + عودة الجلسة الأمامية بدون تتبّع للـworkflow.
- مجلد `subagents/workflows/wf_*/` يحوي `journal.jsonl` بـ `result` entries.

---

## الحل السريع (Quick Fix)

### الخطوة 1: تأكّد اكتمال العمل

```bash
# من مشروع nassaj-dev
SESSION_ID="<جلسة_التفاعل>"
WF_DIR="~/.claude/projects/-home-nassaj-Project-nassaj-dev/${SESSION_ID}/subagents/workflows"

# ابحث عن مجلدات workflow
ls -la "${WF_DIR:?}"  # يجب أن تظهر wf_<hash>/*

# للمجلد الأخير، افحص journal.jsonl
tail -50 "${WF_DIR}/wf_*/journal.jsonl"
```

**ابحث عن:**
- عدد سطور `"type":"started"` 
- عدد سطور `"type":"result"`
- إذا كانا متساويين، اكتمل العمل ✓

### الخطوة 2: افحص الملف على القرص

```bash
# مثال: إذا كان العمل هو drafting مستند PLAN
find "محفظة_المشروع" -name "PLAN-*.md" -o -name "*.md" -mmin -10
# (في آخر 10 دقائق)
```

**إذا وُجد:** العمل اكتمل فعلاً ✓

### الخطوة 3: استئنف الجلسة يدويّاً (إن أردت تصحيح الرؤية)

```bash
# من داخل واجهة nassaj-dev أو CLI اgy
agy --conversation <session_id> --resume
```

عند الاستئناف، ستُعاد قراءة الـtranscript:
- **مع ADR-048 مُفعَّل (WORKFLOW_RECONCILE=1):** الخادم سيكتشف اكتمال الـworkflow ويُرفق رسالة `task_reconcile` تصحّح البطاقة.
- **بدونه (الحالة الحالية):** لا تصحيح تلقائي — لكن الملف موجود والعمل اكتمل.

---

## الحلّ الدائم (Implementation)

**المُخطّط:** ADR-048 + T-225 (reconciliation backend)  
**الحالة الحالية:** تصميم معتمد، بانتظار تنفيذ backend-dev

آلية الـreconciliation:

```
عند فتح/استئناف جلسة:
  1. اقرأ transcript (getSessionMessages)
  2. افحص وجود صفّ run.stopped خلفي
  3. إن وُجد: اقرأ journal الـworkflows تحت subagents/workflows/wf_*/journal.jsonl
  4. اجمع started.key و result.key من journal
  5. إذا كانا متطابقين (جميع المهام اكتملت) + journal حديث (mtime > timestamp(stopped)):
     → أرفق رسالة تصحيح مشتقّة (task_reconcile) في حمولة الرسائل
     → بثّ إشعار WS workflow_reconciled للمتصلين
  6. fail-safe: أي خطأ في القراءة → سكوت (لا throw)
```

تفعيل العلم:
```bash
# .env أو ecosystem.config.cjs
WORKFLOW_RECONCILE=1
pm2 restart nassaj-dev
```

**عقد الواجهة (frontend) المتوازية:** توسيع `taskNotifRegex` ليقبل stopped، معالجة `task_reconcile` كبطاقة تستبدل stopped.

---

## الخريطة الطبوغرافية (Topology)

```
الجلسة الأمامية (قراءة أول)
    │
    ├─ claudecodeui/SDK قراءة transcript وبثّ run.stopped
    │
    ├─ getSessionMessages (server/providers/claude-sessions.provider.ts:125)
    │   │
    │   ├─ قراءة jsonl_path من DB
    │   │
    │   └─ [ADR-048] workflow-reconcile.service.ts
    │       ├─ اقرأ subagents/workflows/wf_*/journal.jsonl
    │       ├─ طابق started ↔ result بـ key
    │       └─ أرفق task_reconcile مشتقّة
    │
    └─ بثّ عبر WS إلى الواجهة
        │
        └─ [Frontend] معالجة task_reconcile (يستبدل stopped)
```

**اختبار التثبيت:**
```bash
# fixture من حادثة wf_ef5ba242-b4b
docs/decisions/fixtures/journal-completed.jsonl
# اختبار: يكتشف اكتمال + لا errors
```

---

## الأسباب الجذرية (Root Cause Analysis)

| الجانب | المشكلة | الموارد |
|-------|--------|--------|
| **SDK** | لا تتبّع workflow عبر restart | ADR-021 (treekill:false)، ADR-041 (replay) |
| **drain** | عدّاد بالذاكرة فقط + صفر تكامل workflow | ADR-022 (drain كـWON'T)، B-N-DRAIN |
| **regex** | taskNotifRegex يُلزم output-file | B-94 (issueLow)، T-226 |
| **الحل** | reconcile بعدي lazy + قراءة قرص | ADR-048 (Proposed) |

---

## أدوات التشخيص (Diagnostics)

```bash
# 1. تفتيش journal
jq -s 'group_by(.key) | .[] | {key:.[0].key, started:map(select(.type=="started"))|length, result:map(select(.type=="result"))|length}' \
  ~/.claude/projects/-home-nassaj-Project-nassaj-dev/<SID>/subagents/workflows/*/journal.jsonl

# 2. مقارنة أوقات mtime(journal) vs timestamp(stopped)
stat ~/.claude/projects/-home-nassaj-Project-nassaj-dev/<SID>/subagents/workflows/*/journal.jsonl | grep Modify

# 3. افحص transcript المصدر مباشرة
tail -100 ~/.claude/projects/-home-nassaj-Project-nassaj-dev/<SID>/transcript.jsonl | grep stopped

# 4. تحقّق من ملف الخرج
find محفظة_المشروع -name PLAN*.md -exec ls -lh {} \;
```

---

## الجدول الزمني للحادثة (Timeline)

| الوقت | الحدث |
|------|------|
| 14:49:41 | `pm2 restart nassaj-dev` (treekill:false، kill_timeout:300000) |
| 14:49:41-51:02 | الجلسة القديمة تُقفل؛ وكلاء الـworkflow (orphans) يستمرّون |
| 14:51:02 | السيرفر الجديد يُصدر `run.stopped` (timestamp) |
| 14:51:51 | بدء الوكيل الفعلي للكتابة (سطر أول في journal) |
| 14:57:09 | اكتمال PLAN-v1.md على القرص + آخر `result` في journal |
| **الفجوة** | **6 دقائق و 7 ثوانٍ من الإشعار الكاذب** |

**النتيجة الأخيرة:** العمل اكتمل ✓، الملف موجود ✓، لكن الواجهة عرضت بطاقة «توقّف» ✗

---

## المراجع

- **ADR-021:** Session Survival and Replay (treekill:false)
- **ADR-022:** Process Supervisor PM2 SIGTERM Drain
- **ADR-048:** Workflow Completion Reconcile (الحلّ المخطّط)
- **ADR-028:** Restart Overlap Supervisor (متعلق: lost PID tracking)
- **B-N-DRAIN:** دراسة الفصل الكامل (المقررات: لا فصل، B-N-DRAIN فقط)
- **B-94:** regex إشعار المهمة
- **B-95:** kill_timeout vs drain timeout
- **حادثة:** wf_ef5ba242-b4b (2026-06-27)
