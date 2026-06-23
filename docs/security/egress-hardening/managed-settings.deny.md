# Deny list المصحّحة — substring / anywhere-match

> مسوّدة للمراجعة فقط. لا تُطبَّق إلا بموافقة المالك. هذه الطبقة **دفاع في العمق**؛
> الضابط الحقيقي للـ egress هو `netns-egress-allowlist.sh` (انظر `README.md`).

## لماذا «substring / anywhere-match»

Claude Code يطابق أنماط `Bash(...)` على **السلسلة الكاملة** للأمر. النمط `Bash(curl *)`
يلتقط فقط أمراً يبدأ بـ `curl`؛ فيُفلِت منه:

- `env X=1 curl …`، ` sudo curl …`، `VAR=v curl …` (مسبوق بشيء)
- `something | curl …`، `a && curl …` (curl في وسط السطر)

لذلك تُستخدم الصيغة الأمامية/الأوسط `Bash(*نمط*)` (wildcard من الطرفين) لالتقاط الأداة
**أينما** ظهرت — وهي الصيغة المُتحقَّق منها حيّاً للـ guards الحالية (deny يسبق allow،
والصيغة الأمامية تعمل؛ انظر `_deny_note` في `managed-settings.json`).

## قائمة الحجب الكاملة المقترحة

تُدمَج في `permissions.deny`. **تُحفَظ الحُرّاس الموجودة كما هي** (git push + prisma/DB)
**وتُضاف** حُرّاس الـ egress أدناه. ضع حُرّاس الـ egress أولاً ثم اتبعها بالحُرّاس الموجودة:

```jsonc
"deny": [
  // ── egress: أدوات نقل/تحميل HTTP(S)/شبكة مباشرة ──
  "Bash(*curl*)",
  "Bash(*wget*)",
  "Bash(*nc*)",
  "Bash(*ncat*)",
  "Bash(*netcat*)",
  "Bash(*socat*)",
  "Bash(*telnet*)",
  "Bash(*ftp*)",
  "Bash(*tftp*)",
  "Bash(*ftpget*)",
  "Bash(*rsync*)",
  "Bash(*scp*)",
  "Bash(*sftp*)",
  "Bash(*ssh*)",

  // ── egress: استعلام DNS مباشر (نفق DNS) ──
  "Bash(*dig*)",
  "Bash(*nslookup*)",
  "Bash(*host*)",
  "Bash(*getent*)",
  "Bash(*resolvectl*)",
  "Bash(*systemd-resolve*)",

  // ── egress: sockets عبر أصداف/مفسّرات ──
  "Bash(*/dev/tcp/*)",
  "Bash(*/dev/udp/*)",
  "Bash(*openssl s_client*)",
  "Bash(*busybox*)",
  "Bash(*python -c*)",
  "Bash(*python3 -c*)",
  "Bash(*perl -e*)",
  "Bash(*ruby -e*)",
  "Bash(*node -e*)",
  "Bash(*node --eval*)",

  // ── الحُرّاس الموجودة (تُحفَظ كما هي) ──
  "Bash(git push)",
  "Bash(git push:*)",
  "Bash(*git push*)",
  "Bash(*prisma migrate*)",
  "Bash(*prisma db push*)",
  "Bash(*prisma db execute*)",
  "Bash(*prisma db drop*)",
  "Bash(*prisma migrate reset*)",
  "Bash(*prisma migrate deploy*)",
  "Bash(*migrate reset*)",
  "Bash(*migrate deploy*)",
  "Bash(*db:push*)",
  "Bash(*db push*)",
  "Bash(*db:seed*)",
  "Bash(*seed:prod*)",
  "Bash(*seed-prod*)",
  "Bash(*seed:dev*)",
  "Bash(*seed-dev*)",
  "Bash(*dropdb*)",
  "Bash(*DROP DATABASE*)",
  "Bash(*DROP SCHEMA*)",
  "Bash(*DROP TABLE*)",
  "Bash(*TRUNCATE TABLE*)",
  "Bash(*pg_resetwal*)"
]
```

## يجب أيضاً إضافتها إلى `settings.json` (الذي لا يحوي أيّاً منها)

`managed-settings.json` (root) يحوي الحُرّاس، لكن **`settings.json` على مستوى المشروع
لا يوجد أصلاً** (الموجود فقط `.claude/settings.local.json` بصلاحية `Read` واحدة). أنشئ
`/home/nassaj/Project/nassaj-dev/.claude/settings.json` وضع فيه **نفس** كتلة `deny` أعلاه.

> لماذا تكرارها رغم وجودها في managed؟ defense-in-depth وتغطية الحالات التي يُقرأ فيها
> إعداد المشروع دون الـ managed (تطوير، اختبار، نسخ منقولة). الـ managed يبقى الأعلى أسبقية،
> لكن وجودها في الطبقتين يقلّل المفاجآت. لا تضع secrets في هذا الملف.

## يجب إزالتها: الـ allows الإيجابية التي تفتح الـ egress

`managed-settings.json` يحوي حالياً صلاحيات `allow` صريحة تتعارض مع الحجب أعلاه وتفتح
قنوات egress مباشرة. **أزِلها** (الأسطر المقابلة في `permissions.allow`):

```jsonc
// احذف هذه الستة من permissions.allow:
"Bash(curl *)",
"Bash(wget *)",
"Bash(dig *)",
"Bash(nslookup *)",
"Bash(ping *)",
"Bash(host *)"
```

ملاحظة أسبقية: في Claude Code تسبق `deny` الـ `allow`، فحتى لو بقيت هذه الـ allows فالحجب
يغلب — لكن إبقاؤها مُضلِّل ويُوحي بأن الـ egress مسموح. الإزالة توضّح النية وتمنع الاعتماد
عليها في طبقة أدنى لا تطبّق نفس الـ deny.

## ثغرة باقية لا تُغلق إلا في طبقة الـ netns

الحجب أعلاه يلتقط `node -e` / `node --eval` / `python -c` / `python3 -c`، لكن الـ allows
العامة التالية **تبقى مفتوحة** لأنها ضرورية لعمل المشروع (build/test/scripts):

```
"Bash(node *)"     "Bash(python3 *)"     "Bash(python *)"     "Bash(bash *)"     "Bash(sh *)"
```

أي سكربت `.js`/`.py`/`.sh` يُشغَّل عبر هذه الصلاحيات يستطيع فتح socket خارجي **دون** أن
يمرّ على الحجب (الحجب على `-e`/`-c` فقط، لا على تشغيل ملف). هذه الثغرة **بنيوية ولا تُغلق
من داخل الجلسة** — تُغلق حصراً في طبقة الـ netns (default-DROP egress)، حيث يُسقَط الـ packet
في النواة بغضّ النظر عن البرنامج الذي ولّده. لذا تبقى `netns-egress-allowlist.sh` هي الضابط،
وهذه القائمة دفاعٌ في العمق فقط.
