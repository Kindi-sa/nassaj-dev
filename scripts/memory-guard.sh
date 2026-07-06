#!/usr/bin/env bash
# ============================================================================
# memory-guard.sh  (B-130)
# ----------------------------------------------------------------------------
# حارس ذاكرة يحترم الجلسات لعملية PM2 `nassaj-dev` — بديلٌ آمن عن آلية PM2
# الداخلية `max_memory_restart` (التي تُطلق restart أعمى بلا معرفة بالجلسات).
#
# A session-aware RSS guard for the `nassaj-dev` PM2 process. Safe replacement
# for PM2's built-in `max_memory_restart` (which fires a blind restart with no
# knowledge of live sessions).
#
# ── لماذا وُجد / Why (B-129 / B-130) ─────────────────────────────────────────
#   آلية PM2 (lib/Worker.js): كل دورة worker إن كان RSS > max_memory_restart
#   تُطلق reloadProcessId (= SIGINT في fork-mode) بلا أي فحص للجلسات. ذلك يدخل
#   العملية في drain (shutdown-drain.service.ts): server.close() يحرّر المقبس
#   فوراً، لكن PM2 fork-mode **لا يشغّل البديلة حتى تخرج العملية القديمة**،
#   والخروج ينتظر countActiveSessionsByProvider()==0 (drain بلا سقف،
#   DRAIN_TIMEOUT_MS=0). فما دامت جلسة claude ابنة حيّة (مثلاً --resume) لا مستمع
#   على المنفذ 3004 طوال الـdrain → انقطاع 502 ممتد (B-129: 916MB عند 06:57:47
#   UTC → احتجاز ~18 دقيقة). هذا المسار الآلي يتجاوز بوّابة safe-restart.sh كلياً.
#
#   الحلّ (B-130): يُحيَّد max_memory_restart من PM2 (يصير undefined فتُعطَّل آلية
#   Worker تماماً — انظر أدناه)، ويحلّ محلّه هذا الحارس الدوري (cron) الذي:
#     1) يقيس RSS من `pm2 jlist` (قراءة فقط).
#     2) دون العتبة → لا شيء (يحدّث ملف حالة خفيف فقط).
#     3) عند/فوق العتبة → يعيد التشغيل **فقط إن كان آمناً**: لا عمليات مزوّد
#        ابنة حيّة (= لا جلسات حيّة) **و** لا workflow حيّ. التنفيذ يُفوَّض دائماً
#        إلى بوّابة scripts/safe-restart.sh --exec المُصلّبة (تفحص الـworkflows
#        وتنفّذ restart آمناً)؛ إن وُجد عملٌ حيّ → تأجيل (لا قطع)، يُعاد المحاولة
#        في الدورة التالية.
#
#   لماذا فحص العمليات الأبناء هنا (لا فحص workflow في safe-restart وحده)؟
#   لأن الـdrain يُبقي العملية القديمة حيّة حتى countActiveSessions==0، وهذا
#   يقابل عمليات المزوّد الابنة (claude/agy/codex/gemini/cursor/hermes/opencode)
#   تحت PID العملية. safe-restart يفحص journals الـworkflows فقط، فأضفنا هنا
#   بوّابة العمليات الأبناء كي لا نُطلق restart أثناء جلسة تفاعلية حيّة (وهو ما
#   يعيد إنتاج عطل 502 بالضبط).
#
# ⚠️ قراءة فقط ما لم يقرّر restart، وحتى حينها **فقط عبر safe-restart.sh**. لا
#    pm2 restart/stop/reload خام إطلاقاً. Idempotent، محميّ بـflock ضد التداخل.
#
# ── التشغيل / Run ────────────────────────────────────────────────────────────
#   يُشغَّل من cron كل بضع دقائق. مثال (كل 3 دقائق):
#     */3 * * * * /usr/bin/env bash /home/nassaj/Project/nassaj-dev/scripts/memory-guard.sh >/dev/null 2>&1
#   ملاحظة: cron يعمل خارج عميل Claude Code، فحارس الأوامر لا يعترض pm2 هناك —
#   لذا safe-restart.sh --exec ينفّذ pm2 restart فعلياً عند نافذة آمنة.
#
# ── متغيّرات البيئة / Env vars ────────────────────────────────────────────────
#   PROC_NAME               اسم عملية PM2                (افتراضي: nassaj-dev)
#   MEM_GUARD_THRESHOLD_MB  عتبة RSS بالميغابايت لبدء محاولة إعادة تشغيل آمنة
#                           (افتراضي: 850؛ الحدّ القديم كان 768MiB وأطلق فعلياً
#                           عند 916MB. النظام يملك ~10GB فالتأجيل حتى الخمول آمن
#                           من OOM بهامش واسع).
#   MEM_GUARD_FORCE_MB      سقف حرج اختياري (غير مضبوط افتراضياً = معطَّل). فوقه
#                           يُسجَّل سطر CRITICAL للتنبيه. لا restart قسري إلا إذا
#                           ضُبط أيضاً MEM_GUARD_FORCE_RESTART=1 (يقبل المالك حينها
#                           drain قصيراً محتمَلاً بدل نموّ لا محدود نحو OOM). القرار
#                           السياسي (تنبيه فقط أم قطع قسري) متروك للمالك — انظر
#                           triage B-130 (فصل خدمة الجلسات ADR-021 هو الحلّ الجذري).
#   MEM_GUARD_PROVIDERS_RE  regex لأسماء/وسائط عمليات المزوّد الابنة
#                           (افتراضي أدناه).
#   MEM_GUARD_LOG           ملف السجل (افتراضي: $HOME/.pm2/logs/nassaj-memory-guard.log)
#   MEM_GUARD_STATE         ملف الحالة الخفيف (افتراضي: نفس المجلد/.state)
#
# ── رمز الخروج / Exit ─────────────────────────────────────────────────────────
#   دائماً 0 (حارس cron لا يجب أن يُصدر ضجيجاً في mail cron). القرارات في السجل.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

PROC_NAME="${PROC_NAME:-nassaj-dev}"
THRESHOLD_MB="${MEM_GUARD_THRESHOLD_MB:-850}"
FORCE_MB="${MEM_GUARD_FORCE_MB:-}"
FORCE_RESTART="${MEM_GUARD_FORCE_RESTART:-0}"
PROVIDERS_RE="${MEM_GUARD_PROVIDERS_RE:-claude|agy|codex|gemini|cursor|hermes|opencode}"
LOG_FILE="${MEM_GUARD_LOG:-$HOME/.pm2/logs/nassaj-memory-guard.log}"
STATE_FILE="${MEM_GUARD_STATE:-$HOME/.pm2/logs/nassaj-memory-guard.state}"
LOCK_FILE="${MEM_GUARD_LOCK:-/tmp/nassaj-memory-guard.lock}"

mkdir -p "$(dirname -- "$LOG_FILE")" 2>/dev/null || true

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '%s [%s] %s\n' "$(ts)" "$1" "$2" >>"$LOG_FILE" 2>/dev/null; }
state() { printf '%s rss=%sMB threshold=%sMB %s\n' "$(ts)" "$1" "$THRESHOLD_MB" "$2" >"$STATE_FILE" 2>/dev/null; }

# ── قفل ضد التداخل (best-effort) ─────────────────────────────────────────────
# لو دورة سابقة ما زالت تعمل (مثلاً safe-restart ينتظر)، نتخطّى هذه الدورة.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE" 2>/dev/null || true
  if ! flock -n 9; then
    state "?" "skip:locked"
    exit 0
  fi
fi

# ── قراءة RSS وPID من pm2 jlist (قراءة فقط) ─────────────────────────────────
# ملاحظة حاسمة: في `A=v cmd | node` يخصّ الإسناد cmd لا node — لذا PROC_NAME على
# جانب node مباشرةً (وإلا رآه node undefined فطابق x.name===undefined → MISSING).
READ="$(
  pm2 jlist 2>/dev/null | PROC_NAME="$PROC_NAME" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let a;try{a=JSON.parse(s)}catch(_){process.stdout.write("ERR");return}
      const p=(a||[]).find(x=>x&&x.name===process.env.PROC_NAME);
      if(!p){process.stdout.write("MISSING");return}
      const rss=(p.monit&&p.monit.memory)||0;
      const status=(p.pm2_env&&p.pm2_env.status)||"?";
      process.stdout.write(String(p.pid||0)+" "+String(rss)+" "+status);
    })' 2>/dev/null
)"

if [ "$READ" = "ERR" ] || [ -z "$READ" ]; then
  log ERR "تعذّر قراءة pm2 jlist / cannot read pm2 jlist"
  state "?" "error:jlist"
  exit 0
fi
if [ "$READ" = "MISSING" ]; then
  log WARN "العملية $PROC_NAME غير موجودة في PM2 — لا شيء لحراسته."
  state "?" "missing"
  exit 0
fi

PID="${READ%% *}"
_rest="${READ#* }"
RSS_BYTES="${_rest%% *}"
STATUS="${_rest##* }"
RSS_MB=$(( RSS_BYTES / 1048576 ))

# العملية ليست online (قد تكون stopping/errored) → لا نتدخّل، نسجّل فقط.
if [ "$STATUS" != "online" ]; then
  log WARN "الحالة=$STATUS (rss=${RSS_MB}MB) — لا إجراء (العملية ليست online)."
  state "$RSS_MB" "noop:status=$STATUS"
  exit 0
fi

# ── دون العتبة → لا إجراء ─────────────────────────────────────────────────────
if [ "$RSS_MB" -lt "$THRESHOLD_MB" ]; then
  state "$RSS_MB" "ok"
  exit 0
fi

# ── فوق العتبة: عُدّ عمليات المزوّد الابنة (= جلسات حيّة) ────────────────────────
# نمشي شجرة الأحفاد من PID العملية ونعدّ ما يطابق اسمه/وسائطه regex المزوّدين.
# اللقطة من ps -eo واحدة (تجنّب السباق) ونحلّها في node.
# نطابق basename لأول رمزين فقط (argv0 + argv1) لا كامل الargs — كي لا نطابق
# مسارات عابرة تحوي اسم مزوّد (مثل .../.claude/...) في أغلفة bash. هذا يلتقط
# `claude ...` (argv0) و`node /path/agy.js ...` (argv1) ويتجاهل `/bin/bash -c ...`.
LIVE_SESSIONS="$(
  ps -eo pid=,ppid=,args= 2>/dev/null | \
  ROOT="$PID" RE="$PROVIDERS_RE" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const root=parseInt(process.env.ROOT,10);
      // مثبَّت عند بداية الـbasename، يسمح بلاحقة (agy.js) لكن يمنع تطابق منتصف كلمة.
      const re=new RegExp("^("+process.env.RE+")([^A-Za-z0-9]|$)","i");
      const base=(t)=>{ if(!t) return ""; t=t.split("/").pop(); return t; };
      const rows=[];
      for(const line of s.split("\n")){
        const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if(m) rows.push({pid:+m[1],ppid:+m[2],args:m[3]});
      }
      const childrenOf={};
      for(const r of rows){(childrenOf[r.ppid]=childrenOf[r.ppid]||[]).push(r);}
      // BFS للأحفاد
      const desc=[]; const q=[root]; const seen=new Set([root]);
      while(q.length){const cur=q.shift();for(const c of (childrenOf[cur]||[])){if(!seen.has(c.pid)){seen.add(c.pid);desc.push(c);q.push(c.pid);}}}
      let n=0;
      for(const d of desc){
        const toks=d.args.split(/\s+/);
        const t0=base(toks[0]), t1=base(toks[1]);
        if(re.test(t0) || re.test(t1)) n++;
      }
      process.stdout.write(String(n));
    })' 2>/dev/null
)"
[ -z "$LIVE_SESSIONS" ] && LIVE_SESSIONS="?"

# ── سقف حرج اختياري (opt-in) ─────────────────────────────────────────────────
if [ -n "$FORCE_MB" ] && [ "$RSS_MB" -ge "$FORCE_MB" ]; then
  log CRITICAL "RSS=${RSS_MB}MB بلغ السقف الحرج ${FORCE_MB}MB (جلسات حيّة=$LIVE_SESSIONS). خطر نموّ نحو OOM."
  if [ "$FORCE_RESTART" = "1" ]; then
    log CRITICAL "MEM_GUARD_FORCE_RESTART=1 → restart قسري عبر safe-restart --force --exec (قد يسبّب drain قصيراً)."
    ( cd "$REPO_DIR" && bash scripts/safe-restart.sh --force --exec ) >>"$LOG_FILE" 2>&1
    rc=$?
    log CRITICAL "safe-restart --force --exec انتهى برمز=$rc"
    state "$RSS_MB" "force-restart:rc=$rc"
    exit 0
  fi
  # بلا FORCE_RESTART: تنبيه فقط، لا قطع — نكمل لمنطق التأجيل العادي أدناه.
fi

# ── جلسات حيّة → تأجيل (لا قطع) ────────────────────────────────────────────────
if [ "$LIVE_SESSIONS" != "0" ]; then
  log INFO "RSS=${RSS_MB}MB ≥ ${THRESHOLD_MB}MB لكن $LIVE_SESSIONS جلسة مزوّد حيّة → تأجيل (سيُعاد الفحص لاحقاً)."
  state "$RSS_MB" "defer:sessions=$LIVE_SESSIONS"
  exit 0
fi

# ── لا جلسات حيّة → نافذة آمنة: فوّض التنفيذ إلى safe-restart المُصلّبة ──────────
# safe-restart يفحص الـworkflows بنفسه ويؤجّل (exit 3) إن وُجد عملٌ حيّ، وينفّذ
# restart آمناً وإلا. لا نمرّر --force: نحترم أي workflow حيّ يكشفه.
log INFO "RSS=${RSS_MB}MB ≥ ${THRESHOLD_MB}MB ولا جلسات حيّة → نافذة آمنة: تفويض safe-restart.sh --exec"
( cd "$REPO_DIR" && bash scripts/safe-restart.sh --exec ) >>"$LOG_FILE" 2>&1
rc=$?
case "$rc" in
  0) log INFO  "safe-restart: أُعيد التشغيل بنجاح (rc=0)." ; state "$RSS_MB" "restarted" ;;
  3) log INFO  "safe-restart: أُجّل (workflow حيّ اكتشفه، rc=3)." ; state "$RSS_MB" "defer:workflow" ;;
  4) log WARN  "safe-restart: العملية غير مسجّلة في PM2 (rc=4)." ; state "$RSS_MB" "error:not-in-pm2" ;;
  *) log WARN  "safe-restart: رمز خروج غير متوقّع rc=$rc." ; state "$RSS_MB" "error:rc=$rc" ;;
esac
exit 0
