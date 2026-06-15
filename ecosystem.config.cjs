// PM2 ecosystem config for nassaj-dev (development sibling of nassaj/claudecodeui).
//
// لماذا هذا الملف:
// - يَضمن عَزل nassaj-dev تَماماً عن الإنتاج: منفذ مستقل (3004) و DB مستقل.
// - يَحفظ الإعداد في الـ repo كي يَنجو من pm2 save/resurrect/reboot.
// - يَتطابق مع نَمط /home/nassaj/Project/claudecodeui-official/ecosystem.config.cjs
//   لتسهيل العمليات وتَوحيد سياسة الـ logs.
//
// ملاحظات تَصميم حَرِجة (لا تَحذف):
// 1) الامتداد .cjs مَقصود: package.json يَحوي "type": "module"، لذا ملف بِامتداد .js
//    سَيُفسَّر كـ ESM ويَفشل PM2 في تَحميل module.exports.
// 2) المتَغيِّر الذي يَقرأه التَطبيق فعلاً هو DATABASE_PATH (راجع
//    server/load-env.js و server/modules/database/connection.ts). نَمرر
//    NASSAJ_DB_PATH أيضاً لِتَوافُق وَثيقة B-04 لكنه غير مُستهلَك من الكود؛
//    DATABASE_PATH هو الفاعل الذي يَمنع الكِتابة على ~/.cloudcli/auth.db
//    الخاص بالإنتاج.
// 3) المتَغيِّر الفعلي للمنفذ هو SERVER_PORT (راجع .env.example). نَمرر PORT
//    أيضاً تَحوُّطاً، والوسيط --port 3004 هو المسار الموثَّق في الإنتاج.
// 4) script يَفترض وجود dist-server/ — يَجب تَنفيذ `npm run build` مَرّة واحدة
//    قبل أوّل `pm2 start ecosystem.config.cjs` (مَهمَّة منفصلة عن B-04).

module.exports = {
  apps: [
    {
      name: 'nassaj-dev',
      cwd: '/home/nassaj/Project/nassaj-dev',
      script: 'dist-server/server/index.js',
      args: '--port 3004',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // باعد بين محاولات إعادة التشغيل (B-23): بدون backoff كانت 10 محاولات
      // EADDRINUSE تُحرق max_restarts في ~5 ثوانٍ وتترك العملية errored.
      exp_backoff_restart_delay: 1000,
      // حدّ ذاكرة وقائي ضد OOM (نوبة 2026-06-06). رُفع 512M → 768M بعد B-23:
      // العملية تجاوزت 512M فعلياً (586MB في 2026-06-11 01:34) فأطلقت
      // restarts تلقائية وقعت في فخ drain/EADDRINUSE.
      max_memory_restart: '768M',
      // treekill:false إلزامي (ADR-021/ADR-022): إشارات PM2 — بما فيها SIGKILL
      // بعد kill_timeout — تصيب العملية الأم فقط، فلا تُقتل عمليات claude الأبناء.
      treekill: false,
      // B-23: كان 24h (86400000) لحماية الـ drain، لكن الخادم صار يحرّر المنفذ
      // فوراً عند إشارة الإيقاف (shutdown-drain.service.ts) فلم يعد التراخي
      // الطويل ضرورياً لتشغيل النسخة البديلة. 5 دقائق حدّ أمان: لو تتبّع PM2
      // العملية القديمة بدقة فأقصى انتظار قبل SIGKILL للأم 5 دقائق بدل 24h.
      kill_timeout: 300000,
      watch: false,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      out_file: '/home/nassaj/.pm2/logs/nassaj-dev-out.log',
      error_file: '/home/nassaj/.pm2/logs/nassaj-dev-error.log',
      env: {
        NODE_ENV: 'production',
        SERVER_PORT: '3004',
        PORT: '3004',
        HOST: '0.0.0.0',
        DATABASE_PATH: '/home/nassaj/.local/share/nassaj-dev/db.sqlite',
        NASSAJ_DB_PATH: '/home/nassaj/.local/share/nassaj-dev/db.sqlite',

        // ── B-41 (self-hosting trap) — single-listener bind guard ────────────
        // T-95 (2026-06-13) diagnosed a 7.5h EADDRINUSE crash-loop (2026-06-12
        // 17:14 → 2026-06-13 03:13). The running build ALREADY had B-23 (port
        // released on stop via server.close()), proven by the
        //   "[DRAIN] SIGTERM: listener closed — port released"
        // line that ended the loop at 03:13:39. So the predecessor was holding
        // the port simply because it had never been signaled to stop — PM2
        // fork-mode lost its pid under treekill:false (ADR-028/B-24) and spawned
        // a replacement beside the still-live original. The loop is broken by
        // the bind guard below, NOT by capping the drain. The owner-mandated
        // unbounded drain (B-N-DRAIN, 2026-06-09: roles may run for hours) is
        // therefore preserved.
        //
        // DRAIN_TIMEOUT_MS=0: drain with NO deadline (owner decision). A wedged
        //   drain still has two escape hatches: a second stop signal and PM2's
        //   kill_timeout. A positive value would opt a single run into a cap.
        DRAIN_TIMEOUT_MS: '0',
        // LISTEN_BIND_WINDOW_MS: how long a STARTING instance tolerates
        //   EADDRINUSE (a draining/ghost predecessor still on the socket) before
        //   exiting cleanly (0) instead of crash-looping. A healthy handoff
        //   binds in <1s; 10s absorbs slow ones. THIS is what breaks the loop.
        LISTEN_BIND_WINDOW_MS: '10000',

        // ── Phase-MU multi-user auth (B-AUTH) ──────────────────────────────
        // قيم placeholder. هذه الأسماء هي التي يقرأها الكود فعلاً (راجع
        // server/middleware/auth.js و server/services/bootstrap-owner.service.js).
        // لا تُعِد تسميتها. عند التشغيل عبر pm2 ecosystem، قيم env هنا تطغى على .env.
        //
        // JWT_SECRET: سرّ توقيع JWT (>= 32 محرفاً). إن تُرك فارغاً يُولَّد سرّ
        //   per-install ويُحفظ في app_config (يعمل لكن env مُفضَّل للإنتاج).
        //   توليد: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
        // JWT_SECRET: 'CHANGE_ME_min_32_chars_random_hex',
        //
        // bootstrap owner — يُنشأ تلقائياً عند أول تشغيل على DB بلا owner؛
        // لا يُكرَّر لاحقاً. إن تُرك BOOTSTRAP_OWNER_PASSWORD فارغاً تُولَّد كلمة
        // مرور قوية وتُطبع مرة واحدة في سجل الخادم.
        // BOOTSTRAP_OWNER_USERNAME: 'owner',
        // BOOTSTRAP_OWNER_PASSWORD: 'CHANGE_ME_min_12_chars',

        // ── Passkeys / WebAuthn (B-PK) ──────────────────────────────────────
        // هوية الـ relying party لمفاتيح المرور. RP_ID نطاق فقط بلا scheme؛
        // ORIGIN أصل كامل (يدعم قائمة بفواصل). بدونها يسقط الخادم إلى إعداد
        // localhost التطويري ولن تعمل passkeys على النطاق المنشور.
        WEBAUTHN_RP_ID: 'nassaj.alkindy.tech',
        WEBAUTHN_ORIGIN: 'https://nassaj.alkindy.tech,http://localhost:5173',
        WEBAUTHN_RP_NAME: 'Nassaj Dev',
      },
    },
  ],
};
