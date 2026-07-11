# خطة فصل حوكمة نسّاج عن Codex — 2026-07-11

- **التاريخ:** 2026-07-11 · **الحالة:** مسودة للاعتماد (قرار المالك 2026-07-11) · **المؤلف:** scribe
- **المراجعة:** معتمد من architect (جلسة Codex A)؛ منفِّذ: nassaj-core/nassaj-dev متسلسل
- **الفرع:** لا تعديل كود هنا — خطة فقط · **النطاق:** حوكمة المحرّكات
- **المرجعيات:** `docs/reviews/CODEX-INTEGRATION-REVIEW-2026-07-11.md` · `docs/plans/OPENCODE-COMPAT-2026-07-10.md` (§4.5) · ADR-018 (build-agents) · ADR-047/T-224 (واصف القدرات) · فرع `main` (nassaj-core)
- **تقدّم:** المرحلة 0 منجَزة بـ commit nassaj-core `1ce2c4e` (neutral-standards.md + بوابة build-agents)

---

## 1. الخلفية

جلسات Codex في nassaj-dev تستقبل **صفر حوكمة نسّاج** — لا `NASSAJ.md`، لا `AGENTS.md`، لا hooks، لا managed-settings. المحرّك يقرأ تعليمات Claude Code الدنيا الوحيدة (SDK defaults)، فلا ضمانات أمان أو عزل أو معايير. بينما تعمل جلسات Codex الحية على إنتاج بسلام (commit `52b76702` يصلّبها)، الحوكمة فجوة بنيوية — والحالة تنطبق على كل محرّك بديل (opencode، hermes، gemini).

**المبدأ المعتمد:** لا symlink خام لـ `NASSAJ.md` نفسه لجميع المحرّكات (يحقن ميكانيكا Claude-only: `/compact`، حصص جلسة 5 ساعات، خرائط نماذج fable/opus، hooks، ultracode). بدلاً منه: **مصدر `nassaj-core` محايد + `build-agents` يولّد مخرجاً موصولاً لكل محرّك** — symlink native لـ Claude، و `AGENTS.md` مولَّد مترجَم لـ Codex/opencode/…، وإظهار حالة الحوكمة في الواجهة.

---

## 2. القرار (معتمد)

| البند | المسار |
|---|---|
| **الحوكمة العام** | نسّاج-كور: `neutral-standards.md` يحدّ المعايير المشتركة (أدوار، أوامر، رسائل، توثيق بلا آلية عملية). |
| **Claude (الأصلي)** | symlink نسّاج إلى `NASSAJ.md` الكامل (كل شيء: hooks، compact، حصص، nanomodels، ultracode). لا تغيير. |
| **Codex** | المرحلة 0: `AGENTS.md` مولَّد مبدئياً (محايد 100%، بلا claude-only)؛ يُحقن في `CODEX_HOME` الخاص بكل مستخدم عبر symlink من `nassaj-dev/provisionUserDirs`. |
| **opencode (مستقبلاً)** | المرحلة 0: نفس ال `AGENTS.md` المولَّد؛ opencode يقرأه من `~/.config/opencode/AGENTS.md`. |
| **مؤشر الحوكمة بالواجهة** | شارة توضح: محكوم (AGENTS.md موجود) / غير محكوم (بلا تعليمات). |

---

## 3. المراحل

### المرحلة 0 — ✅ منجَزة (2026-07-11، commit `1ce2c4e` nassaj-core)

**الإنجازات:**
- تخريج المعايير المحايدة إلى `nassaj-core/docs/neutral-standards.md`.
- أتمتة `nassaj-core/scripts/build-agents` — يولّد مخرجات محايدة بـ targets (Claude native = symlink، Codex = `AGENTS.md`).
- بوابة `build-agents --check` تحقّق بايت-لبايت من تطابق الإعادة.

**معايير القبول ✅:**
- [x] `neutral-standards.md` توضيح المعايير
- [x] بوابة `--check` byte-identical للـ rerun
- [x] Codex target يُنسّق مع spike T-819

**المتابعات المغلقة:** ~~اختبار حارس 403~~ (مفتوح T-866/B4) · ~~تسرّب tempDir~~ (مفتوح T-864)

---

### المرحلة 1 — ⏳ قادمة (بوابة المالك)

**الغرض:** اعتماد `AGENTS.md` المولَّد كمصدر حوكمة Codex بدل `NASSAJ.md`.

**الخطوات:**
1. المالك يُقرّ الخطة (هذه الوثيقة) + ADR-056/057 + معايير M1.
2. `nassaj-dev` يمرّ `AGENTS.md` الحيّ من `nassaj-core` → `CODEX_HOME` لكل مستخدم في `provisionUserDirs`.
3. جلسة Codex تُطلق: تقرأ من `CODEX_HOME` أولاً (موجود) = **محكومة**.

**معايير القبول:**
- جلسة Codex محكومة تعكس `neutral-standards.md` (لا ميكانيكا claude-only).
- حارس 403 على كتابة مزوّد مشترك = مستخدم non-owner ⇒ 403 مُختبر.
- لا تسرب أسرار المالك إلى `CODEX_HOME` المعزول (symlink لا نسخة).

**الملفات المتوقعة:**
- `server/services/user-initialization/provision-user-dirs.ts` — إضافة symlink لـ `AGENTS.md`.
- `tests/integration/provider-credential-write-guard.integration.test.ts` — اختبار 403.

---

### المرحلة 2 — ⏳ مستقبلاً (بعد قبول M1)

**الغرض:** التحقق الشامل من وصول التعليمات وتطبيق الحوكمة حقياً.

**الخطوات:**
1. تأكيد `mapPermissionModeToCodexOptions` يعمل ضمن عزل per-user.
2. اختبار spike: جلسة Codex تقرأ من `CODEX_HOME/AGENTS.md` = ✅ محكومة.
3. محاكاة multi-user: كل مستخدم لديه symlink منفصل = لا تسرب بيانات.

**معايير القبول:**
- كل مستخدم مُهيّأ لديه `AGENTS.md` في `CODEX_HOME`.
- آلية ابتلاع Codex مؤكَّدة على مسار حقيقي (لا fixtures).

---

### المرحلة 3 — ⏳ مستقبلاً

**الغرض:** عرض حالة الحوكمة في الواجهة لكل محرّك/جلسة.

**الخطوات:**
1. واجهة تفحص وجود `AGENTS.md` عند اختيار محرّك.
2. شارة توضيح: محكوم (AGENTS.md ✓) / غير محكوم (بلا تعليمات ✗).

**معايير القبول:**
- الشارة تعكس الحالة الفعلية (اختبار 3+ جلسات).

---

### المرحلة 4 — ⏳ اختيارية (مستقبل بعيد)

**الغرض:** تقسيم `NASSAJ.md` نفسه إلى أقسام مرتبة حسب الاستخدام.

**ملاحظة:** هذه المرحلة **مؤجَّلة وغير ملزمة** — تُفعَّل فقط لو طُلبت بوضوح.

---

## 4. حدود النشر

| النشاط | الحالة |
|---|---|
| **تطوير/commit محلي** | ✅ مسموح، يُشغّل الجلسات المحكومة على الظل. |
| **`git push` لـ nassaj-core/nassaj-dev** | ❌ **محظور** — ينتظر إذن المالك المكتوب. |
| **تعميم أسطولي** | ❌ **محظور** — ينتظر بعد معايير M1 وإقرار المالك. |

---

## 5. المرجعيات التقنية

| المرجع | العلاقة |
|---|---|
| ADR-018 | `build-agents` — مصدر واحد → مخرجات محايدة. |
| ADR-047/T-224 | واصف قدرات المزوّدات — ربط capabilities لكل محرّك. |
| ADR-056 | فصل حوكمة نسّاج (النسخة الكاملة من هذه الخطة). |
| ADR-057 | حقن Codex عبر symlink محايد. |
| commit `1ce2c4e` | nassaj-core — المرحلة 0 المنجَزة. |
| commit `52b76702` | nassaj-dev — تصليب Codex. |
| T-819 | Spike: ابتلاع Codex لـ `AGENTS.md` — ✅ مؤكَّد. |
| T-864/T-866 | متابعات: تسرّب tempDir + حارس 403. |

---

## 6. ملاحظات

- **عزل per-user:** كل مستخدم symlink خاص → بلا تسرب أسرار المالك إلى CODEX_HOME المشترك.
- **بلا copy:** symlink دائماً (مصدر واحد مكان وحيد) — لا انجراف.
- **الحوكمة ≠ الوظيفة:** جلسات Codex تعمل بسلام بلا حوكمة (commit `52b76702`)؛ الحوكمة ضمان أمان وامتثال، لا شرط وظيفي.
