#!/usr/bin/env bash
# ============================================================================
# safe-restart.sh  (B-95 / حادثة 2026-06-27 wf_ef5ba242)
# ----------------------------------------------------------------------------
# الغرض / Purpose:
#   بوّابة ما-قبل-إعادة-التشغيل (pre-restart gate) لعملية PM2 `nassaj-dev`.
#   تفحص سجلّات الـ workflows (journal.jsonl) عبر كل جلسات المشروع، وتكشف هل
#   هناك workflow حيّ (وكلاؤه ما زالوا يعملون). إن وُجد عملٌ حيّ → تُنذر وتؤجّل
#   (لا تعيد التشغيل)؛ إن لم يوجد → تمرّ بصمت (exit 0) ليُكمل المُشغِّل restart.
#
#   Pre-restart gate for the `nassaj-dev` PM2 process. Scans every project
#   session's workflow journals (journal.jsonl) for a LIVE workflow (agents
#   still running). If live work is found → WARN and defer (do NOT restart);
#   otherwise → pass silently (exit 0) so the caller may proceed.
#
# سبب الوجود / Context:
#   حادثة 2026-06-27 (wf_ef5ba242): workflow خلفي أُطلق من جلسة Claude Code نجا
#   من restart السيرفر (treekill:false → الوكلاء orphans أكملوا العمل)، لكن
#   منطق الـ drain (countActiveSessionsByProvider في server/index.js) يَعدّ
#   جلسات المزوّدات بالذاكرة فقط ولا يرى الـ workflows، فخرجت الأم فوراً
#   وأصدرت الجلسة الجديدة إشعار "stopped" مبكّراً (انفصام رؤية، لا فقدان عمل).
#   الجذر في طبقة Claude Code SDK؛ هذه البوّابة تصحيح في طبقة نسّاج: لا تُطلق
#   restart ما دام هناك workflow حيّ على القرص لا تراه ذاكرة السيرفر.
#
# ⚠️ قراءة فقط افتراضياً: لا تقتل، لا تعيد تشغيل، لا تعدّل أي إعداد، لا تمسّ
#    journal. الوضع الافتراضي إنذاري بحت — لا ينفّذ restart إطلاقاً. لتنفيذ
#    restart فعلي بعد اجتياز البوّابة استعمل --exec (يتطلّب --force إن وُجد
#    عملٌ حيّ). آمن للتكرار.
#    READ-ONLY by default: never kills/edits. --exec opts into running the
#    restart only AFTER the gate passes; --force overrides a live finding.
#    تنبيه: pm2 restart يحجبه حارس عميل Claude Code؛ ضمن العميل سيفشل --exec
#    عند أمر pm2 — وهذا متوقَّع، عندها نفّذ السطر المطبوع يدوياً في طرفية المالك.
#
# الاستخدام / Usage:
#   bash scripts/safe-restart.sh                 # فحص فقط (إنذاري). exit 0=آمن،
#                                                #   3=عمل حيّ، 2=خطأ قراءة.
#   bash scripts/safe-restart.sh --json          # نفس الفحص، خرج JSON.
#   bash scripts/safe-restart.sh --exec          # افحص ثم نفّذ restart إن آمِن؛
#                                                #   إن وُجد عمل حيّ: امتنع (exit 3).
#   bash scripts/safe-restart.sh --force --exec  # تجاوز واعٍ: نفّذ restart حتى
#                                                #   لو وُجد عمل حيّ (يُسجَّل تحذير).
#   bash scripts/safe-restart.sh --set K=V --exec# حَقن env مُصرَّح به (allowlist)
#                                                #   ضيّق: يُضيف K=V فقط إلى العملية
#                                                #   الحيّة عبر بيئة معاد تركيبها
#                                                #   (env -i) + --update-env، مع عزل
#                                                #   الشيل الحالي وصون المفاتيح
#                                                #   الحسّاسة (تحقّق قبل/بعد). --set
#                                                #   قابل للتكرار. بلا --set: لا حَقن
#                                                #   والسلوك مطابق تماماً للسابق.
#                                                #   مثال B-117 (تفعيل تشخيص SDK):
#                                                #   --set DEBUG_CLAUDE_AGENT_SDK=1 --exec
#
# متغيّرات البيئة / Env vars:
#   PROC_NAME        اسم عملية PM2                 (افتراضي: nassaj-dev)
#   ECOSYSTEM        مسار ملف ecosystem العقدة (ecosystem.<node>.config.cjs) —
#                    يُستعمل فقط في رسائل الاسترداد المطبوعة (host-side)، لا في
#                    مسار restart الآمن. لا افتراض runnable: القيمة الافتراضية
#                    placeholder صريح (ecosystem.<node>.config.cjs) يجب أن يستبدله
#                    المالك باسم ملف عقدته الفعلي؛ مرّره صراحةً لرسالة دقيقة.
#   WF_BASE          جذر جلسات المشروع (transcripts)
#                    (افتراضي: المسار المحلول لـ
#                     ~/nassaj-core/projects/-home-nassaj-Project-nassaj-dev)
#   FRESH_WINDOW_S   نافذة الحداثة (ثوانٍ) على agent-*.jsonl لاعتبار workflow
#                    حيّاً فعلاً (افتراضي: 180). لماذا: عدّ started>result وحده
#                    يُنتج false-positive من وكيل مات دون إصدار "result" (يبقى
#                    "حيّاً" للأبد). نشترط أيضاً أن يكون أحد ملفات agent-*.jsonl
#                    قد كُتب خلال هذه النافذة → نشاطٌ فعليّ لا شبح.
#
# رمز الخروج / Exit code:
#   0 = آمن (لا workflow حيّ) — وإن طُلب --exec فالـ restart نجح/طُلب.
#   3 = عمل حيّ موجود → أُجّل (أو، مع --force --exec، نُفّذ رغمه ثم 0).
#   2 = خطأ قراءة/إعداد (مثلاً WF_BASE غير موجود، أو --set غير صالح/مفتاح حسّاس).
#   4 = العملية غير مُسجَّلة في PM2 (B-110) → لا restart بالاسم؛ ابدأ من ecosystem.
#   5 = فشل حَقن --set: تعذّر restart أثناء الحَقن، أو انجراف مفتاح حسّاس بعد
#       التنفيذ، أو لم يُطبَّق مفتاح --set (fail-closed — B-117).
# ============================================================================
set -euo pipefail

# ── إعداد المسارات ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

PROC_NAME="${PROC_NAME:-nassaj-dev}"
# ECOSYSTEM: ملف ecosystem الخاص بالعقدة. لا يوجد `ecosystem.config.cjs` متعقَّب
# قابل للتشغيل بعد B-115 (المتعقَّب صار `ecosystem.config.example.cjs` = قالب مرجعي
# لا يُشغَّل؛ وأي `ecosystem.config.cjs`/`ecosystem.*.config.cjs` محلي = مُتجاهَل في
# Git ويولّده bootstrap-node.sh لكل عقدة). لذا الافتراضي هنا **placeholder غير
# قابل للتشغيل** يُذكِّر المالك باستبداله باسم ملف عقدته الفعلي (مثل
# ecosystem.nassaj.config.cjs). يُستعمل في رسائل الاسترداد المطبوعة فقط، لا في
# مسار restart الآمن (الذي يستهدف $PROC_NAME). مرّر ECOSYSTEM=... لرسالة دقيقة.
ECOSYSTEM="${ECOSYSTEM:-$REPO_DIR/ecosystem.<node>.config.cjs}"
FRESH_WINDOW_S="${FRESH_WINDOW_S:-180}"

# جذر الـ workflows: نحلّ الـ symlink لأن المسار الفعلي عبر readlink هو
# ~/nassaj-core/projects/... (راجع reference_nassaj_core_symlink في memory).
DEFAULT_WF_BASE="/home/nassaj/nassaj-core/projects/-home-nassaj-Project-nassaj-dev"
WF_BASE="${WF_BASE:-$DEFAULT_WF_BASE}"
if [ -e "$WF_BASE" ]; then
  WF_BASE="$(readlink -f "$WF_BASE")"
fi

# ── تحليل الوسائط ───────────────────────────────────────────────────────────
DO_EXEC=0
FORCE=0
JSON=0
# SET_KEYS/SET_VALS: مصفوفتان متوازيتان تحملان أزواج --set KEY=VALUE المصرَّح بها
# صراحةً (allowlist ضيّق). فارغتان افتراضياً → لا حَقن env البتّة والسلوك مطابق
# تماماً للسابق. راجع كتلة «حَقن env المُصرَّح به» أدناه للأمان والتبرير (B-117).
SET_KEYS=()
SET_VALS=()

# قائمة المفاتيح الحسّاسة الممنوع أن يمسّها أي حَقن (تُرفض في --set صراحةً، وتُتحقَّق
# قبل/بعد التنفيذ أنها لم تنجرف). هذه هي بالضبط مفاتيح انجرافي B-95/B-110:
#   PORT (تصادم منفذ) / JWT_SECRET (طرد الجلسات، B-70) / ALLOWED_ORIGINS (عطل CORS
#   500) / NODE_ENV (تقليم devDeps). لا يُحقَن أيٌّ منها من هنا أبداً.
SENSITIVE_KEYS=(PORT JWT_SECRET ALLOWED_ORIGINS NODE_ENV)

# صحّة اسم متغيّر البيئة: يبدأ بحرف/شرطة سفلية ثم [A-Za-z0-9_].
_valid_env_name() { case "$1" in [A-Za-z_]*) [ -z "${1//[A-Za-z0-9_]/}" ] ;; *) return 1 ;; esac; }

# _is_sensitive KEY → 0 إن كان المفتاح ضمن SENSITIVE_KEYS.
_is_sensitive() {
  local k="$1" s
  for s in "${SENSITIVE_KEYS[@]}"; do [ "$k" = "$s" ] && return 0; done
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --exec)  DO_EXEC=1 ;;
    --force) FORCE=1 ;;
    --json)  JSON=1 ;;
    --set)
      # يتطلّب وسيطاً تالياً بصيغة KEY=VALUE.
      if [ "$#" -lt 2 ]; then
        echo "safe-restart: --set يتطلّب KEY=VALUE / --set requires KEY=VALUE" >&2
        exit 2
      fi
      shift
      _pair="$1"
      _k="${_pair%%=*}"
      _v="${_pair#*=}"
      if [ "$_pair" = "$_k" ] || [ -z "$_k" ]; then
        echo "safe-restart: --set يجب أن يكون KEY=VALUE / must be KEY=VALUE: $_pair" >&2
        exit 2
      fi
      if ! _valid_env_name "$_k"; then
        echo "safe-restart: اسم متغيّر غير صالح / invalid env name: $_k" >&2
        exit 2
      fi
      if _is_sensitive "$_k"; then
        echo "safe-restart: المفتاح $_k حسّاس ومحظور في --set (يُدار من ملف العقدة فقط) / sensitive key refused: $_k" >&2
        exit 2
      fi
      SET_KEYS+=("$_k")
      SET_VALS+=("$_v")
      ;;
    --set=*)
      # صيغة مدمجة --set=KEY=VALUE.
      _pair="${1#--set=}"
      _k="${_pair%%=*}"
      _v="${_pair#*=}"
      if [ "$_pair" = "$_k" ] || [ -z "$_k" ]; then
        echo "safe-restart: --set يجب أن يكون KEY=VALUE / must be KEY=VALUE: $_pair" >&2
        exit 2
      fi
      if ! _valid_env_name "$_k"; then
        echo "safe-restart: اسم متغيّر غير صالح / invalid env name: $_k" >&2
        exit 2
      fi
      if _is_sensitive "$_k"; then
        echo "safe-restart: المفتاح $_k حسّاس ومحظور في --set / sensitive key refused: $_k" >&2
        exit 2
      fi
      SET_KEYS+=("$_k")
      SET_VALS+=("$_v")
      ;;
    -h|--help)
      sed -n '2,76p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "safe-restart: وسيط غير معروف / unknown arg: $1" >&2
      exit 2 ;;
  esac
  shift
done

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
emit() { echo "$(ts) [$1] $2" >&2; }   # السجل إلى stderr كي يبقى stdout نظيفاً لـ --json

# ── فحص توفّر القراءة ───────────────────────────────────────────────────────
if [ ! -d "$WF_BASE" ]; then
  emit ERR "WF_BASE غير موجود / not found: $WF_BASE"
  [ "$JSON" -eq 1 ] && printf '{"ok":false,"error":"wf_base_missing","wfBase":%s}\n' "\"$WF_BASE\""
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  emit ERR "node غير متوفّر — مطلوب لتحليل JSONL / node required for JSONL parsing"
  exit 2
fi

# ── الكشف عن الـ workflows الحية (قراءة فقط، عبر Node) ───────────────────────
# المنطق لكل مجلد wf_*:
#   live = ( عدد "started" > عدد "result" في journal.jsonl )  AND
#          ( أحدث mtime لأي agent-*.jsonl ضمن FRESH_WINDOW_S الأخيرة )
# الشرطان معاً: started>result يلتقط عدم اكتمال، ونافذة الحداثة تستبعد الأشباح
# (وكيل مات دون "result"). نستخدم Node لتحليل JSON بأمان (لا grep هشّ، ولا jq).
SCAN_JSON="$(
  WF_BASE="$WF_BASE" FRESH_WINDOW_S="$FRESH_WINDOW_S" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const base = process.env.WF_BASE;
const freshMs = (parseInt(process.env.FRESH_WINDOW_S, 10) || 180) * 1000;
const now = Date.now();

// اجمع كل مجلدات wf_* تحت <session>/subagents/workflows/ عبر كل الجلسات.
const wfDirs = [];
let sessions = [];
try { sessions = fs.readdirSync(base, { withFileTypes: true }); } catch (_) {}
for (const s of sessions) {
  if (!s.isDirectory()) continue;
  const wfRoot = path.join(base, s.name, 'subagents', 'workflows');
  let entries;
  try { entries = fs.readdirSync(wfRoot, { withFileTypes: true }); } catch (_) { continue; }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('wf_')) {
      wfDirs.push({ session: s.name, wf: e.name, dir: path.join(wfRoot, e.name) });
    }
  }
}

const live = [];
for (const w of wfDirs) {
  const journalPath = path.join(w.dir, 'journal.jsonl');
  let started = 0, result = 0;
  let raw;
  try { raw = fs.readFileSync(journalPath, 'utf8'); } catch (_) { continue; }
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; } // سطر تالف يُتجاوز
    if (obj && obj.type === 'started') started++;
    else if (obj && obj.type === 'result') result++;
  }
  if (started <= result) continue; // كل ما بدأ أصدر نتيجة → غير حيّ

  // نافذة الحداثة: أحدث mtime لأي agent-*.jsonl (نستثني .meta.json).
  let newestMtime = 0;
  let files;
  try { files = fs.readdirSync(w.dir); } catch (_) { files = []; }
  for (const f of files) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue; // .meta.json مُستبعَد
    let st;
    try { st = fs.statSync(path.join(w.dir, f)); } catch (_) { continue; }
    if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
  }
  const ageS = newestMtime ? Math.round((now - newestMtime) / 1000) : null;
  const fresh = newestMtime > 0 && (now - newestMtime) <= freshMs;
  if (!fresh) continue; // started>result لكن لا نشاط حديث → شبح، لا نحجب عليه

  live.push({
    session: w.session,
    wf: w.wf,
    pending: started - result,
    newestAgentAgeS: ageS,
  });
}

process.stdout.write(JSON.stringify({
  ok: true,
  wfBase: base,
  freshWindowS: freshMs / 1000,
  scanned: wfDirs.length,
  liveCount: live.length,
  live,
}));
NODE
)"

# ── تفسير النتيجة ───────────────────────────────────────────────────────────
LIVE_COUNT="$(printf '%s' "$SCAN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).liveCount))}catch(_){process.stdout.write("ERR")}})')"

if [ "$LIVE_COUNT" = "ERR" ] || [ -z "$LIVE_COUNT" ]; then
  emit ERR "تعذّر تحليل نتيجة الفحص / scan parse failed"
  [ "$JSON" -eq 1 ] && printf '%s\n' "$SCAN_JSON"
  exit 2
fi

if [ "$JSON" -eq 1 ]; then
  printf '%s\n' "$SCAN_JSON"
fi

# السطر الجاهز للّصق.
# B-110/2 (حادثة الصفحة البيضاء): نستهدف العملية بالاسم ($PROC_NAME) لا ملف
# ecosystem، ونُسقط --update-env. السبب: تمرير الملف مع --exec يُعيد PM2 تطبيق
# كامل كتلة env (CORS/WEBAUTHN/JWT/...) من ملف قد يكون منجرفاً عن المضيف أو
# معطوباً، وقد يطرد الجلسات. الاستهداف بالاسم يُعيد تشغيل البرنامج فقط بـ pm2_env
# المحفوظة الحالية دون لمس البيئة.
#
# شرط السلامة (يدقّقه qa-critic/architect): kill_timeout=86400000 وtreekill:false
# (B-23/B-95) يجب أن تكونا أصلاً في pm2_env المحفوظة. هما كذلك ما دامت حالة PM2
# بُنيت مرّة من ecosystem سليم ثم pm2 save (دورة الإقلاع المعتادة). الاستهداف
# بالاسم لا يُسقطهما — يبقيهما كما هما؛ إنما لا «يُصلح» انجرافاً سابقاً في الحالة
# المحفوظة. إعادة بناء الحالة من ecosystem سليم (delete+start ثم save) إجراء
# منفصل، يُنفَّذ يدوياً عند الحاجة (راجع أوامر host-side في المخرَج)، لا من هنا.
#
# ── حارس precondition (B-110) ────────────────────────────────────────────────
# restart-بالاسم بلا معنى إن لم تكن العملية مُسجَّلة في PM2 أصلاً (لا توجد
# pm2_env محفوظة لإعادة استخدامها). نتحقّق قبل بناء/طباعة RESTART_CMD:
#   • العملية غير موجودة → ERROR + exit 4 (ابدأها من ملف عقدتها أولاً).
#   • موجودة لكن treekill≠false أو kill_timeout<24h في الحالة الحيّة → تحذير
#     (انجراف B-23/B-95): restart-بالاسم لن يُصلحه؛ أعد بناء الحالة من ملف العقدة.
# B-115: رسائل الاسترداد تشير إلى ملف العقدة ($ECOSYSTEM = ecosystem.<node>.config.cjs)
# لا إلى ecosystem.config.cjs (لم يعد متعقَّباً قابلاً للتشغيل). استبدل <node> باسم
# عقدتك (مثل ecosystem.nassaj.config.cjs) أو مرّر ECOSYSTEM=... للسكربت.
# pm2 describe/jlist قراءة فقط (لا يحجبها حارس عميل Claude، بخلاف pm2 restart).
if command -v pm2 >/dev/null 2>&1; then
  if ! pm2 describe "$PROC_NAME" --silent >/dev/null 2>&1; then
    emit ERROR "العملية $PROC_NAME غير موجودة في PM2 — لا restart بالاسم؛ ابدأها من ملف عقدتها أولاً."
    emit INFO  "ابدأ نظيفاً: cd $REPO_DIR && env -u PORT pm2 start $ECOSYSTEM && pm2 save"
    [ "$JSON" -eq 1 ] && printf '{"ok":false,"error":"proc_not_in_pm2","proc":%s}\n' "\"$PROC_NAME\""
    exit 4
  fi
  # فحص انجراف الحالة الحيّة (تحذيري فقط — لا يقطع). نقرأ pm2_env عبر jlist.
  DRIFT="$(
    PROC_NAME="$PROC_NAME" pm2 jlist 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const want=process.env.PROC_NAME;
        let arr;try{arr=JSON.parse(s)}catch(_){process.exit(0)}
        const p=(arr||[]).find(x=>x && x.name===want);
        if(!p){process.exit(0)}
        const e=p.pm2_env||{};
        // treekill الافتراضي في PM2 = true؛ نعتبره منجرفاً ما لم يكن false صراحةً.
        const tk=e.treekill;
        const kt=Number(e.kill_timeout);
        const probs=[];
        if(tk!==false) probs.push("treekill="+JSON.stringify(tk)+" (المطلوب false — B-23/ADR-021)");
        if(!(kt>=86400000)) probs.push("kill_timeout="+JSON.stringify(e.kill_timeout)+" (المطلوب ≥86400000 — B-95)");
        if(probs.length) process.stdout.write(probs.join(" | "));
      })' 2>/dev/null
  )"
  if [ -n "$DRIFT" ]; then
    emit WARN "انجراف في حالة PM2 المحفوظة للعملية $PROC_NAME: $DRIFT"
    emit WARN "restart-بالاسم لن يُصلح هذا الانجراف. أعد بناء الحالة من ملف عقدة سليم:"
    emit WARN "  cd $REPO_DIR && env -u PORT pm2 delete $PROC_NAME && env -u PORT pm2 start $ECOSYSTEM && pm2 save"
  fi
else
  emit INFO "pm2 غير متوفّر — تخطّي حارس precondition (تعذّر التحقّق من تسجيل العملية)."
fi

RESTART_CMD="cd $REPO_DIR && env -u PORT pm2 restart $PROC_NAME && pm2 save"

# ── حَقن env المُصرَّح به (allowlist) — B-117 ────────────────────────────────────
# لماذا يختلف هذا عن انجراف B-110 (الذي سبّب انقطاعي 502)؟
#
#   B-110 كان: `pm2 restart ecosystem.config.cjs --update-env` — يُعيد PM2 قراءة
#   كامل ملف ecosystem (قد يكون منجرفاً/معطوباً) ويطبّق كل كتلة env منه، أو
#   `--update-env` من شيلٍّ منجرف (cwd خاطئ، PORT مصدَّر، JWT_SECRET مفقود) فيلتقط
#   `Object.assign({}, process.env)` كل بيئة الشيل الملوّثة ويكتبها في العملية.
#
#   هنا: لا ملف ecosystem إطلاقاً، ولا بيئة الشيل الحالية. نبني بيئة **مُعاد
#   تركيبها من الصفر (`env -i`)** تحتوي حصراً: (1) قيم أساسية لا غنى عنها لـ PM2
#   (HOME/PATH/PM2_HOME من مصادر موثوقة)، و(2) المفاتيح المُصرَّح بها عبر --set فقط.
#   ثم `--update-env` (وهو تقنياً الوسيلة الوحيدة لأي حَقن على restart-بالاسم — راجع
#   pm2 API.js: `restart(name,{env})` يرفض inline env بلا ecosystem، و`_operate`
#   يطبّق env فقط حين updateEnv=true). دمج God جانبَ الخادم إضافيٌّ لا استبدالي
#   (Utility.extend في ActionMethods.js): المفاتيح غير المُمرَّرة **تبقى** من
#   pm2_env المحفوظة كما هي — لذا JWT_SECRET/ALLOWED_ORIGINS/PORT الحاليّة تُصان
#   تلقائياً ما دمنا لا نمرّرها (وهي محظورة في --set أصلاً).
#
#   حارس fail-closed: نلتقط قيم SENSITIVE_KEYS **قبل** التنفيذ من pm2 jlist، ننفّذ،
#   ثم نتحقّق **بعده** أنها لم تتغيّر (absent يبقى absent، وقيمة تبقى كما هي)
#   وأن مفاتيح --set صارت حاضرة بقيمها المطلوبة. أي انجراف في مفتاح حسّاس → خطأ صاخب
#   (exit 5) لا ثقة عمياء.

# السنتينل الدالّ على «المفتاح غير موجود» (نميّزه عن السلسلة الفارغة). لا نستعمل
# بايت null لأن bash يسقطه في $(...) (يحوّل \x00ABSENT\x00 إلى ABSENT فيكسر المقارنة
# ويلوّث stderr بتحذيرات) — نعتمد سلسلة خالية من null غير قابلة للتصادم مع قيمة env
# صالحة (تحوي مسافة، وقيم env تُمرَّر ككلمة واحدة عبر --set فلا تحوي مسافات هكذا).
_ABSENT_SENTINEL='<<safe-restart:ABSENT>>'

# يقرأ قيمة env محفوظة لمفتاح من عملية PM2 عبر jlist. يطبع القيمة، أو $_ABSENT_SENTINEL
# إن كان المفتاح غير موجود.
# ملاحظة حاسمة: في خط الأنابيب `A=v cmd | node`، إسنادات البيئة تخصّ cmd (pm2) لا
# node — لذا نضع PROC_NAME/KEY/ABSENT على جانب node مباشرةً (وإلا رآها node undefined
# فطابق x.name===undefined → لا عملية → ABSENT دائماً حتى للمفاتيح الموجودة).
_pm2_saved_env() {
  local key="$1"
  pm2 jlist 2>/dev/null | PROC_NAME="$PROC_NAME" KEY="$key" ABSENT="$_ABSENT_SENTINEL" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const ABSENT=process.env.ABSENT;
      let arr;try{arr=JSON.parse(s)}catch(_){process.stdout.write(ABSENT);return}
      const p=(arr||[]).find(x=>x&&x.name===process.env.PROC_NAME);
      const e=(p&&p.pm2_env&&p.pm2_env.env)||{};
      const k=process.env.KEY;
      if(!Object.prototype.hasOwnProperty.call(e,k)) process.stdout.write(ABSENT);
      else process.stdout.write(String(e[k]));
    })'
}

# يبني وينفّذ restart مع حَقن env المُصرَّح به (يُستدعى فقط حين ${#SET_KEYS[@]}>0).
# fail-closed: يُرجِع رمز خروج غير صفري إن انجرف مفتاح حسّاس أو لم يُطبَّق --set.
_exec_restart_with_injection() {
  # 1) لقطة ما-قبل للمفاتيح الحسّاسة (المرجع لكشف الانجراف).
  local -a _pre_sens=()
  local k
  for k in "${SENSITIVE_KEYS[@]}"; do
    _pre_sens+=("$(_pm2_saved_env "$k")")
  done

  # 2) ابنِ وسائط env -i: أساسيات PM2 + مفاتيح --set حصراً. لا شيء من الشيل الحالي.
  #    HOME/PATH/PM2_HOME من مصادر موثوقة (المستخدم الحالي)، لا من قيم منجرفة.
  local -a _env_args=(
    "HOME=${HOME}"
    "PATH=${PATH}"
    "PM2_HOME=${PM2_HOME:-$HOME/.pm2}"
  )
  local i
  for i in "${!SET_KEYS[@]}"; do
    _env_args+=("${SET_KEYS[$i]}=${SET_VALS[$i]}")
  done

  emit INFO "حَقن env مُصرَّح به: ${SET_KEYS[*]} (عبر env -i + --update-env، الشيل الحالي معزول)."

  # 3) نفّذ: cwd = REPO_DIR، بيئة معاد تركيبها، restart بالاسم + --update-env، ثم save.
  #    نبقي env -u PORT حارساً إضافياً ضد أي PORT متسرّب (رغم أن env -i يُسقطه أصلاً).
  if ! ( cd "$REPO_DIR" && env -i "${_env_args[@]}" env -u PORT pm2 restart "$PROC_NAME" --update-env ); then
    emit ERROR "فشل pm2 restart أثناء الحَقن. لم يُحفَظ. تحقّق يدوياً من حالة $PROC_NAME."
    return 5
  fi
  # save في بيئة نظيفة أيضاً (لا يكتب env، لكن نُبقي الاتساق).
  ( env -u PORT pm2 save >/dev/null 2>&1 ) || emit WARN "pm2 save فشل (غير قاطع) — الحالة الحيّة مطبَّقة لكن قد لا تُستعاد بعد reboot."

  # امهل العملية لتُعاد كتابة env المحفوظة قبل التحقّق.
  local _waited=0
  while [ "$_waited" -lt 5 ]; do
    sleep 1
    _waited=$((_waited+1))
    [ "$(_pm2_saved_env "${SET_KEYS[0]}")" = "${SET_VALS[0]}" ] && break
  done

  # 4) تحقّق ما-بعد (fail-closed):
  local _fail=0
  #   (أ) كل مفتاح حسّاس لم يتغيّر عن لقطته.
  for i in "${!SENSITIVE_KEYS[@]}"; do
    local _now; _now="$(_pm2_saved_env "${SENSITIVE_KEYS[$i]}")"
    if [ "$_now" != "${_pre_sens[$i]}" ]; then
      local _b="${_pre_sens[$i]}"; local _a="$_now"
      [ "$_b" = "$_ABSENT_SENTINEL" ] && _b="(absent)"
      [ "$_a" = "$_ABSENT_SENTINEL" ] && _a="(absent)"
      emit ERROR "انجراف مفتاح حسّاس ${SENSITIVE_KEYS[$i]}: قبل=$_b بعد=$_a — إجراء خطر! أعد بناء الحالة من ملف العقدة."
      _fail=1
    fi
  done
  #   (ب) كل مفتاح --set صار حاضراً بقيمته.
  for i in "${!SET_KEYS[@]}"; do
    local _got; _got="$(_pm2_saved_env "${SET_KEYS[$i]}")"
    if [ "$_got" != "${SET_VALS[$i]}" ]; then
      emit ERROR "لم يُطبَّق --set ${SET_KEYS[$i]}=${SET_VALS[$i]} (القيمة الآن: ${_got/"$_ABSENT_SENTINEL"/(absent)})."
      _fail=1
    else
      emit INFO "تحقّق: ${SET_KEYS[$i]}=${SET_VALS[$i]} مطبَّق في العملية الحيّة."
    fi
  done

  if [ "$_fail" -eq 1 ]; then
    emit ERROR "الحَقن اكتمل تقنياً لكن التحقّق فشل. راجع أعلاه فوراً."
    return 5
  fi
  emit INFO "الحَقن نجح والمفاتيح الحسّاسة صينت (لا انجراف)."
  return 0
}

# run_restart: نقطة تنفيذ موحّدة. بلا --set → السلوك الافتراضي (RESTART_CMD) حرفياً
# كما كان. مع --set → مسار الحَقن الآمن أعلاه. تُرجِع رمز خروج المسار المختار.
run_restart() {
  if [ "${#SET_KEYS[@]}" -gt 0 ]; then
    _exec_restart_with_injection
    return $?
  fi
  bash -c "$RESTART_CMD"
  return $?
}

if [ "$LIVE_COUNT" -gt 0 ]; then
  emit WARN "عُثر على $LIVE_COUNT workflow حيّ (started>result + نشاط خلال ${FRESH_WINDOW_S}s)."
  if [ "$JSON" -eq 0 ]; then
    printf '%s\n' "$SCAN_JSON" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const o=JSON.parse(s);
          for(const w of o.live){
            process.stderr.write(`  • ${w.wf} (session ${w.session.slice(0,8)}…) — pending=${w.pending}, آخر نشاط قبل ${w.newestAgentAgeS}s\n`);
          }
        }catch(_){}
      })'
  fi
  if [ "$DO_EXEC" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
    emit WARN "تجاوز واعٍ (--force): تنفيذ restart رغم وجود عمل حيّ. orphans ستُكمل (treekill:false) لكن انفصام الرؤية قد يتكرّر."
    if [ "${#SET_KEYS[@]}" -gt 0 ]; then
      emit INFO "تنفيذ مع حَقن env مُصرَّح به (${SET_KEYS[*]})."
    else
      emit INFO "تنفيذ / running: $RESTART_CMD"
    fi
    run_restart
    exit $?
  fi
  emit WARN "أُجّل restart. للتجاوز الواعي: --force --exec. أو نفّذ يدوياً بعد انتهاء العمل:"
  emit INFO "$RESTART_CMD"
  exit 3
fi

# لا عمل حيّ → آمن.
emit INFO "آمن: لا workflow حيّ (فُحص ${SCAN_JSON:+$(printf '%s' "$SCAN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).scanned))}catch(_){process.stdout.write("?")}})')} workflow)."
if [ "$DO_EXEC" -eq 1 ]; then
  if [ "${#SET_KEYS[@]}" -gt 0 ]; then
    emit INFO "تنفيذ مع حَقن env مُصرَّح به (${SET_KEYS[*]})."
  else
    emit INFO "تنفيذ / running: $RESTART_CMD"
  fi
  run_restart
  exit $?
else
  if [ "${#SET_KEYS[@]}" -gt 0 ]; then
    emit INFO "وضع الفحص فقط. مع --exec سيُحقَن (عبر env -i + --update-env، الشيل معزول): ${SET_KEYS[*]}"
    emit INFO "المفاتيح الحسّاسة المصانة (لا تُمسّ): ${SENSITIVE_KEYS[*]}"
  else
    emit INFO "وضع الفحص فقط. للتنفيذ: --exec. السطر الجاهز:"
    emit INFO "$RESTART_CMD"
  fi
fi
exit 0
