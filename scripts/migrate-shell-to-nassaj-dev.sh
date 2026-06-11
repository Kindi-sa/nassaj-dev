#!/usr/bin/env bash
#
# migrate-shell-to-nassaj-dev.sh
# ------------------------------------------------------------------------------
# نقل محادثات «القشرة» claudecodeui-dev لتظهر تحت مشروع nassaj-dev.
# Move the "shell" claudecodeui-dev conversations under the nassaj-dev project.
#
# - dry-run افتراضياً: لا يغيّر شيئاً إلا بعلم --apply.
# - idempotent: إعادة التشغيل بعد نجاح جزئي آمنة (يتخطّى ما أُنجز).
# - لا يحتاج restart للخدمة (انظر الخطة، القسم 4).
#
# الخطة المرافقة: docs/migrations/MIGRATE-shell-to-nassaj-dev.md
#
# الاستخدام:
#   bash scripts/migrate-shell-to-nassaj-dev.sh                 # معاينة (dry-run)
#   MIGRATION_STAMP=YYYYmmdd-HHMMSS bash ... --apply            # تنفيذ فعلي
#   bash scripts/migrate-shell-to-nassaj-dev.sh --rollback --stamp <STAMP>
# ------------------------------------------------------------------------------

set -euo pipefail

# ============================ ثوابت قابلة للتعديل ==============================
OLD_PROJECT_PATH="/home/nassaj/Project/claudecodeui-dev"
NEW_PROJECT_PATH="/home/nassaj/Project/nassaj-dev"

# الاسم المُرمَّز للدلو (استبدال "/" بـ "-")
OLD_BUCKET_NAME="-home-nassaj-Project-claudecodeui-dev"
NEW_BUCKET_NAME="-home-nassaj-Project-nassaj-dev"

# المخزن الفيزيائي الوحيد (كل منافذ ~/.claude/projects وغيرها symlinks إليه)
PHYS_PROJECTS_DIR="/home/nassaj/nassaj-core/projects"
OLD_BUCKET_DIR="${PHYS_PROJECTS_DIR}/${OLD_BUCKET_NAME}"
NEW_BUCKET_DIR="${PHYS_PROJECTS_DIR}/${NEW_BUCKET_NAME}"

# مسار jsonl_path كما يُخزَّن في DB يستعمل بادئة symlink (لا الفيزيائية):
DB_PATH_OLD_FRAGMENT="/${OLD_BUCKET_NAME}/"
DB_PATH_NEW_FRAGMENT="/${NEW_BUCKET_NAME}/"

# قاعدة البيانات الحيّة (DATABASE_PATH لخدمة nassaj-dev)
DB_FILE="/home/nassaj/.local/share/nassaj-dev/db.sqlite"

BACKUP_ROOT="/home/nassaj/.local/share/nassaj-dev/migration-backups"
# ==============================================================================

APPLY=0
ROLLBACK=0
STAMP="${MIGRATION_STAMP:-}"

# ------------------------------- تحليل الوسائط --------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)    APPLY=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --stamp)    STAMP="${2:-}"; shift 2 ;;
    *) echo "وسيط غير معروف: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '%s\n' "$*"; }
info() { printf '\033[36m[i]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[ABORT]\033[0m %s\n' "$*" >&2; exit 1; }

# يُنفّذ الأمر فعلياً فقط في وضع --apply؛ غير ذلك يطبعه فقط (DRY-RUN).
run() {
  if [[ $APPLY -eq 1 ]]; then
    eval "$@"
  else
    printf '\033[90m[dry-run] %s\033[0m\n' "$*"
  fi
}

# ============================== وضع ROLLBACK =================================
if [[ $ROLLBACK -eq 1 ]]; then
  [[ -n "$STAMP" ]] || die "rollback يتطلب --stamp <STAMP>"
  BK="${BACKUP_ROOT}/${STAMP}"
  [[ -d "$BK" ]] || die "لا توجد نسخة احتياطية: $BK"
  info "Rollback من النسخة: $BK"
  log  "نفّذ يدوياً (أو شغّل بـ --apply):"
  log  "  cp -f '${BK}/db.sqlite' '${DB_FILE}'"
  log  "  rm -f '${DB_FILE}-wal' '${DB_FILE}-shm'"
  log  "  rm -rf '${NEW_BUCKET_DIR}'   # فقط إن نشأ كاملاً من النقل"
  log  "  tar -xzf '${BK}/bucket-claudecodeui-dev.tar.gz' -C '${PHYS_PROJECTS_DIR}'"
  if [[ $APPLY -eq 1 ]]; then
    cp -f "${BK}/db.sqlite" "${DB_FILE}"
    rm -f "${DB_FILE}-wal" "${DB_FILE}-shm" 2>/dev/null || true
    warn "حذف الدلو الجديد متروك يدوياً للأمان (تحقّق أولاً أنه كله من المصدر)."
    tar -xzf "${BK}/bucket-claudecodeui-dev.tar.gz" -C "${PHYS_PROJECTS_DIR}"
    ok "اكتمل rollback لقاعدة البيانات والدلو الأصلي."
  fi
  exit 0
fi

# =============================================================================
#                          الخطوة 0 — فحوص ما قبل التنفيذ
# =============================================================================
info "الخطوة 0: فحوص ما قبل التنفيذ"

# (0.أ) ليست جلسة القشرة
CUR_PWD="$(pwd -P)"
if [[ "$CUR_PWD" == "$OLD_PROJECT_PATH" || "$CUR_PWD" == "${OLD_PROJECT_PATH%/}" ]]; then
  die "PWD الحالي = ${OLD_PROJECT_PATH} (جلسة القشرة). نفّذ من جلسة/مسار آخر."
fi
ok "PWD ليس مسار القشرة: ${CUR_PWD}"

# (0.ب) وجود المخزن الفيزيائي والدلو المصدر
[[ -d "$PHYS_PROJECTS_DIR" ]] || die "المخزن الفيزيائي مفقود: $PHYS_PROJECTS_DIR"
if [[ ! -d "$OLD_BUCKET_DIR" ]]; then
  if [[ -d "$NEW_BUCKET_DIR" ]]; then
    warn "الدلو المصدر غير موجود لكن الوجهة موجودة — يبدو أن نقل القرص تمّ سابقاً (idempotent)."
  else
    die "لا الدلو المصدر ولا الوجهة موجودان. تحقّق من المسارات."
  fi
fi

# (0.ج) DB موجودة وسليمة (قراءة فقط)
[[ -f "$DB_FILE" ]] || die "قاعدة البيانات مفقودة: $DB_FILE"
command -v sqlite3 >/dev/null || die "sqlite3 غير مثبّت."
QC="$(sqlite3 "$DB_FILE" 'PRAGMA quick_check;' 2>/dev/null || true)"
[[ "$QC" == "ok" ]] || die "فحص سلامة DB فشل: $QC"
ok "DB سليمة (quick_check=ok)."

# (0.د) تعارض دلو الوجهة (موجود وبه ملفات لا تخصّ هذه الهجرة)
if [[ -d "$OLD_BUCKET_DIR" && -d "$NEW_BUCKET_DIR" ]]; then
  if [[ -n "$(ls -A "$NEW_BUCKET_DIR" 2>/dev/null || true)" ]]; then
    die "الدلو الوجهة موجود وغير فارغ بينما المصدر ما زال قائماً: تعارض يحتاج فضّاً يدوياً.
المصدر:  $OLD_BUCKET_DIR
الوجهة:  $NEW_BUCKET_DIR"
  fi
fi

# (0.هـ) لقطة الأعداد قبل
CNT_OLD_BEFORE="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sessions WHERE project_path='${OLD_PROJECT_PATH}';")"
CNT_NEW_BEFORE="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sessions WHERE project_path='${NEW_PROJECT_PATH}';")"
JSONL_ON_DISK="$( (ls -1 "${OLD_BUCKET_DIR}"/*.jsonl 2>/dev/null || true) | wc -l | tr -d ' ')"
info "قبل: sessions(claudecodeui-dev)=${CNT_OLD_BEFORE}، sessions(nassaj-dev)=${CNT_NEW_BEFORE}، jsonl على القرص=${JSONL_ON_DISK}"
ok "PRECHECKS PASSED"

# الختم الزمني (يُمرَّر لإعادة تشغيل آمنة؛ لا يُولَّد من تاريخ النظام داخل منطق حرج)
if [[ -z "$STAMP" ]]; then
  if [[ $APPLY -eq 1 ]]; then
    die "في وضع --apply مرّر MIGRATION_STAMP أو --stamp <STAMP> (لإعادة تشغيل آمنة على نفس النسخة)."
  else
    STAMP="DRYRUN-$(date +%Y%m%d-%H%M%S)"
    info "dry-run: STAMP افتراضي = ${STAMP}"
  fi
fi
BK="${BACKUP_ROOT}/${STAMP}"

# =============================================================================
#                       الخطوة 1 — نسخة احتياطية موسومة
# =============================================================================
info "الخطوة 1: نسخة احتياطية → ${BK}"
run "mkdir -p '${BK}'"
# tar للدلو الفيزيائي (إن وُجد المصدر بعد)
if [[ -d "$OLD_BUCKET_DIR" ]]; then
  run "tar -czf '${BK}/bucket-claudecodeui-dev.tar.gz' -C '${PHYS_PROJECTS_DIR}' '${OLD_BUCKET_NAME}'"
else
  warn "المصدر منقول مسبقاً؛ تخطّي tar للدلو (idempotent)."
fi
# نسخ DB (+ sidecars) عبر واجهة sqlite الآمنة على ملف حيّ
run "sqlite3 '${DB_FILE}' \".backup '${BK}/db.sqlite'\""
# لقطة CSV للصفوف المعنية
run "sqlite3 -header -csv '${DB_FILE}' \"SELECT session_id,provider,project_path,jsonl_path,custom_name FROM sessions WHERE project_path='${OLD_PROJECT_PATH}';\" > '${BK}/sessions-before.csv'"
ok "النسخة الاحتياطية جاهزة (أو معروضة في dry-run)."

# =============================================================================
#         الخطوة 2 — إعادة كتابة حقل cwd فقط داخل الـ jsonl (سطراً-سطراً)
# =============================================================================
info "الخطوة 2: إعادة كتابة cwd فقط داخل ملفات jsonl (node، كتابة ذرّية)"

# نولّد سكربت node مؤقت يعالج ملفاً واحداً بأمان.
NODE_REWRITER="$(mktemp /tmp/migrate-cwd-XXXXXX.mjs)"
cat > "$NODE_REWRITER" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [, , file, oldCwd, newCwd] = process.argv;
const tmp = file + '.migtmp';
const inp = fs.readFileSync(file, 'utf8');
// نحافظ على الفاصل الأخير كما هو (قد ينتهي الملف بسطر فارغ).
const lines = inp.split('\n');
let changed = 0;
const out = lines.map((line) => {
  if (!line.trim()) return line;            // أبقِ الأسطر الفارغة كما هي
  let obj;
  try { obj = JSON.parse(line); } catch { return line; } // سطر غير JSON: لا نلمسه
  if (obj && typeof obj === 'object' && obj.cwd === oldCwd) {
    obj.cwd = newCwd;                        // حقل cwd فقط؛ لا حقول مسار أخرى
    changed += 1;
    return JSON.stringify(obj);
  }
  return line;
});
if (changed === 0) { console.log(`SKIP(0) ${path.basename(file)}`); process.exit(0); }
// كتابة ذرّية: ملف مؤقت ثم rename
fs.writeFileSync(tmp, out.join('\n'));
// تحقّق سريع: نفس عدد الأسطر
const before = lines.length, after = fs.readFileSync(tmp,'utf8').split('\n').length;
if (before !== after) { fs.unlinkSync(tmp); console.error(`LINE-COUNT-MISMATCH ${file}`); process.exit(3); }
fs.renameSync(tmp, file);
console.log(`OK(${changed}) ${path.basename(file)}`);
NODE

# نختار مصدر الملفات: الدلو المصدر إن وُجد، وإلا الوجهة (لو نُقل القرص قبل DB).
SCAN_DIR="$OLD_BUCKET_DIR"
[[ -d "$OLD_BUCKET_DIR" ]] || SCAN_DIR="$NEW_BUCKET_DIR"

if [[ -d "$SCAN_DIR" ]]; then
  shopt -s nullglob
  for f in "${SCAN_DIR}"/*.jsonl; do
    run "node '${NODE_REWRITER}' '${f}' '${OLD_PROJECT_PATH}' '${NEW_PROJECT_PATH}'"
  done
  shopt -u nullglob
else
  warn "لا مجلد jsonl للمعالجة."
fi
run "rm -f '${NODE_REWRITER}'"
ok "إعادة كتابة cwd (أو معروضة في dry-run)."

# =============================================================================
#         الخطوة 3 — نقل/دمج الدلو إلى الاسم الجديد (يشمل memory)
# =============================================================================
info "الخطوة 3: نقل الدلو إلى ${NEW_BUCKET_NAME} (يشمل memory)"
if [[ -d "$OLD_BUCKET_DIR" && ! -d "$NEW_BUCKET_DIR" ]]; then
  # الحالة المثلى: إعادة تسمية ذرّية كاملة (يحافظ على memory/ بداخله).
  run "mv '${OLD_BUCKET_DIR}' '${NEW_BUCKET_DIR}'"
elif [[ -d "$OLD_BUCKET_DIR" && -d "$NEW_BUCKET_DIR" ]]; then
  # الوجهة موجودة وفارغة (تأكّدنا في الفحوص): انقل المحتويات بداخلها.
  warn "دمج المحتويات في دلو وجهة فارغ موجود."
  run "shopt -s dotglob; mv '${OLD_BUCKET_DIR}'/* '${NEW_BUCKET_DIR}'/ ; shopt -u dotglob"
  run "rmdir '${OLD_BUCKET_DIR}'"
else
  warn "الدلو منقول مسبقاً (idempotent): تخطّي."
fi
ok "نقل الدلو (أو معروض في dry-run)."

# =============================================================================
#     الخطوة 4 — مصالحة DB: UPDATE صريح (لا اعتماد على CASCADE المعطّل)
# =============================================================================
info "الخطوة 4: مصالحة قاعدة البيانات (معاملة واحدة)"
# لماذا UPDATE لا DELETE+resync: session_id ثابت و createSession upsert،
# فالتحديث المباشر يحافظ على custom_name وصفوف session_participants ويُظهر
# الجلسات فوراً دون انتظار توقيت المزامِن/watcher (انظر الخطة §4).
# لماذا UPDATE صريح على sessions: PRAGMA foreign_keys=OFF على الاتصال الحيّ،
# فـ ON UPDATE CASCADE لن يفعل شيئاً تلقائياً.
SQL_RECONCILE=$(cat <<SQL
BEGIN IMMEDIATE;
-- 1) إعادة إسناد كل الجلسات (Claude + Antigravity) لمشروع nassaj-dev القائم
UPDATE sessions
   SET project_path = '${NEW_PROJECT_PATH}'
 WHERE project_path = '${OLD_PROJECT_PATH}';
-- 2) تصحيح jsonl_path لجلسات الدلو فقط (لا تُلمَس مسارات Antigravity خارج الدلو)
UPDATE sessions
   SET jsonl_path = replace(jsonl_path, '${DB_PATH_OLD_FRAGMENT}', '${DB_PATH_NEW_FRAGMENT}')
 WHERE jsonl_path LIKE '%${DB_PATH_OLD_FRAGMENT}%';
-- 3) حذف صفّ projects اليتيم (صفّ nassaj-dev موجود مسبقاً فلا نُنشئه)
DELETE FROM projects
 WHERE project_path = '${OLD_PROJECT_PATH}';
COMMIT;
SQL
)
if [[ $APPLY -eq 1 ]]; then
  printf '%s\n' "$SQL_RECONCILE" | sqlite3 "$DB_FILE"
else
  printf '\033[90m[dry-run] sqlite3 %s <<SQL\n%s\nSQL\033[0m\n' "$DB_FILE" "$SQL_RECONCILE"
fi
ok "مصالحة DB (أو معروضة في dry-run)."

# =============================================================================
#                         الخطوة 5 — تحقّق نهائي تلقائي
# =============================================================================
info "الخطوة 5: تحقّق نهائي"
if [[ $APPLY -eq 1 ]]; then
  C_OLD="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sessions WHERE project_path='${OLD_PROJECT_PATH}';")"
  C_NEW="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sessions WHERE project_path='${NEW_PROJECT_PATH}';")"
  P_OLD="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM projects WHERE project_path='${OLD_PROJECT_PATH}';")"
  STALE_PATHS="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sessions WHERE jsonl_path LIKE '%${DB_PATH_OLD_FRAGMENT}%';")"
  MISSING=0
  while IFS= read -r jp; do
    [[ -z "$jp" ]] && continue
    [[ -f "$jp" ]] || { warn "ملف مفقود على القرص: $jp"; MISSING=$((MISSING+1)); }
  done < <(sqlite3 "$DB_FILE" "SELECT jsonl_path FROM sessions WHERE project_path='${NEW_PROJECT_PATH}' AND jsonl_path LIKE '%${DB_PATH_NEW_FRAGMENT}%';")

  log "  sessions(claudecodeui-dev) = ${C_OLD}  (متوقّع 0)"
  log "  sessions(nassaj-dev)       = ${C_NEW}  (متوقّع ${CNT_NEW_BEFORE} + ${CNT_OLD_BEFORE})"
  log "  projects(claudecodeui-dev) = ${P_OLD}  (متوقّع 0)"
  log "  jsonl_path بالاسم القديم    = ${STALE_PATHS}  (متوقّع 0)"
  log "  ملفات Claude مفقودة على القرص = ${MISSING}  (متوقّع 0)"
  [[ "$C_OLD" == "0" && "$P_OLD" == "0" && "$STALE_PATHS" == "0" && "$MISSING" == "0" ]] \
    && ok "التحقّق نجح: الهجرة متّسقة." \
    || die "التحقّق فشل — راجع أعلاه ونفّذ rollback إن لزم."
else
  info "dry-run: لا تحقّق على قيم حقيقية (لم يُنفَّذ شيء)."
fi

# =============================================================================
#                              ملخص + تعليمات rollback
# =============================================================================
log ""
info "ملخص:"
log  "  المخزن الفيزيائي: ${PHYS_PROJECTS_DIR}"
log  "  الدلو: ${OLD_BUCKET_NAME}  →  ${NEW_BUCKET_NAME}"
log  "  DB: ${DB_FILE}"
log  "  النسخة الاحتياطية: ${BK}"
log  "  المزامِن: لا restart مطلوب؛ الواجهة تعيد المزامنة عند التصفّح/watcher."
log ""
info "للتراجع عند الحاجة:"
log  "  bash $0 --rollback --stamp ${STAMP} --apply"
log ""
if [[ $APPLY -eq 1 ]]; then ok "اكتمل التنفيذ."; else warn "هذه معاينة DRY-RUN. أضِف --apply (مع MIGRATION_STAMP) للتنفيذ الفعلي."; fi
