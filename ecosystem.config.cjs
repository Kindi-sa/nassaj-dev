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
      },
    },
  ],
};
