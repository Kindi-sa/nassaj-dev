# T-820 — shadow harness (B-103 المرحلة 2)

نسخة ظل معزولة تُثبت معايير القبول الأربعة (§و/م2) على **السيرفر الفعلي المبنيّ**
(`dist-server`) + المُشرف المستقل، بمنفذ/قاعدة/`HOME` مؤقتة والعلم `WORKFLOW_SUPERVISOR=ON`
— **دون أي مسّ** للعملية الحيّة، القاعدة الحيّة (`~/.local/share/nassaj-dev/db.sqlite`)،
أو `~/.nassaj-users` الحقيقي. كل شيء تحت `$SHADOW_ROOT` (افتراضاً `/tmp/b103-t820-shadow`)
ويُحذف عند الهدم.

> يتطلّب بناءً حديثاً: `npm run build:server`. الاعتماد: عزل `CLAUDE_CONFIG_DIR` (GATE1 PASS).

## البنية
```
harness/
  _env.sh          مصدر الحقيقة لكل مسار/علم (SERVER_PORT، DATABASE_PATH، HOME، …)
  shadow-up.sh     يبني الظل: بذر القاعدة (مالك+غريب+مشروع) + بذر نسخة اعتماد المالك +
                   تشغيل السيرفر (nohup) + تحقّق عزل القاعدة من /proc + تشغيل المُشرف + سكّ التوكنات
  shadow-down.sh   الهدم: قتل العمليات بالـpidfile + إيقاف الوحدات العابرة + تأكيدات صفر-تسرّب + حذف المؤقت
  seed-db.mjs      يبذر القاعدة المؤقتة ويطبع المسار الفعّال من العملية (إثبات العزل)
criteria/
  _crit_common.sh  دوال مشتركة (POST، environ، انتظار ملف، عدّ الوحدات)
  criterion1-launch-isolation.sh   إطلاق مصادق ⇒ وحدة معزولة (/proc) + result.json/DONE بالعقد
  criterion2-gate2-deny.sh         GATE2: فارغ/"abc"/غير-مالك ⇒ صفر إطلاق، بلا مسّ اعتماد المالك
  criterion3-queue-cap.sh          السقف العالمي ⇒ N+1 queued (لا OOM) ثم يُطلق عند تحرّر خانة
  criterion4-flag-off.sh           العلم OFF ⇒ 404 + صفر أثر (على مثيل OFF مستقل)
  run-all.sh       up → المعايير الأربعة → down (trap يضمن الهدم دائماً)
```

## التشغيل
```bash
# دورة كاملة موصى بها
bash spikes/b103-t820/criteria/run-all.sh

# يدوياً (لإبقاء الظل قائماً وإعادة معيار وحده)
bash spikes/b103-t820/harness/shadow-up.sh
source /tmp/b103-t820-shadow/run/session.env
bash spikes/b103-t820/criteria/criterion1-launch-isolation.sh   # وهكذا 2/3/4
bash spikes/b103-t820/harness/shadow-down.sh
```

## ملاحظات
- المنافذ: 3005 (رئيسي، العلم ON) و3006 (مثيل العلم OFF لمعيار 4). عدّلهما عبر `SHADOW_PORT`/`SHADOW_PORT_OFF`.
- القيد البيئي للمصادقة (نسخة معزولة لا تُحدِّث رمز OAuth منتهياً) ⇒ `claude` يخرج ≠0 في الظل فيُثبَت
  **فرع الفشل** من عقد المنتِج حيّاً؛ فرع النجاح (result.json نظيف) مُثبَت offline على fixtures حقيقية في
  `result-capture-writer.test.ts`. التفصيل: `docs/plans/B-103-T820-ACCEPTANCE-2026-07-10.md` §4.
- الهدم يؤكّد: اعتماد المالك سليم، القاعدة الحيّة و`~/.nassaj-users` بلا تغيير، صفر وحدات/عمليات باقية.
```
```
