# تسليم: عزل مزوّدات الذكاء على uid المشترك — 2026-07-14

وثيقة انتقال لإكمال العمل في محادثة قادمة. المصدر الحيّ للمهام: `docs/project-state.json` (T-893/895/896/897، B-169/170). هذه الوثيقة تجمع السياق والعثرات والخطوات الدقيقة غير المذكورة كاملةً في اللوحة.

## المشكلة (ثابتة)
كل مزوّدات الذكاء (Claude/Codex/Gemini/agy/opencode) تعمل على uid نظام واحد مشترك `nassaj` على كل عقدة أسطول (nassaj-dev + rukhaimi + traventure). العزل مسارّي فقط (CLAUDE_CONFIG_DIR/CODEX_HOME per-user). ثغرتان: (1) قراءة متبادلة لاعتمادات/transcripts المستخدمين؛ (2) هروب جذر عبر عضوية docker.

## الحالة — المحاور الثلاثة

### المحور 1 — التسريب الشبكي (Codex) ✅ منجَز
- `resolveCodexNetworkAccess` صار علم-خادم فقط (`CODEX_WORKSPACE_NETWORK`)، يتجاهل `networkAccess` العميلي. commit ضمن الفرع، **منشور حيّاً على nassaj-dev ومتحقَّق** (HTTP 200). B-169 resolved / T-895 done.
- الأسطول: يصل عبر deploy الفرع على كل عقدة.

### المحور 2 — الهروب لجذر النظام (docker) ✅ على nassaj-dev / ⏳ الأسطول
- **مُغلق ومتحقَّق على nassaj-dev**: `gpasswd -d nassaj docker` + إعادة توليد عفريت pm2 من shell نظيف. العملية والعفريت بلا 989، docker.sock (660 root:989) غير قابل للوصول.
- **⚠️ عثرة موثّقة:** `pm2 restart` وحده لا يُسقط المجموعة — العفريت يخزّنها. الإسقاط: `su - nassaj` (shell نظيف) ← تحقّق `id|grep docker` فارغ ← `pm2 kill && pm2 resurrect` ← تحقّق `/proc/$(pm2 pid nassaj-dev)/status` بلا 989.
- **المتبقّي (T-896):** تقنين السحب في `/home/nassaj/nassaj-core/scripts/provision-node.sh` (طبقة sudo، idempotent) + حارس إقلاع fail-closed **يفحص gid 989 رقمياً** (مالك docker.sock) لا اسم المجموعة. ينتشر عبر fleet-install/git. الرخيمي/ترافنشر ما زالتا مكشوفتين حتى ذلك.

### المحور 3 — العزل الشامل للقراءة (القفص الموحّد) ⏳ الأكبر المتبقّي
القرار المعماري (ورشة ultracode wf_7375c7c9، 4 تصاميم منقودة): **`provider-cage.js`** — قفص bwrap المحزوم مع @openai/codex يلفّ كل مُطلِق، ينتشر بالكود، بلا root.
- **منجَز (م1، commit 9db35113):** الوحدة `server/services/isolation/provider-cage.js` (`cageEnabled`/`resolveBwrapPath`/`buildCagedLaunch`) + 15/15 اختبار + تحقّق قرصي أن القفص يخفي أشجار الآخرين + docker.sock + يغلق `/proc` (--unshare-pid) ويُبقي node يُقلِع. **خامل: خلف علم `NASSAJ_PROVIDER_CAGE` مطفأ، غير موصول.**
- **المتبقّي (T-897):**
  1. **التوصيل** عند طبقة الإطلاق. ⚠️ نقطة الحقن الطبيعية `resolve-provider-env.js` **معدَّلة حالياً بجلسة موازية** — لا تلمسها/تضمّها حتى تستقر. وصّل عند مُطلِقات الأفراد (openai-codex مستثنى — يقفّص نفسه).
  2. **spike allowlist لكل مزوّد حيّ** — خاصة Claude 2.1.126 (بلا sandbox، يلزمه node+bash+خوادم MCP مثل playwright) وجلسات PTY التفاعلية. الوصفة المتحقَّقة الحالية «denylist» (bind-all-ro + tmpfs يخفي الأسرار)؛ قرّر allowlist أصرم إن لزم.
  3. **الطرح** خلف العلم تدريجياً عبر release/fleet + safe-restart.

## عثرات/قيود حرجة للجلسة القادمة
- **ملفات جلسة موازية — لا تضمّها:** `resolve-provider-env.js`، `src/components/sidebar/*` (×2)، `src/hooks/useProjectsState.ts`، `src/i18n/*/sidebar.json` (×2). git add بالاسم دوماً.
- **restart:** `safe-restart.sh --exec` يفشل داخل Claude Code (حارس pm2) — يُنفَّذه المالك بطرفيته. تغيير المجموعات يتطلّب shell نظيف (`su - nassaj`).
- **هشاشة الورشات:** تموت بخروج عملية Claude المنسّقة (انقطعت الجلسة ~4 مرات هنا). للورشات الطويلة: resumeFromRunId، أو استخرج journal وركّب يدوياً، أو شغّل الوكلاء متزامنين (run_in_background:false) لا خلفية.
- **الحصة:** بلغت ~80% في الجلسة السابقة.
- **الذاكرة:** الدرس محفوظ في `project_codex_provider_isolation.md`.

## نقطة التحقّق (تأكيد الحالة الحيّة في الجلسة القادمة)
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3004/           # 200
cat /proc/$(pm2 pid nassaj-dev)/status | grep Groups                       # بلا 989 = docker مغلق
grep -rn "provider-cage" server --include=*.js | grep -v test              # فارغ = ما زال غير موصول
git log --oneline -1                                                       # 820af9d1 (أو أحدث) = مدفوع
```

## آخر commit مدفوع: `820af9d1` (فرع fix/security-remediation-2026-07-09)
