# ADR-022 — Process Supervisor: PM2 + SIGTERM Drain

> **سجلّ قرار معماري مختصر (ADR).** الصيغة: Context → Decision → Consequences → Status.

| الحقل | القيمة |
|---|---|
| **Status** | ✅ **Accepted** — 2026-06-06 (ضمن بوابة تصميم ADR-021). |
| **التاريخ** | 2026-06-06 |
| **المالك** | i.rukhaimi |
| **مرتبط بـ** | ADR-021 (Session Survival & Replay) · `docs/workitems/PHASE-SR-0.md` (B-N-DRAIN) |

---

## Context

drain النشر الرشيق يحتاج منصّة إشراف (process supervisor) ترسل إشارة إيقاف **قابلة للاعتراض** قبل القتل. المنتج يعمل على **PM2** (`exec_mode:'fork'`)، لا systemd. السؤال: نبقى على PM2 أم نرحّل إلى systemd للحصول على `MemoryHigh` (drain متدرّج عند ضغط الذاكرة)؟

---

## Decision

**البقاء على PM2** مع drain مُحفَّز بـ **SIGTERM فقط** + `kill_timeout`. **لا ترحيل إلى systemd الآن.**

- `exec_mode:'fork'` في PM2 يرسل **SIGTERM القياسي** عند `restart/stop` ثم يقتل بـ SIGKILL بعد `kill_timeout`.
- هذه نفس آلية systemd (`TimeoutStopSec` + SIGTERM→SIGKILL) → **إعادة العمل المستقبلية عند ترحيل systemd شبه صفر** (إعداد فقط، بلا تغيير منطق drain).

---

## Consequences

- **مقبول:** PM2 لا يوفّر مكافئ `MemoryHigh` → قتل OOM صلب بلا تدرّج. مغطّى بـ replay buffer (ADR-021)، وOOM استثناء لا مسار نشر مُخطَّط.
- **منخفض الكلفة مستقبلاً:** لأن SIGTERM متطابق، الترحيل إلى systemd لاحقاً = إعداد unit file فقط.
- **قيد التنفيذ (B-N-DRAIN):** يلزم استبدال `process.exit(0)` الفوري في `server/index.js:1789` بـ drain موقوت، وضبط `kill_timeout` في PM2 (ملف ecosystem — **لا يُعدَّل في هذه البوابة؛ تعديله ضمن تنفيذ B-N-DRAIN لاحقاً**).

> **تنبيه ملفّي:** `ecosystem.config.cjs` **لا يُلمس** في بوابة التوثيق هذه (جلسة متوازية محتملة). ضبط `kill_timeout` يجري عند تنفيذ B-N-DRAIN.
