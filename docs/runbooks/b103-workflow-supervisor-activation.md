# تفعيل سوبرفايزر الورشات الدائم (B-103 / ADR-053 الطبقة 2)

> # ⛔ مُبطَل (2026-07-03، قرار المالك «ب1»)
> **لا تُفعّل هذه الطبقة.** أثبت التحليل أنها لا تحقّق الصمود بنيوياً: نقطة حقن النيّة
> تقع **بعد** حلقة `for-await` — downstream من موت العملية نفسها التي كان يُفترض أن تنجو منه.
> الطبقة 2 (المُشغِّل الخارجي الدائم) **مُبطَلة ولن تُفعَّل**؛ خطوات التفعيل أدناه **محفوظة
> للأرشيف فقط**. المسار العامل الوحيد = **الطبقة 1 (الرؤية)** — يبقى حيّاً.
> حزام أمان مُضاف (B-126): جسر النيّة يرفض الكتابة عندما تكون الورشة قد نُفِّذت inline
> (`ENABLE_ULTRACODE_WORKFLOWS`)، فلو فُعّل العلم سهواً لا يحدث تنفيذ مزدوج.

> **الحالة:** الكود مُلتزَم (`4bf9af31`) خلف علم `WORKFLOW_SUPERVISOR` (افتراضي **OFF** ⇒ no-op تام).
> هذا الملف خطوات **التفعيل** بيد المالك/devops. لا يُنفّذها وكيل — بعضها أوامر إنتاج حسّاسة
> يحجبها حارس عميل Claude Code.

## البنية باختصار
سوبرفايزر مستقلّ (وحدة systemd `--user`) يستطلع ملفّات النيّة (يكتبها جسر `claude-sdk.js`
بعد حلقة الردّ)، ويُطلق كل ورشة `claude -p` كـ**خدمة/نطاق `wf-*.scope` عابر تحت systemd
`--user`** — فتنجو من موت أي منسّق (طرفية/ssh/التطبيق نفسه). هذا جوهر إصلاح B-103.

## المتطلّب المسبق الحرِج — نافذة restart نظيفة
`restart` تطبيق nassaj-dev لتحميل العلم يستلزم drain؛ **وجود أي جلسة `claude` حيّة ابنة
لعملية nassaj-dev = انقطاع 502 ممتد** (حادثة 2026-06-27/30). بوّابة `safe-restart` **عمياء عن
جلسات claude التفاعلية** (تفحص الورشات فقط). لذا قبل الخطوة 4:
- أغلِق كل جلسات nassaj-dev التفاعلية (بما فيها جلسة المنسّق إن كانت ابنة nassaj-dev).
- تحقّق: `pgrep -a claude` — لا تُبقِ جلسات مُطلَقة من واجهة الويب.

## الخطوات

### 1) بناء الخادم (يُصرّف الوحدة + التكاملات إلى dist-server)
```bash
cd /home/nassaj/Project/nassaj-dev
npm run build:server        # إن قلّم NODE_ENV=production الـdevDeps: npm i --include=dev أولاً
```
يجب أن يظهر `dist-server/server/modules/workflow-supervisor/supervisor.js`.

### 2) تفعيل العلم لجانب الجسر (nassaj-dev)
أضِف إلى بيئة ecosystem الخاصة بالعقدة (ecosystem.<node>.config.cjs / .env):
```
WORKFLOW_SUPERVISOR=1
# اختياري: WORKFLOW_SUPERVISOR_MAX_PER_USER=3
```

### 3) تركيب وحدة السوبرفايزر (systemd --user، خامدة بلا العلم فآمنة)
```bash
sed -e 's|@@WORKDIR@@|/home/nassaj/Project/nassaj-dev|g' \
    -e "s|@@NODE@@|$(command -v node)|g" \
  server/modules/workflow-supervisor/workflow-supervisor.service.template \
  > ~/.config/systemd/user/workflow-supervisor.service
systemctl --user daemon-reload
systemctl --user enable --now workflow-supervisor.service
```

### 4) إعادة تشغيل nassaj-dev (نافذة نظيفة، طرفية المالك حصراً)
```bash
bash scripts/safe-restart.sh --exec      # حارس عميل Claude Code يحجبه داخل الأداة — نفّذه بطرفيتك
```

### 5) التحقّق الحيّ
```bash
systemctl --user status workflow-supervisor.service        # active (running)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3004/   # 200
```
- أطلق ورشة من الواجهة، ثم أغلِق جلسة المنسّق، وأثبت أن `wf-*.scope` تبقى `active`
  (`systemctl --user list-units 'wf-*'`) والورشة تُكمل — وهو ما يفشل قبل هذا الإصلاح.

## التراجع (Rollback)
1. `WORKFLOW_SUPERVISOR` → أزِلها/`0` من ecosystem ثم `safe-restart.sh --exec`.
2. `systemctl --user disable --now workflow-supervisor.service`.
الكود يعود no-op فوراً (المسار كله مبوَّب بالعلم).

## ما يبقى قبل التفعيل (توصية)
- مراجعة qa-critic مستقلّة + tester (يُفضّل من جلسة منسّق على طرفية SSH مستقلّة كي تنجو الوكلاء).
- توقيع devops حيّ على GATE2 (اختبار القبول أخضر أصلاً: `gate2-ownership.test.ts` 5/5).
