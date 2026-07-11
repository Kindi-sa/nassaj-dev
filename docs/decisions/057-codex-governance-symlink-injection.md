# ADR-057: حقن حوكمة Codex عبر symlink محايد في CODEX_HOME

**التاريخ:** 2026-07-11 · **الحالة:** معتمد (قرار المالك، جلسة review 2026-07-11) · **المُقترِح:** architect · **المراجعة:** qa-critic + تحقّق spike (T-819)

---

## 1. السياق

**المرجع الأساسي:** ADR-056 (الفصل المعماري — مصدر واحد + توليد محرّك-محدد)

Codex SDK (`@openai/codex-sdk`) يقرأ `$CODEX_HOME/AGENTS.md` عند الإطلاق (spike T-819 مؤكّد 2026-07-11). nassaj-dev اليوم لا يحقن حوكمة نسّاج في `CODEX_HOME` — جلسات Codex تُطلق بلا تعليمات.

**الحل البنيوي:** `CODEX_HOME` لكل مستخدم **symlink مرتبط بـ** `AGENTS.md` المولَّد المشترك من nassaj-core.

**البدائل المرفوضة:**
1. **نسخة حرفية:** كل مستخدم ← نسخة `AGENTS.md` خاصة → انجراف بلا مصدر واحد.
2. **مسار مشترك hardcoded:** بلا عزل — يفقد multi-user سلامة الخصوصية.
3. **بلا حوكمة:** الحالة الحالية — جلسات Codex بلا ضمانات أمن.

---

## 2. القرار

### الحل

```
nassaj-core/AGENTS.md  ← مصدر الحقيقة (مُولَّد بـ build-agents)
    ↑
    │ symlink
    │
nassaj-dev/provisionUserDirs
    ↓
/home/<user>/.codex/AGENTS.md  ← مُعاد التوجيه إلى nassaj-core
    ↑
    └─ جلسة Codex تقرأها عند الإطلاق = محكومة
```

### الخطوات

#### الخطوة 1: `provisionUserDirs` يحقن symlink (nassaj-dev)

**الملف:** `server/services/user-initialization/provision-user-dirs.ts`

**الكود المتوقع (pseudocode):**
```typescript
// عند إنشاء مستخدم جديد
ensureSymlink(
  sourceAgentsPath: '/home/nassaj/nassaj-core/AGENTS.md',  // مصدر
  targetCodexPath: path.join(codexHomeDir, 'AGENTS.md'),    // الهدف
  { force: true }  // أعِد الربط إن تغيّر المصدر
);
```

**المسار:** `CODEX_HOME` = `~/.codex` أو `$XDG_CONFIG_HOME/codex` (حسب عزل per-user).

**الاستثناءات المتوقعة:**
- symlink كسر ← إعادة ربط.
- ملف عادي موجود ← حذف + إعادة ربط أو تحذير.

#### الخطوة 2: Codex يقرأ symlink (SDK ← آلية Codex)

**لا عمل مطلوب:** Codex يقرأ `$CODEX_HOME/AGENTS.md` تلقائياً. ما دام الـ symlink موجود، يتّبعه.

#### الخطوة 3: تحقّق الحقن (في قبول M1)

**الاختبار:**
```bash
# مستخدم محدَّد إنتاج جلسة Codex
$ cat ~/.codex/AGENTS.md
# → يجب أن يكون مطابقاً لـ nassaj-core/AGENTS.md

$ ls -l ~/.codex/AGENTS.md
# → symlink ... -> /home/nassaj/nassaj-core/AGENTS.md

$ readlink ~/.codex/AGENTS.md
# → /home/nassaj/nassaj-core/AGENTS.md
```

---

## 3. البيانات والعزل

### عزل Per-User

| المستخدم | CODEX_HOME | symlink AGENTS.md | الهدف | الملاحظة |
|---|---|---|---|---|
| user_1 | `~/.codex` | `~/.codex/AGENTS.md` | nassaj-core/AGENTS.md | مشترك (مقروء-فقط) |
| user_2 | `$XDG_CONFIG_HOME/codex` | `$XDG_CONFIG_HOME/codex/AGENTS.md` | nassaj-core/AGENTS.md | مشترك |
| … | … | … | … | … |

**الفائدة:** كل مستخدم symlink خاص (بلا تسرب بيانات) لكن **مصدر واحد** (بلا انجراف).

### بلا تسريب أسرار المالك

- `AGENTS.md` محتوى **محايد** (لا حصص، لا hooks، لا ultracode).
- symlink **مقروء-فقط** من منظور المستخدم (Codex يقرأه فقط).
- `CODEX_HOME` المتبقي معزول per-user (مزوّدات، حالة الجلسات، …).

---

## 4. التبعات

| البند | التأثير |
|---|---|
| **حوكمة Codex** | جلسات Codex محكومة بـ `AGENTS.md` ← baked in على الإطلاق. |
| **التحديثات** | تحديث `nassaj-core/AGENTS.md` (أي سبب: معايير، أوامر، أدوار) → كل جلسة Codex جديدة تقرأ النسخة الجديدة **بلا إعادة تشغيل nassaj-dev**. |
| **Multi-tenant** | بيئة multi-tenant: كل مستخدم symlink → بلا خلط بيانات. |
| **Filesystem** | يفترض POSIX `symlink` (Linux/macOS ✓، Windows cygwin/WSL ✓). |
| **الأداء** | لا تأثير (symlink resolution = O(1)). |

---

## 5. سيناريوهات الفشل والاسترجاع

| الحالة | الفعل | الحالة الناتجة |
|---|---|---|
| symlink مكسور | `provision` يحاول الربط الجديد → fallback أم خطأ؟ | **خطأ إيقاف** (fail-closed) — لا يُطلق Codex بلا حوكمة. |
| `AGENTS.md` ملف عادي (لا symlink) | اسأل: هل يحذف ويعيد الربط؟ | **سياسة مقترحة:** تحذير سجل + محاولة حذف/إعادة ربط؛ فشل = exit. |
| nassaj-core/AGENTS.md محذوف | جلسات Codex تفشل قراءة. | **فور الكشف بـ CI:** إعادة التوليد. نسّاج-dev لا يحاول الإصلاح. |
| مستخدم يحذف ~/.codex يدوياً | provision لا يُعاد إلا عند تسجيل جديد. | **عند session التالي:** إعادة إنشاء CODEX_HOME ← symlink صحيح. |

---

## 6. معايير القبول

### التطبيق (nassaj-dev)
- [ ] `provision-user-dirs.ts` — حقن symlink عند إنشاء مستخدم ✅ ([T-866/B4](https://example.com)).
- [ ] symlink يُؤشّر إلى `nassaj-core/AGENTS.md` (مسار مطلق أم نسبي؟) **القرار:** مطلق (موثوقية أعلى في أسطول).
- [ ] fail-closed: symlink فاشل = لا إطلاق Codex.

### التحقّق (Spike T-819 + M1)
- [ ] جلسة Codex محكومة: اختبار `debug skill` ترى فقط AGENTS.md (بلا `/compact` claude).
- [ ] multi-user: كل user symlink ← نفس `AGENTS.md` (بلا collision).
- [ ] بلا تسريب: `AGENTS.md` محايد (لا أسرار مالك، لا APIkeys).

### الاختبارات
```bash
# وحدة: symlink يُنشأ بسلام
unit: provisionUserDirs.ensureSymlink()

# تكامل: جلسة Codex تقرأه
integration: launchCodexSession() → detectAGENTS

# spike: تأثر Codex الفعلي
spike: Codex جلسة → `debug skill` → no `/compact`
```

---

## 7. الافتراضات

| الافتراض | الحالة | الخطر |
|---|---|---|
| Codex يتّبع symlink (`readlink -f`) | ✅ مؤكّد (SDK defaults) | منخفض |
| `nassaj-core/AGENTS.md` ثابت على الإطلاق | ⚠️ يفترض `build-agents` يُنفَّذ قبل nassaj-dev | متوسط — توثيق في CI |
| بلا حذف يدوي للـ symlink من المستخدم | ⚠️ يفترض سلوك آمن | منخفض (آلية غير طبيعية) |
| POSIX `symlink` متاح | ✅ (Linux/macOS/WSL) | منخفض |

---

## 8. البدائل المرفوضة مرة أخرى

| البديل | السبب |
|---|---|
| **hardlink** | بلا فائدة (نفس inode) + بلا فصل مرئي. |
| **مسار عام مشترك (بلا symlink)** | بلا عزل — مستخدمون متعددون في مسار واحد. |
| **نسخة + watcher** | مراقب تغييرات على nassaj-core/AGENTS.md → نسخة للمستخدمين | انجراف + فجوة زمنية. |
| **ملف إعدادات يشير للمسار** | Codex لا يقرأ `path-to-agents` — يتوقع `./AGENTS.md` مباشرة. |

---

## 9. الروابط

| المرجع | العلاقة |
|---|---|
| **ADR-056** | المعمارية الأم — فصل الحوكمة. |
| **ADR-018** | `build-agents` — توليد AGENTS.md. |
| **T-819 (Spike)** | Codex يقرأ `AGENTS.md` — ✅ مؤكّد. |
| **T-866/B4** | حارس كتابة مزوّد (تطبيق متزامن). |
| **docs/plans/CODEX-GOVERNANCE-DECOUPLING-2026-07-11.md** | الخطة المرحلية (المرحلة 1). |
| **docs/reviews/CODEX-INTEGRATION-REVIEW-2026-07-11.md** | المراجعة الأمنية (qa-critic). |

---

## 10. الملاحظات

- **symlink أم نسخة؟** symlink (مصدر واحد، بلا انجراف).
- **مسار mutability؟** nassaj-core/AGENTS.md لا يُكتب من nassaj-dev (build-agents الوحيد يكتب).
- **CI/CD:** حلقة CI يجب أن تشغّل `build-agents --check` قبل nassaj-dev (ضمان تطابق).
- **الأسطول:** كل عقدة توفّر `nassaj-core` (عبر `bootstrap-node.sh`) → symlink يعمل موحّداً.
