# ADR-057: حقن حوكمة Codex عبر نسخة محمية في CODEX_HOME

**التاريخ:** 2026-07-11 (الخطة)، 2026-07-12 (التصليب: from symlink to copy) · **الحالة:**
معتمد (قرار المالك 2026-07-11 + تصليب 2026-07-12) · **المُقترِح:** architect ·
**المراجعة:** qa-critic + تحقّق spike (T-819)

**التعديلات الأخيرة:** commits d0f97941 (بصمة + نسخة محمية) + dc211d7a (fail-closed).

---

## 1. السياق

**المرجع الأساسي:** ADR-056 (الفصل المعماري — مصدر واحد + توليد محرّك-محدد)

Codex SDK (`@openai/codex-sdk`) يقرأ `$CODEX_HOME/AGENTS.md` عند الإطلاق (spike T-819
مؤكّد 2026-07-11). nassaj-dev اليوم يحقن حوكمة نسّاج في `CODEX_HOME` — جلسات Codex تُطلق
بتعليمات محايدة محمية.

**الحل البنيوي (مُعدَّل 2026-07-12):** `CODEX_HOME` لكل مستخدم = نسخة حقيقية محمية 0444
من `AGENTS.md` المولَّد المشترك من nassaj-core، مع تطابق بصمة sha256 لضمان الهوية
(ليس مجرد existence). النسخة (لا symlink): حماية من كتابة turn full-access عبر link.

**البدائل المرفوضة:**
1. **symlink مباشر:** جلسة danger-full-access قد تكتب عبر الـ link وتعطّب حوكمة الأسطول.
2. **مسار مشترك hardcoded:** بلا عزل — يفقد multi-user سلامة الخصوصية.
3. **بلا حوكمة:** الحالة السابقة — جلسات Codex بلا ضمانات أمن.

---

## 2. القرار

### الحل (معدَّل 2026-07-12)

```
nassaj-core/AGENTS.md  ← مصدر الحقيقة (مُولَّد بـ build-agents، neutral)
    ↑
    │ read sha256
    │
nassaj-dev/provisionUserDirs + codex-governance-material
    ↓
/home/<user>/.codex/AGENTS.md  ← نسخة محمية 0444 per-user
                                 محكومة بصمة = source fingerprint
    ↑
    └─ جلسة Codex تقرأها عند الإطلاق = محكومة

fail-closed spawn guard (codex-governance.ts):
  ├─ fstat لا lstat (symlink يفشل، حتى كسر)
  └─ sha256 المصدر = sha256 نسخة (الهوية، لا وجود فقط)
     إن فشل: rewrite + retry
```

### الخطوات

#### الخطوة 1: `provisionUserDirs` يحقن نسخة محمية (nassaj-dev)

**الملف:** `server/services/isolation/provision-user-dirs.js` (committed ✅)

**الكود المطبَّق (أنظر provision-user-dirs.js:345-362):**
```javascript
// عند إنشاء مستخدم جديد
const codexDir = path.join(userRoot, '.codex');
ensureDir(codexDir);

// Neutral Codex governance (ADR-057 §5 — MANDATORY, fail-closed at spawn):
// materialize AGENTS.md into every user's isolated CODEX_HOME as a real,
// read-only (0444) COPY of the neutral source so a spawned Codex session
// reads nassaj's governance on launch.
materializeGovernanceCopy(codexDir);  // → provision-user-dirs.js:362
```

**المسار:** `CODEX_HOME` = `~/.nassaj-users/<userId>/.codex` (عزل OS مملوك uid nassaj 0700)

**الآلية الحالية (codex-governance-material.js):**
- readNeutralGovernance() → reads ~./claude/AGENTS.md + sha256 fingerprint
- materializeGovernanceCopy(codexDir) → removes stale/symlink + writes 0600 + chmod 0444
- governanceMatchesSource(agentsPath) → lstat (rejects symlink) + content verification

**الاستثناءات المعالَجة:**
- ملف عادي موجود (لا symlink) ← remove + rewrite
- symlink (من نسخة سابقة) ← remove + rewrite نسخة حقيقية
- محتوى مختلف / مفقود ← rewrite بمصدر جديد
- مصدر neutral غير متاح ← fail-closed (لا كتابة، guard يرفض spawn)

#### الخطوة 2: Codex يقرأ نسخة محمية (SDK ← آلية Codex)

**لا عمل مطلوب:** Codex يقرأ `$CODEX_HOME/AGENTS.md` تلقائياً؛ الملف حقيقي 0444 يقرأه
بسلام. أي محاولة كتابة خلال turn danger-full-access تفشل (permission denied).

#### الخطوة 3: حارس الإطلاق fail-closed (codex-governance.ts، spawn time)

**آلية الحماية:**
```typescript
// قبل تشغيل جلسة Codex
const isGovernanceValid = governanceMatchesSource(agentsPath);
if (!isGovernanceValid) {
  // Attempt fast repair (call provisionUserDirs / materializeGovernanceCopy)
  // Retry check; if still fails → BLOCK spawn with 403
  throw new Error('Codex governance failed — session blocked (fail-closed)');
}
```

**التحقّق الحقيقي:**
```bash
# مستخدم محدَّد أطلق جلسة Codex
$ ls -l ~/.nassaj-users/<userId>/.codex/AGENTS.md
# → -r--r--r-- nassaj nassaj ... AGENTS.md (0444، ملف حقيقي لا symlink)

$ sha256sum ~/.nassaj-users/<userId>/.codex/AGENTS.md
# → يجب أن يساوي sha256 ~/.claude/AGENTS.md (المصدر)

# fail-closed spawn guard checked this before launch; if mismatch
# detected → rewrite + retry; if still fails → 403
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

| الحالة | الآلية | الحالة الناتجة |
|---|---|---|
| نسخة مفقودة | provision: write 0600 + chmod 0444. | ✅ محكومة next turn. |
| symlink قديم (من المحاولة الأولى) | provision: rmSync removes link + materialize real file. | ✅ محكومة next turn. |
| محتوى مختلف / دريفت | spawn guard: detects sha256 mismatch → call materialize + retry. | ✅ محكومة إن نجح repair؛ ❌ 403 إن failed repair. |
| مصدر neutral مفقود | materialize returns false; spawn guard logs blocked-sessions marker + 403. | ❌ Codex **محظور** (fail-closed) — ينتظر إعادة توليد build-agents. |
| مستخدم chmod -r نسختهم | provision idempotent; spawn guard retry لـ chmod 0444. | ⚠️ edge case (نادر، يتطلب evil-uid)؛ fail-closed holds. |
| permission denied على الكتابة | mkdirSync / writeFileSync fail → materialize returns false → spawn blocks. | ❌ Codex محظور (fail-closed) — متطلبات FS مرضية عند first provision. |

---

## 6. معايير القبول

### التطبيق (nassaj-dev) ✅ منجَز
- [x] `server/services/isolation/provision-user-dirs.js` — materialize نسخة محمية عند إنشاء
  مستخدم (commit d0f97941).
- [x] نسخة مقروءة من `~/.claude/AGENTS.md` بـ sha256 fingerprint (codex-governance-material.js).
- [x] نسخة محمية 0444 per-user قابلة للقراءة فقط (محاولة كتابة من danger-full-access تفشل).
- [x] fail-closed: نسخة فاشلة / مفقودة / مختلفة = لا إطلاق Codex (codex-governance.ts).

### التحقّق (Spike T-819 + M1) ✅ منجَز
- [x] جلسة Codex محكومة: اختبار realworld على بيانات التكامل (25/25 ✅).
- [x] multi-user: كل user نسخة محمية ← نفس `AGENTS.md` fingerprint (بلا collision).
- [x] بلا تسريب: `AGENTS.md` محايد (لا أسرار مالك، لا APIkeys) — neutral-standards.md.

### الاختبارات ✅
```bash
# وحدة: نسخة محمية 0444 يُنشأة بسلام
unit: codex-governance-material.materializeGovernanceCopy() ✅

# تكامل: جلسة Codex تقرأها بدون توسع أوامر Claude
integration: launchCodexSession() → governanceMatchesSource ✅

# spike: تأثر Codex الفعلي على اشتراك آلي
spike: Codex جلسة → codex-governance.ts guard ✅
```

---

## 7. الافتراضات

| الافتراض | الحالة | الخطر |
|---|---|---|
| Codex يقرأ `$CODEX_HOME/AGENTS.md` | ✅ مؤكّد (SDK T-819) | منخفض |
| `~/.claude/AGENTS.md` متاح (symlink → nassaj-core) | ✅ bootstrap-node.sh يضعه | متوسط — متابعة أ أعلاه |
| نسخة محمية 0444 لا تُكتب من danger-full-access | ✅ مختبَر (perm denied) | منخفض |
| spawn guard يفشل مغلق (يرفض Codex) | ✅ (codex-governance.ts) | منخفض |
| materializeGovernanceCopy + reprovision idempotent | ✅ (provision-user-dirs.js:262+) | منخفض |

---

## 8. البدائل المرفوضة (قبل + بعد التصليب)

| البديل | السبب |
|---|---|
| **symlink مباشر (قديم)** | جلسة danger-full-access قد تكتب عبر الـ link → تعطّب حوكمة الأسطول (write-through corruption). |
| **hardlink** | بلا فائدة (نفس inode) + بلا فصل مرئي. |
| **مسار عام مشترك (بلا copy)** | بلا عزل — مستخدمون متعددون في مسار واحد (خطر تسرب بيانات). |
| **نسخة + watcher** | مراقب تغييرات على nassaj-core/AGENTS.md → نسخة للمستخدمين | انجراف + فجوة زمنية + overhead. |
| **ملف إعدادات يشير للمسار** | Codex SDK لا يقرأ `path-to-agents` — يتوقع `./AGENTS.md` مباشرة. |
| **full-access بلا تصليب** | المتجهات (أ) (ب) (ج) في plan/ — تقليل danger-full-access البديل (T-873). |

---

## 9. المخاطر المتبقية والمتابعات

| المتجه | الخطر | الحل | الأولوية | المتابعة |
|---|---|---|---|---|
| **(أ)** المصدر المحايد قابل للكتابة | uid nassaj كتابة ~/.claude/AGENTS.md (بصمة تطابق المعطوب) | chmod 0444 المصدر + مِلكية منفصل | عالية | devops على nassaj-core |
| **(ب)** config.toml خبيث في شجرة مستخدم | full-access يكتب CODEX_HOME/config.toml ← turn تالي | حارس إطلاق على كل ملفات CODEX_HOME | متوسطة | متابعة مفتوحة |
| **(ج)** TOCTOU على codexHome | فجوة spawn بين فحص وقراءة (edge case) | قفل per-user + realpath/lstat الأب | منخفضة | اختياري |
| **(د)** تقليص danger-full-access | متجهات (أ) (ب) (ج) أصلها full-access بلا sandbox | workspace-write افتراضي + تصعيد صريح | عالية | قرار المالك T-873 |

---

## 10. حالة qa-critic والفيتو

**الفيتو:** GO مشروطاً بتوثيق (wf/بوابة 2026-07-13).

**الشروط المستكملة:**
- [x] تصليب المنفذ مختبَر (25/25 ثنائي حقيقي، 0 skipped).
- [x] fail-closed يرفض Codex بلا AGENTS.md مطابقة (governanceMatchesSource + lstat).
- [x] بصمة sha256 محمية الهوية (لا mere existence).
- [x] نسخة محمية 0444 لا symlink (prevent write-through).
- [x] توثيق المخاطر المتبقية (أعلاه) + توصيات.

**الشروط المعلَّقة:**
- [ ] متابعة (أ): تصليب المصدر المحايد (devops/nassaj-core).
- [ ] متابعة (د): قرار المالك على danger-full-access (T-873، due 2026-07-14).

---

## 11. الروابط

| المرجع | العلاقة |
|---|---|
| **ADR-056** | المعمارية الأم — فصل الحوكمة. |
| **ADR-018** | `build-agents` — توليد AGENTS.md محايد. |
| **T-819 (Spike)** | Codex يقرأ `AGENTS.md` — ✅ مؤكّد. |
| **T-873** | قرار المالك: تقليص danger-full-access (due 2026-07-14). |
| **docs/plans/CODEX-GOVERNANCE-DECOUPLING-2026-07-11.md** | الخطة المرحلية + المخاطر المتبقية. |
| **docs/reviews/CODEX-INTEGRATION-REVIEW-2026-07-11.md** | المراجعة الأمنية (qa-critic). |
| **commit d0f97941** | بصمة sha256 + نسخة محمية 0444. |
| **commit dc211d7a** | حارس إطلاق fail-closed. |

---

## 12. الملاحظات

- **نسخة ≠ symlink:** نسخة حقيقية 0444 = حماية من write-through corruption (worst-case: مستخدم واحد).
- **بصمة ≠ existence:** "محكوم" = sha256 match، لا مجرد ملف موجود.
- **fail-closed ≠ fail-open:** لا ترقيع fallback — غياب حوكمة = رفض spawn.
- **مسار mutability:** nassaj-core/AGENTS.md يُكتب من build-agents فقط (CI آلية).
- **الأسطول:** كل عقدة توفّر `nassaj-core/AGENTS.md` (عبر `bootstrap-node.sh`) + per-user copy
  isolate (0700 uid nassaj).
