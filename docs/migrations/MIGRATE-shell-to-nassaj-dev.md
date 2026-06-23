# خطة هجرة: نقل محادثات «القشرة» claudecodeui-dev إلى nassaj-dev
# Migration Plan: Move "shell" claudecodeui-dev conversations into nassaj-dev

> الحالة: **مسوّدة للتنفيذ اليدوي — لم تُنفَّذ بعد.** السكربت المرافق `scripts/migrate-shell-to-nassaj-dev.sh` يعمل **dry-run افتراضياً** ولا يغيّر شيئاً إلا بعلم `--apply`.
> Status: **draft for manual execution — NOT yet executed.** The companion script defaults to **dry-run**; it changes nothing unless invoked with `--apply`.

---

## 1. ملخص الوضع — Situation Summary

مشروع `claudecodeui-dev` كان «قشرة» فارغة (مجلد `/home/nassaj/Project/claudecodeui-dev` لا يحوي كوداً، فقط `docs/` و`.tmp/` و`.claude/`). الكود الحقيقي في `/home/nassaj/Project/nassaj-dev`. لأسباب تاريخية، جلسات Claude Code العاملة من القشرة سجّلت `cwd = /home/nassaj/Project/claudecodeui-dev`، فظهرت في الواجهة كمشروع منفصل. الهدف: دمجها تحت مشروع **nassaj-dev** لتظهر محادثاتها في مكانها الصحيح.

### الأرقام المؤكَّدة (قراءة فقط)

| البند | القيمة |
|---|---|
| ملفات jsonl في الدلو | **28** ملف، أول سطر `cwd = /home/nassaj/Project/claudecodeui-dev` في كلّها |
| حجم الدلو | ~116 MB |
| صفوف `sessions` بـ `project_path = …/claudecodeui-dev` | **30** صفّاً |
| منها جلسات Claude (jsonl داخل الدلو) | 28 |
| منها جلسات **Antigravity** (jsonl تحت `~/.gemini/antigravity-cli/brain/…`) | **2** — ملفاتها **خارج الدلو ولا تُلمَس**، يُحدَّث صفّها في DB فقط |
| مجلد memory | `…/-home-nassaj-Project-claudecodeui-dev/memory/` (داخل الدلو، ~19 ملف) |
| صفوف `sessions` بـ `project_path = …/nassaj-dev` حالياً | 0 |

---

## 2. المخزن الفيزيائي الدقيق — Exact Physical Store

- `~/.claude` ⟶ symlink ⟶ `/home/nassaj/nassaj-core`.
- `/home/nassaj/.nassaj-users/1/.claude/projects` ⟶ نفس الهدف ⟶ `/home/nassaj/nassaj-core/projects`.
- **المخزن الفيزيائي الوحيد** (كل المنافذ symlinks تشير إليه):
  ```
  /home/nassaj/nassaj-core/projects/
  ```
- **الدلو الفيزيائي للمصدر** (مجلد حقيقي، ليس symlink):
  ```
  /home/nassaj/nassaj-core/projects/-home-nassaj-Project-claudecodeui-dev/
  ```
- **الدلو الوجهة** (غير موجود بعد، سيُنشأ بالنقل):
  ```
  /home/nassaj/nassaj-core/projects/-home-nassaj-Project-nassaj-dev/
  ```

> **خلاصة الطوبولوجيا:** إعادة التسمية/الدمج **مرّة واحدة على المخزن الفيزيائي** تنعكس تلقائياً على كل المنافذ symlink (بما فيها `~/.claude` و`.nassaj-users/1/.claude`). لا حاجة لتكرار العملية على أكثر من مسار.

---

## 3. موقع قاعدة البيانات ومخططها — Database Location & Schema

- ملف SQLite الحيّ (يحوي جدول `sessions`):
  ```
  /home/nassaj/.local/share/nassaj-dev/db.sqlite
  ```
  (يُحَلّ من `DATABASE_PATH` في `.env` وفي بيئة pm2 لخدمة `nassaj-dev`؛ ملف `database/auth.db` داخل المشروع **قديم/legacy** ولا يحوي `sessions`.)

- مخطط `sessions`:
  ```sql
  CREATE TABLE sessions (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      custom_name TEXT,
      project_path TEXT,
      jsonl_path TEXT,
      isArchived BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id),
      FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL ON UPDATE CASCADE
  );
  ```
- مخطط `projects` (المفتاح الفريد هو `project_path`):
  ```sql
  CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      custom_project_name TEXT DEFAULT NULL,
      isStarred BOOLEAN DEFAULT 0,
      isArchived BOOLEAN DEFAULT 0
  );
  ```
- جداول مرتبطة بـ `session_id` (لا تتأثر لأن `session_id` لا يتغيّر): `session_participants` (34 صفّاً للجلسات المعنية)، `session_agents_*`، `message_authors`.

### ⚠️ ملاحظة المفاتيح الأجنبية (حرجة)

`PRAGMA foreign_keys` = **OFF** على الاتصال الحيّ (الافتراضي في better-sqlite3؛ الكود لا يُفعّلها وقت التشغيل، بل فقط داخل خطوات migration معيّنة). لذلك **`ON UPDATE CASCADE` لن يعمل تلقائياً** عند تعديل `projects.project_path` يدوياً عبر `sqlite3` CLI ما لم نُفعّل `PRAGMA foreign_keys=ON` في نفس الجلسة. السكربت يعالج هذا بأن **يحدّث `sessions.project_path` صراحةً** (لا يعتمد على الـ CASCADE)، وهو أكثر أماناً وحتمية. كذلك صفّ `projects` لوجهة nassaj-dev **موجود مسبقاً**، لذا لا ننشئ صفّ مشروع جديداً ولا نعيد تسمية الصفّ القديم — بل **نعيد إسناد الجلسات** إلى صفّ nassaj-dev القائم، ثم نحذف صفّ projects اليتيم claudecodeui-dev.

---

## 4. سلوك المزامِن — Synchronizer Behavior

المزامِن: `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`.

- **القراءة:** يقرأ أول سطر صالح من كل jsonl، يأخذ `sessionId` + `cwd`، والأخير يصبح `project_path`. يكتب أيضاً `jsonl_path` = المسار الكامل للملف عبر `~/.claude/projects/…`.
- **الإدراج = upsert:** `sessionsDb.createSession` يستخدم `INSERT … ON CONFLICT(session_id) DO UPDATE` — أي **لا تكرار**: صفّ بنفس `session_id` يُحدَّث (يُحدَّث `project_path` و`jsonl_path` من القيم الجديدة). كما يستدعي `projectsDb.createProjectPath(cwd)` فيُنشئ صفّ مشروع للمسار الجديد إن غاب.
- **المحفِّزات الثلاثة:**
  1. **عند الإقلاع** (`initializeSessionsWatcher`): `synchronizeSessions()` ⟶ `synchronize(since = scan_state.last_scanned_at)`. لكن `findFilesRecursivelyCreatedAfter` يفلتر بـ **`birthtime > lastScanAt`**. إعادة كتابة `cwd` تغيّر `mtime` لا `birthtime`، لذلك **الإقلاع وحده قد لا يلتقط التغيير**. أمّا **النقل/إعادة التسمية** فيُنشئ مساراً جديداً للملفات؛ سلوك birthtime بعد `mv` داخل نفس الـ filesystem يبقي birthtime الأصلي، فقد لا تُلتقط أيضاً عبر مسار `since`.
  2. **chokidar watcher** (يراقب `~/.claude/projects`, polling كل 6 ثوانٍ, `followSymlinks: false`): أي `add`/`change` على jsonl يستدعي `synchronizeFile` الذي **يتجاهل `since`** ويعيد الفهرسة دائماً. نقل الملفات إلى دلو جديد يولّد أحداث `add` بالمسار الجديد ⟶ المزامِن يعيد إدراجها بـ `cwd` الجديد. **هذا أهم محفِّز عملي.**
  3. **عند تصفّح الواجهة** (`getProjectsWithSessions`) يُستدعى `synchronizeSessions()` مجدداً.

> **الاستنتاج:** الاعتماد على المزامِن وحده غير حتمي (birthtime، توقيت watcher، سباقات). لذلك **نُصالح DB صراحةً في السكربت** فلا ننتظر إعادة فهرسة، ونترك المزامِن لاحقاً يؤكّد لا أكثر (idempotent: upsert على نفس session_id بنفس القيم لا يضرّ).

### هل نحتاج UPDATE أم DELETE+resync؟

**UPDATE كافٍ ومفضَّل.** لأن `session_id` ثابت و`createSession` upsert، إعادة إسناد `project_path` + تصحيح `jsonl_path` عبر `UPDATE` يحقّق الهدف فوراً دون فقد المسمّيات (`custom_name`) ولا صفوف `session_participants`. الـ DELETE+resync أخطر (يفقد custom_name/participants ويعتمد على توقيت المزامِن) ولا داعي له.

### هل نحتاج restart للخدمة؟

**لا.** المصالحة المباشرة على DB + إعادة تسمية الدلو تكفي، والواجهة ستعكسها عند أول `synchronizeSessions` (تصفّح/watcher). **تجنُّب restart مقصود** لأن:
- حارس عميل Claude Code يعترض `pm2 restart` (يُطلب من المستخدم بطرفيته إن لزم — لكن هنا لا يلزم).
- جلسة العمل قد تكون ابنة عملية الخدمة؛ restart قد يقتلها.

> إن رغب المستخدم بتحديث فوري مضمون بدل انتظار الـ watcher، يكفي **تصفّح الواجهة** (يستدعي المزامِن) — لا restart.

---

## 5. الشروط المسبقة الصارمة — Hard Preconditions

1. **التنفيذ من جلسة `cwd ≠ /home/nassaj/Project/claudecodeui-dev`.** الجلسة الحالية التي ألّفت هذه الخطة تعمل فعلياً من القشرة — **لا تُنفَّذ الهجرة من هذه الجلسة.** افتح طرفية/جلسة جديدة من `/home/nassaj/Project/nassaj-dev` أو أي مسار آخر. السكربت **يُجهض** إذا اكتشف `PWD = …/claudecodeui-dev`.
2. **يُفضَّل عدم وجود جلسة Claude Code حيّة تكتب في الدلو** أثناء الهجرة (تجنّب كتابة سطر جديد بـ cwd قديم في ملف يُنقل). إن وُجدت، أغلقها أو أنهِها لنقطة آمنة أولاً.
3. **DB غير مقفلة:** السكربت يفحص قابلية القراءة/عدم وجود قفل كتابة معلّق (`PRAGMA quick_check` + محاولة `BEGIN IMMEDIATE` على نسخة، لا على الحيّ مباشرة قبل النسخ الاحتياطي).
4. **الدلو الوجهة غير موجود مسبقاً بمحتوى متعارض.** إن وُجد `…/-home-nassaj-Project-nassaj-dev/` بملفات، يُجهض السكربت ويطلب فضّ التعارض يدوياً.
5. مساحة قرص ≥ ضعف حجم الدلو (للنسخة الاحتياطية tar).

---

## 6. الخطوات بالترتيب — Ordered Steps (each step → why → checkpoint)

> ينفّذها السكربت بـ `--apply`. كل خطوة لها نقطة تحقّق.

### الخطوة 0 — فحوص ما قبل التنفيذ
**لماذا:** منع التنفيذ في ظرف خطر (cwd خطأ، دلو وجهة متعارض، DB مقفلة).
**تحقّق:** السكربت يطبع «PRECHECKS PASSED» أو يُجهض برسالة واضحة.

### الخطوة 1 — نسخة احتياطية موسومة بختم زمني
**لماذا:** نقطة rollback كاملة.
**ماذا:** `tar` للدلو الفيزيائي + نسخ `db.sqlite` (و`-wal`/`-shm` إن وُجدا) إلى:
```
/home/nassaj/.local/share/nassaj-dev/migration-backups/<STAMP>/
  ├─ bucket-claudecodeui-dev.tar.gz
  ├─ db.sqlite (نسخة)
  └─ sessions-before.csv  (لقطة الصفوف المعنية)
```
الختم `<STAMP>` يُمرَّر كوسيط `--stamp` أو متغيّر `MIGRATION_STAMP` (لإعادة تشغيل آمنة على نفس النسخة، لا يُولّد من تاريخ النظام داخل منطق حرج).
**تحقّق:** الملفات موجودة وحجم tar > 0، والـ CSV يحوي 30 صفّاً.

### الخطوة 2 — إعادة كتابة `cwd` فقط داخل الـ 28 jsonl
**لماذا:** ليصبح المصدر الحقيقي (المحادثة) منسوباً لـ nassaj-dev، فيتّسق مع المزامِن مستقبلاً.
**ماذا:** معالجة **سطراً-سطراً بـ node** (لا `sed` أعمى): لكل سطر، `JSON.parse`، إن كان `obj.cwd === '/home/nassaj/Project/claudecodeui-dev'` يُستبدل بـ `'/home/nassaj/Project/nassaj-dev'` ثم `JSON.stringify` وإعادة الكتابة. **لا تُلمَس** أي حقول مسار أخرى داخل الرسائل التاريخية (tool-results، مسارات في النصوص) — `cwd` هو الحقل الوحيد الذي يحدّد نسبة المشروع. كتابة ذرّية (ملف مؤقت ثم rename).
**تحقّق:** كل ملف يبقى JSONL صالحاً (عدد الأسطر ثابت)، و0 أسطر متبقية بـ cwd القديم في أول سطر.

### الخطوة 3 — نقل/دمج الدلو إلى الاسم الجديد (يشمل memory)
**لماذا:** اسم الدلو مشتقّ من المسار؛ المزامِن وresume يقرآن عبر مسار الدلو، ويجب أن يطابق الاسم الجديد.
**ماذا:**
- إن لم يوجد الدلو الوجهة: `mv` الدلو الفيزيائي كاملاً (يحوي `memory/`) إلى الاسم الجديد.
- إن وُجد الدلو الوجهة فارغاً/بلا تعارض: نقل المحتويات بداخله، ودمج `memory/` (لا استبدال ملفات قائمة دون نسخة احتياطية — السكربت يُجهض عند تعارض اسم ملف memory لم يُحسم).
**تحقّق:** `…/-home-nassaj-Project-nassaj-dev/` يحوي 28 jsonl + `memory/`، والدلو القديم لم يعد موجوداً (أو فارغ).

### الخطوة 4 — مصالحة DB (UPDATE صريح، بلا اعتماد على CASCADE)
**لماذا:** إظهار الجلسات تحت nassaj-dev فوراً وتصحيح `jsonl_path` ليطابق الدلو الجديد.
**ماذا (داخل معاملة واحدة على الحيّ، بعد النسخ الاحتياطي):**
```sql
BEGIN IMMEDIATE;

-- 1) إعادة إسناد كل الجلسات (28 Claude + 2 Antigravity) لمشروع nassaj-dev القائم
UPDATE sessions
   SET project_path = '/home/nassaj/Project/nassaj-dev'
 WHERE project_path = '/home/nassaj/Project/claudecodeui-dev';

-- 2) تصحيح jsonl_path لجلسات Claude (الـ 28 داخل الدلو) فقط — استبدال اسم الدلو في المسار
--    (لا تُلمَس مسارات Antigravity تحت ~/.gemini/antigravity-cli/brain/)
UPDATE sessions
   SET jsonl_path = replace(
         jsonl_path,
         '/-home-nassaj-Project-claudecodeui-dev/',
         '/-home-nassaj-Project-nassaj-dev/')
 WHERE jsonl_path LIKE '%/-home-nassaj-Project-claudecodeui-dev/%';

-- 3) حذف صفّ projects اليتيم (لم تعد له جلسات)
DELETE FROM projects
 WHERE project_path = '/home/nassaj/Project/claudecodeui-dev';

COMMIT;
```
> صفّ `projects` لـ nassaj-dev موجود مسبقاً (`custom_project_name = 'nassaj-dev'`)، فلا ننشئه ولا نعيد تسمية القديم.
**تحقّق:** `SELECT count(*) … WHERE project_path='…/claudecodeui-dev'` = 0؛ و`…/nassaj-dev` = (القيمة السابقة + 30)؛ ولا صفّ projects باسم claudecodeui-dev.

### الخطوة 5 — تحقّق نهائي تلقائي
**لماذا:** ضمان اتّساق القرص+DB وقابلية فتح الملفات.
**ماذا:** السكربت يتأكّد أن كل `jsonl_path` للجلسات المنقولة موجود فعلياً على القرص (للـ 28 Claude)، وأن لا أثر للاسم القديم في DB، ويطبع ملخصاً.

---

## 7. خطة Rollback صريحة — من النسخة الاحتياطية

عند أي خلل، وبنفس `<STAMP>`:
1. **DB:** أوقف أي مزامنة جارية (تصفّح)، ثم انسخ `migration-backups/<STAMP>/db.sqlite` فوق `/home/nassaj/.local/share/nassaj-dev/db.sqlite` (واحذف `-wal`/`-shm` العالقين). (لا يحتاج restart؛ الاتصال التالي يقرأ الملف المستعاد. إن أصرّ الكاش الحيّ، يُطلب من المستخدم restart بطرفيته — أمر محجوب على العميل.)
2. **الدلو:** احذف الدلو الجديد `…/-home-nassaj-Project-nassaj-dev/` (إن نشأ من النقل وكان كل محتواه من المصدر)، ثم استخرج `bucket-claudecodeui-dev.tar.gz` لاستعادة الدلو الأصلي باسمه وموقعه الفيزيائي.
3. تحقّق: `SELECT count(*) … project_path='…/claudecodeui-dev'` = 30 من جديد، والدلو القديم موجود بـ 28 jsonl.

السكربت يطبع أوامر rollback الجاهزة في نهايته.

---

## 8. تقييم المخاطر وتخفيفها — Risk Assessment

| الخطر | الأثر | تخفيف السكربت |
|---|---|---|
| تخريب JSON بـ sed أعمى | فقد محادثات | معالجة سطراً-سطراً بـ `JSON.parse/stringify`، كتابة ذرّية، تحقّق صحّة بعدها |
| تنفيذ من جلسة القشرة (كتابة cwd قديم أثناء النقل) | تلوث/فقد سطر | إجهاض إذا `PWD = …/claudecodeui-dev` + شرط «لا جلسة حيّة على الدلو» |
| الاعتماد على CASCADE وهو معطّل (FK OFF) | جلسات يتيمة | UPDATE صريح على `sessions` لا اعتماد على CASCADE |
| لمس ملفات Antigravity الـ 2 خطأً | فقد جلسات مزوّد آخر | تحديث `jsonl_path` مشروط بـ `LIKE '%…claudecodeui-dev/%'` فقط؛ ملفات Antigravity خارج الدلو لا تُنقَل |
| تعارض دلو/memory موجود | استبدال صامت | إجهاض عند تعارض غير محسوم |
| قفل DB أثناء الكتابة | فساد جزئي | `BEGIN IMMEDIATE` + نسخة احتياطية قبل أي كتابة |
| عدم انعكاس على الواجهة | ارتباك | الواجهة تعيد المزامنة عند التصفّح/watcher؛ لا restart مطلوب |
| فقد custom_name/participants | فقد بيانات | UPDATE (لا DELETE) يحافظ عليها |
| birthtime/توقيت watcher غير حتمي | تأخّر ظهور | المصالحة المباشرة تجعل DB صحيحاً فوراً بصرف النظر عن المزامِن |

---

## 9. تشغيل السكربت — Running the Script

```bash
# 1) معاينة آمنة (افتراضي، لا تغيير):
bash /home/nassaj/Project/nassaj-dev/scripts/migrate-shell-to-nassaj-dev.sh

# 2) تنفيذ فعلي (من جلسة cwd ≠ claudecodeui-dev):
MIGRATION_STAMP="$(date +%Y%m%d-%H%M%S)" \
  bash /home/nassaj/Project/nassaj-dev/scripts/migrate-shell-to-nassaj-dev.sh --apply

# rollback (يطبعه السكربت بنفس STAMP):
bash /home/nassaj/Project/nassaj-dev/scripts/migrate-shell-to-nassaj-dev.sh --rollback --stamp <STAMP>
```
