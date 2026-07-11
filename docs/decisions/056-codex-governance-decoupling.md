# ADR-056: فصل حوكمة نسّاج عن محرّكات Codex/opencode — نواة محايدة + توليد لكل محرّك

**التاريخ:** 2026-07-11 · **الحالة:** معتمد (قرار المالك، جلسة review 2026-07-11) · **المُقترِح:** architect · **المراجعة:** qa-critic (آمن للإبقاء)

---

## 1. السياق

جلسات Codex في nassaj-dev تعمل **دون حوكمة نسّاج** — لا تعليمات، لا معايير أمان/عزل، بل قيود SDK defaults الدنيا. بينما تصليب Codex (commit `52b76702`) أثبت **الكفاءة الفعلية** (20/20 اختبار عزل يمرّ)، فهي تحتاج **الحوكمة كضمان أمني بنيوي**.

الأساليب المرفوضة:
1. **symlink خام لـ `NASSAJ.md`:** يحقن ميكانيكا Claude-only (compact عند 40%، حصص 5 ساعات، توزيع nanomodels fable/opus، hooks، ultracode) → مضللة وغير قابلة للتنفيذ على Codex.
2. **نسخة يدوية لـ `NASSAJ.md`:** عبر مشروع Codex الملصق → انجراف، تسريب أسرار المالك، فجوات سياق.
3. **لا حوكمة:** الوضع الحالي — لا ضمانات أمن أو امتثال.

**الأساس القرار المعتمد:** مصدر واحد `nassaj-core/neutral-standards.md` → **`build-agents` يولّد مخرج موصول لكل محرّك**: symlink native لـ Claude، و `AGENTS.md` محايد مولَّد لـ Codex/opencode/…

---

## 2. القرار

### المعمارية المختارة

```
nassaj-core/
  ├─ neutral-standards.md (مصدر الحقيقة — معايير عام)
  ├─ scripts/build-agents
  │  ├─ target: claude → symlink native لـ NASSAJ.md
  │  ├─ target: codex → AGENTS.md محايد
  │  └─ target: opencode → AGENTS.md محايد
  └─ AGENTS.md (مولَّد، مخزن مؤقت)

nassaj-dev/
  ├─ server/services/user-initialization/
  │  └─ provision-user-dirs.ts
  │     └─ حقن symlink لـ AGENTS.md في CODEX_HOME الخاص بكل مستخدم
  └─ واجهة
     └─ شارة حالة الحوكمة (محكوم/غير محكوم)
```

### الخطوات

1. **نسّاج-كور (مصدر واحد):**
   - `neutral-standards.md` — تعريف الأدوار، الأوامر المسموحة/المحظورة، معايير التوثيق، رسائل الأخطاء. **بلا آلية عملية** (بلا hooks، بلا حصص، بلا ultracode).
   - `build-agents --check` — يتحقّق أن كل إعادة توليد تُنتج نفس البايتات (idempotent).

2. **Claude (لا تغيير):**
   - symlink نسّاج الحالي إلى `NASSAJ.md` — يحتوي الكود الكامل (hooks + compact + حصص + …).
   - `AGENTS.md` مُولَّد بقرار ADR-018 — **تجاهله** (لا يُستخدم لـ Claude).

3. **Codex:**
   - Phase 1: `nassaj-dev` يحقن `AGENTS.md` المُولَّد من nassaj-core في `CODEX_HOME` الخاص بكل مستخدم عبر symlink (لا نسخة).
   - جلسة Codex عند الإطلاق تقرأ من `CODEX_HOME` أولاً — محكومة **تلقائياً**.
   - لا تعرض ميكانيكا claude-only (compact غير موجود، حصص للاشتراك فقط، …).

4. **opencode/غيره:**
   - نفس `AGENTS.md` المُولَّد من nassaj-core → `~/.config/opencode/AGENTS.md`.

5. **الواجهة:**
   - شارة توضح: محكوم (AGENTS.md ✓) / غير محكوم (بلا تعليمات).

---

## 3. البدائل المرفوضة

| البديل | المشاكل | السبب الرفض |
|---|---|---|
| **نسخة واحدة `NASSAJ.md` لجميع المحرّكات** | يحتوي `/compact`، حصص 5 ساعات، hooks، ultracode — غير ممكن على Codex؛ خطر أمني (تسريب أسرار) | عدم إمكانية التنفيذ + الأمان |
| **نسخ محلية من `NASSAJ.md` في كل ملصق** | انجراف سريع، نسخ مختلفة تُنفّذ معايير مختلفة، فجوات سياق | الصيانة والأمان |
| **شيء من كل محرّك يقرأ `NASSAJ.md` مباشرة** | Codex يقرأه اليوم عبر fallback (آلية Claude Code) — مضلّل + خطر | الأمان والوضوح |
| **بلا حوكمة** | الوضع الحالي — جلسات Codex تعمل بدون ضمانات | الأمان والامتثال |

---

## 4. التبعات

| الجانب | البنيوية | السلوكية |
|---|---|---|
| **الحوكمة** | لا تغيير على Claude (symlink NASSAJ.md الحالي)؛ Codex يُصبح محكوماً عبر symlink. | جلسات Codex لا ترى ميكانيكا claude-only (compact، حصص جلسة، …). |
| **التعليمات** | مصدر واحد `neutral-standards.md` + آليات مختلفة لكل محرّك (`build-agents`). | نفس المعايير المرئية في AGENTS.md (أدوار محايدة). |
| **المهارات/الأوامر** | build-agents يولّد أوامر محايدة + أمثلة لكل محرّك. | Codex ترى أوامر محايدة فقط (بلا `/cost /memory` كلود). |
| **الأسطول** | تثبيت opencode سيشمل `AGENTS.md` المشترك من nassaj-core. | كل عقدة توفّر نسخة واحدة لجميع المستخدمين (عبر symlink في provisionUserDirs). |
| **العزل متعدد المستخدمين** | كل مستخدم symlink خاص ← AGENTS.md المشترك (بلا تسريب أسرار). | مستخدم non-owner + معزول نسبياً ≠ غير محكوم. |

---

## 5. الافتراضات والقيود

| الافتراض | الحالة | الخطر |
|---|---|---|
| `build-agents --check` idempotent | ✅ مُثبَّت (commit `1ce2c4e`) | منخفض |
| Codex يقرأ `CODEX_HOME/AGENTS.md` | ✅ مؤكَّد spike (T-819) | منخفض |
| بلا symlink كسر على NFS شبكي | ⚠️ يفترض سلوك POSIX معياري | متوسط — تحقّق مع المالك |
| لا مستخدم يعدّل `AGENTS.md` يدوياً | ⚠️ حقن آلي فقط في `provisionUserDirs` | منخفض (آلية عزل) |

---

## 6. معايير القبول

### المرحلة 0 ✅ (منجَزة 2026-07-11)
- [x] `nassaj-core/docs/neutral-standards.md` يحدّد المعايير المحايدة.
- [x] `build-agents --check` يمرّ (byte-identical).
- [x] Codex target يولّد `AGENTS.md` محايد.

### المرحلة 1 ⏳
- [ ] `nassaj-dev` يحقن symlink في `CODEX_HOME` عند إنشاء مستخدم.
- [ ] جلسة Codex محكومة (اختبار `debug skill` لا ترى `/compact`).
- [ ] حارس 403 على كتابة مزوّد مشترك.

### المرحلة 2 ⏳
- [ ] لا تسريب أسرار المالك إلى `CODEX_HOME` (audit spike).
- [ ] multi-user: كل مستخدم symlink منفصل (بلا collision).

### المرحلة 3 ⏳
- [ ] واجهة توضح حالة الحوكمة (محكوم/غير).

---

## 7. الروابط والمراجعات

| المرجع | العلاقة |
|---|---|
| **ADR-018** | `build-agents` — تصميم أساسي. |
| **ADR-047/T-224** | واصف قدرات المزوّدات — ربط AGENTS.md بـ capabilities. |
| **ADR-057** | حقن Codex عبر symlink (التطبيق التفصيلي). |
| **docs/plans/CODEX-GOVERNANCE-DECOUPLING-2026-07-11.md** | خطة مرحلية. |
| **docs/reviews/CODEX-INTEGRATION-REVIEW-2026-07-11.md** | المراجعة الأمنية (qa-critic). |
| **docs/plans/OPENCODE-COMPAT-2026-07-10.md** (§4.5) | المبدأ المعماري. |

---

## 8. الملاحظات التاريخية

- **2026-07-11:** قرار المالك معتمد (جلسة review، commit `52b76702` Codex).
- **2026-07-11:** المرحلة 0 منجَزة (commit `1ce2c4e` nassaj-core).
- **2026-07-11:** صيغة أولية لـ ADR-056/057 للاعتماد.
