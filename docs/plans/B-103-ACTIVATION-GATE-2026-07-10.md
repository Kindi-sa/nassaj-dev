# بوابة تفعيل B-103 (النموذج اللاتزامني) — Runbook المالك

> **الحالة:** العلمان `WORKFLOW_SUPERVISOR` و`WORKFLOW_SUPERVISOR_CHAT_LOCK` **OFF** الآن — الميزة
> كلها خامدة (no-op على المسار الحرج). هذه الوثيقة تجمع **كل** ما يلزم لقلب العلم إنتاجياً، وهي
> **بوابة مالك**: لا يمكن إتمامها في جلسة المنسّق (السبب في §هـ). نُفِّذ خطوةً-خطوة على **طرفية SSH
> مستقلّة** (خارج Claude Code).
> **المرجع:** قبول T-823 (`B-103-T823-ACCEPTANCE-2026-07-10.md`) + تدقيق T-820 الأمني (C3) + فيتو
> T-822 (شروط 3-6). **المعيار:** الأمان ← الاستقرار ← سهولة الاستخدام.

---

## ملخص القرار للمالك (ما تبقّى عليك حصراً)

كل التصليب والإثبات المتاح دون تفعيل حي **أُنجز وأُثبت على الظل بأرقام** (146/146 وحدة + 39/39 soak
+ 6/6 reboot + 4/4 رؤية safe-restart). يتبقّى عليك **أربعة** فقط، كلها هنا:
1. **تأكيد أمني حيّ** (أ): `IS_PLATFORM=OFF` + `provider-sharing[claude]=isolated`.
2. **قلب العلم** (ب) عبر `safe-restart.sh --exec` (لا restart خام) بعد `build:server`، **بنفس القيمة
   على التطبيق والمشرف** (د).
3. **soak إنتاجي 72h** (ج) + توقيع devops + qa-critic حي.
4. جاهزية **التراجع الفوري** (ب): العلم OFF = no-op فوري.

يُنصح بتفعيل **مرحلي**: المرحلة 1 `WORKFLOW_SUPERVISOR` فقط (تسليم بطاقات، **لا مسّ للمسار الحرج**)؛
المرحلة 2 (لاحقاً بعد soak المرحلة 1) إضافة `WORKFLOW_SUPERVISOR_CHAT_LOCK` (حاقن Tier-B + قفل الدردشة،
مقعد خطر 502). الفصل مقصود (فيتو T-822): يمكنك تشغيل التسليم كاملاً دون لمس `claude-sdk.js`.

---

## أ) التأكيد الأمني الحيّ — شرط أ3/C3 (حاجز، fail-closed)

> **لماذا:** لو كان `IS_PLATFORM=ON` و`claude` isolated وعدد المستخدمين >1، لصادَقت **كل** الجلسات
> كأول مستخدم على اشتراكه ⇒ كل المهام الخلفية على اشتراك المالك = مشاركة صامتة (مخالفة ToS، B-5/T-50).
> التفعيل ممنوع قبل تأكيد الوضع الآمن.

**الحالة كما فُحصت 2026-07-10 (read-only، دون فتح القاعدة الحيّة):**
- `IS_PLATFORM` مشتقّ من `VITE_IS_PLATFORM==='true'` — **غير مضبوط** في بيئة PM2 الحيّة ولا في `.env`/
  `ecosystem` ⇒ `false` (آمن).
- `provider-sharing[claude]` الافتراضي في الكود = `isolated`. القيمة الفعلية في `app_config` **لم تُقرأ**
  (القاعدة الحيّة محظورة على المنفِّذ) ⇒ **تأكيدها الحيّ إجراؤك أدناه.**

**نفّذ للتأكيد (قراءة-فقط):**
```bash
# 1) IS_PLATFORM يجب أن يكون OFF (فارغ = OFF):
node -e 'const p=require("child_process").execSync("pm2 jlist").toString();const a=JSON.parse(p);const e=(a.find(x=>x.name==="nassaj-dev")||{}).pm2_env||{};console.log("IS_PLATFORM(app.env)=",e.env&&e.env.IS_PLATFORM, "VITE_IS_PLATFORM=",e.env&&e.env.VITE_IS_PLATFORM)'
grep -Rin 'VITE_IS_PLATFORM\|IS_PLATFORM' .env .env.* ecosystem*.cjs 2>/dev/null || echo "OK: not set (⇒ OFF)"

# 2) provider-sharing[claude] يجب أن يكون isolated — يؤكّده حارس الإقلاع من القاعدة الحيّة نفسها:
node -e 'import("./dist-server/server/services/provider-sharing.js").then(m=>console.log("claude sharing =", m.getProviderSharingConfig().claude))'
```
- **البوّابة:** المتوقّع `IS_PLATFORM` فارغ/false و`claude sharing = isolated`.
- **الحارس التلقائي:** `server/services/platform-isolation-guard.service.js` يرفض إقلاع السيرفر
  fail-closed إن (platform ON) و(claude isolated) و(>1 مستخدم نشط). إن ظهر خطأ إقلاع منه بعد التفعيل ⇒
  **لا تُفعّل**: عالج بأحد حلوله (تعطيل platform، أو claude=shared إن كان مقصوداً وموافقاً لـToS، أو ≤ مستخدم
  واحد) ثم أعد الفحص.

**⛔ إن كان `IS_PLATFORM=ON`: أوقف التفعيل** وأعد للمنسّق/architect (يخرج عن نطاق backend-dev).

---

## ب) قلب العلم — الأوامر الدقيقة (عبر safe-restart، لا restart خام)

> **قاعدة حازمة:** ممنوع `pm2 restart nassaj-dev` الخام (يحبس المنفذ 3004 بوجود جلسة حيّة ⇒ 502 ممتد،
> حادثتا B-95). استعمل `scripts/safe-restart.sh` حصراً.

### 0) بناء السيرفر أولاً (الكود المبنيّ هو ما يُشغَّل)
```bash
cd /home/nassaj/Project/nassaj-dev
npm run build:server            # يُجمِّع الكود الخامد؛ لا يمسّ العميل ولا يعيد التشغيل
```

### المرحلة 1 — تفعيل `WORKFLOW_SUPERVISOR` فقط (لا مسّ للمسار الحرج)

**التطبيق (nassaj-dev):** حقن حيّ آمن عبر `--set` (آلية B-117: بيئة معاد تركيبها + تحقّق fail-closed
للمفاتيح الحسّاسة قبل/بعد؛ `WORKFLOW_SUPERVISOR` ليس حسّاساً فيُسمَح به):
```bash
cd /home/nassaj/Project/nassaj-dev
bash scripts/safe-restart.sh --set WORKFLOW_SUPERVISOR=1 --exec
# النجاح: يُسجَّل "الحقن نجح والمفاتيح الحسّاسة صينت" + pm2 save (يصمد reboot عبر resurrect).
```
> للدوام عبر إعادة بناء الحالة من ecosystem لاحقاً: أضِف `WORKFLOW_SUPERVISOR: '1'` إلى كتلة `env` في
> ملف عقدتك `ecosystem.<node>.config.cjs` أيضاً (مصدر الحقيقة).

**المشرف (workflow-supervisor.service):** ثبّته من القالب بالعلم نفسه:
```bash
# انسخ القالب واستبدل @@WORKDIR@@=/home/nassaj/Project/nassaj-dev و@@NODE@@=$(command -v node)
install -Dm644 server/modules/workflow-supervisor/workflow-supervisor.service.template \
  ~/.config/systemd/user/workflow-supervisor.service
sed -i "s|@@WORKDIR@@|/home/nassaj/Project/nassaj-dev|g; s|@@NODE@@|$(command -v node)|g" \
  ~/.config/systemd/user/workflow-supervisor.service
systemctl --user daemon-reload
systemctl --user enable --now workflow-supervisor.service
```

### المرحلة 2 — إضافة `WORKFLOW_SUPERVISOR_CHAT_LOCK` (لاحقاً، بعد soak المرحلة 1)

> مقعد خطر 502 الوحيد على المسار الحرج (`claude-sdk.js`). لا تُفعّله إلا بعد استقرار المرحلة 1 وبتوقيع
> qa-critic. **يجب أن يُضبط بنفس القيمة على العمليتين** (§د).
```bash
# التطبيق:
bash scripts/safe-restart.sh --set WORKFLOW_SUPERVISOR=1 --set WORKFLOW_SUPERVISOR_CHAT_LOCK=1 --exec
# المشرف: أضِف السطر ثم أعد التشغيل:
#   Environment=WORKFLOW_SUPERVISOR_CHAT_LOCK=1   (في ~/.config/systemd/user/workflow-supervisor.service)
systemctl --user daemon-reload && systemctl --user restart workflow-supervisor.service
```
> **التأكيد الإقلاعي للثابت (شرط 3، مُصلَّب كوداً):** المشرف يفحص عند الإقلاع
> `chatLockWaitMs ≥ injectorMaxHoldMs + grace` وأن الاثنين تحت سقفيهما، و**يفشل fail-closed (exit 1)**
> إن اختلّ الثابت. إن رأيت `invariant BROKEN` في `journalctl --user -u workflow-supervisor` ⇒ صحّح
> `WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS`/`WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS` (الافتراضات آمنة؛
> لا تلمسها إلا لسبب).

### التراجع الفوري (العلم OFF = no-op فوري)
```bash
# التطبيق: أعد الحالة إلى OFF (احذف/صفّر العلم). أبسط تراجع: أزل العلم من ecosystem ثم أعد بناء الحالة
# النظيفة، أو احقن القيمة الفارغة صراحةً ثم أعد التشغيل الآمن:
bash scripts/safe-restart.sh --set WORKFLOW_SUPERVISOR=0 --set WORKFLOW_SUPERVISOR_CHAT_LOCK=0 --exec
# المشرف: أوقفه (خامل فوراً):
systemctl --user disable --now workflow-supervisor.service
```
> بمجرد أن يقرأ الكود العلم OFF: بوابة الإطلاق ترد 404، الجسر لا يكتب نيّة، المقعد في `claude-sdk.js`
> يقصر الدائرة قبل أي `await` (byte-identical). لا هجرة بيانات ولا حالة عالقة — التراجع آمن وفوري.

---

## ج) soak إنتاجي 72h + توقيع حي (بوابة، لا يُختصَر)

soak الظل (T-823) **بديلٌ مُثبِت** لا بديلٌ نهائي. بعد المرحلة 1 (وقبل المرحلة 2 وبعدها):
1. أبقِ العلم ON على تنصيب حيّ **≥72 ساعة** تحت حمل واقعي.
2. راقب دورياً: `systemctl --user status workflow-supervisor`، `journalctl --user -u workflow-supervisor`،
   عدّ `wf-*.service` (`systemctl --user list-units --all 'wf-*.service'`)، وسطور التدقيق تحت
   `~/.local/share/nassaj-dev/workflow-supervisor/tasks/*/audit.log`.
3. **معايير النجاح (نفسها التي قاسها soak الظل، حيّاً):** صفر تسريب عملية/وحدة، صفر تسليم مزدوج/ضائع
   (الـjsonl مصدر الحقيقة)، ثبات ذاكرة المشرف (RSS)، صفر قفل بائت.
4. **شرط 5 (FS شبكي):** إن كان state root على FS شبكي، أثبِت عدم تمزيق البايت للـappend والـrename تحته
   (على الظل local FS فقط — النشر الفعلي مسؤوليتك هنا).
5. **التوقيع:** devops (استقرار/موارد) + qa-critic (مراجعة إغلاق حيّة على طرفية SSH مستقلّة) — كلاهما
   على مخرجات حيّة، لا على الظل.

---

## د) تطابق العلم بين التطبيق والمشرف (شرط 4، إلزامي)

> **الخطر:** لو ضُبط `WORKFLOW_SUPERVISOR_CHAT_LOCK` ON على المشرف وOFF على التطبيق (أو العكس)، لَحقن
> المشرف أدوار Tier-B مُستأنَفة **بلا** تسلسل الدردشة الحيّة على المسار الحرج = بالضبط سباق إفساد jsonl
> الذي وُضِع القفل لمنعه. القفل ذو قيمة فقط حين **يأخذه الطرفان**.

**القاعدة:** انشر العمليتين **بنفس قيمة** `WORKFLOW_SUPERVISOR` و`WORKFLOW_SUPERVISOR_CHAT_LOCK`.
**تأكيد بعد كل تفعيل/تراجع (من بيئة العمليتين الفعلية، لا من ملف الإعداد):**
```bash
# التطبيق (PM2):
tr '\0' '\n' < /proc/$(pgrep -f 'dist-server/server/index.js'|head -1)/environ | grep -E '^WORKFLOW_SUPERVISOR(_CHAT_LOCK)?='
# المشرف (systemd user):
tr '\0' '\n' < /proc/$(pgrep -f 'workflow-supervisor/supervisor.js'|head -1)/environ | grep -E '^WORKFLOW_SUPERVISOR(_CHAT_LOCK)?='
```
يجب أن تتطابق القيم حرفياً على العمليتين.

---

## هـ) لماذا لا يمكن إتمامها في جلسة المنسّق

1. **`safe-restart.sh` يؤجّل بوجود جلسة حيّة:** البوّابة تكشف أي workflow/جلسة claude حيّة (وجلسة المنسّق
   نفسها كذلك) وتخرج بـ`exit 3` (تؤجّل، لا تعيد التشغيل). فـ`--exec` من داخل الجلسة سيمتنع بحق.
2. **`pm2 restart` محجوب بحارس عميل Claude Code:** يُعترَض على مستوى العميل (`[Request interrupted]`)
   حتى لو كان مسموحاً في الإعدادات.
3. **restart يقتل الجلسة نفسها:** جلسة Claude ابنة عملية nassaj-dev؛ إعادة التشغيل قد تقتل المنسّق ووكلاءه.

⇒ التفعيل والـ72h والتوقيع الحي **إجراء مالك** على طرفية SSH مستقلّة، في لحظة بلا جلسات حيّة تُستنزَف.

---

## و) التحقّق بعد التفعيل (Smoke)
```bash
# 1) العمليتان حيّتان وبالعلم نفسه (§د أعلاه).
# 2) بوّابة الإطلاق حيّة (كانت 404 عند OFF):
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3004/api/workflow-supervisor/launch  # ⇒ 401 (تتطلب توكن) لا 404
# 3) رؤية safe-restart تعمل (تظهر المهام الحيّة):
bash scripts/safe-restart.sh    # سيطبع "المهام الخلفية الحيّة (wf-*.service): N"
# 4) أطلق مهمة خلفية من الواجهة وتحقّق من ظهور بطاقة task-notification في المحادثة (بلا دور LLM في card-only).
```

## ز) قائمة تحقّق نهائية (كلها ✅ قبل اعتبار البوابة مغلقة)
- [ ] أ) `IS_PLATFORM=OFF` و`provider-sharing[claude]=isolated` مؤكَّدان حيّاً؛ حارس الإقلاع لا يعترض.
- [ ] 0) `npm run build:server` نجح.
- [ ] ب-م1) `WORKFLOW_SUPERVISOR=1` على التطبيق (عبر `--set --exec`) والمشرف (unit)؛ العمليتان حيّتان.
- [ ] د) قيم العلمين متطابقة على العمليتين (`/proc/<pid>/environ`).
- [ ] ج) soak حيّ ≥72h بصفر تسريب/مزدوج/ضائع + ثبات ذاكرة + صفر قفل بائت.
- [ ] ج) توقيع devops + qa-critic على مخرجات حيّة.
- [ ] ب-م2) (اختياري لاحق) `WORKFLOW_SUPERVISOR_CHAT_LOCK=1` على العمليتين + الثابت الإقلاعي أخضر.
- [ ] التراجع مُختبَر: العلم OFF ⇒ 404 على البوّابة + سلوك byte-identical.
