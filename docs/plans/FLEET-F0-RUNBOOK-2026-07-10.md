# Runbook — المرحلة F0: توحيد إصدار أسطول نسّاج

> **الحالة:** مسودّة تصميم (DRAFT). **لم يُنفَّذ منها شيء.**
> **المرجع:** ADR-FLEET-001/002 (دراسة T-848، `memory/project_nassaj_fleet_architecture`).
> **المؤلف:** devops — 2026-07-10 (قرائي بالكامل).
> **البوابة التالية:** مراجعة qa-critic للسكربتات الحسّاسة → إذن مالك نهائي **لكل عملية إنتاج على حدة**.

---

## 0. قيود صارمة وبوابات الحوكمة (اقرأها أولاً)

هذا المستند **تصميم فقط**. الحدود التالية غير قابلة للتجاوز داخل هذه الجلسة:

1. **ممنوع** `git push`، **ممنوع** deploy/restart، **ممنوع** إنشاء وسم فعلي، **ممنوع** أي كتابة على عقدة بعيدة.
2. **إذن مالك صريح لكل عملية حسّاسة على حدة** (push, tag, main ff, per-node reset/build/restart, DNS/firewall). الإذن **لا يُفترض من سياق سابق**: الموافقة على «بدء التوحيد» ليست موافقة على تنفيذ أي أمر بعينه هنا.
3. **مكتشف حرج (T-848):** حارس عميل Claude المحلي **لا يعترض** `pm2 restart` المُنفَّذ عبر SSH في شِل بعيد. أي `ssh <node> 'safe-restart.sh --exec'` **قابل للتنفيذ فعلاً ويُلغي الإنسان-في-الحلقة**. لذلك: **كل fan-out على عقدة بعيدة يتطلّب إذن مالك صريح لتلك العقدة بالذات**، ويُفضَّل أن ينفّذه المالك بنفسه أو يأذن سطراً بسطر.
4. **على المركز (nassaj):** حارس العميل **يعترض** `pm2` داخل `safe-restart.sh --exec`، فيفشل عند أمر pm2 ويطبع السطر اليدوي — **المالك ينفّذه في طرفيته**. ممنوع منعاً باتّاً التوصية بـ`pm2 restart nassaj-dev` الخام (drain + kill_timeout يحبس 3004 → 502 ممتد).
5. **بوابات الرفض (devops):** بلا `PROJECT_PLAN.md`/تفويض ⇒ رفض؛ عملية إنتاج بلا إذنها المستقل ⇒ رفض؛ تنفيذ بلا rollback قابل للتطبيق ⇒ رفض.

---

## 1. نطاق F0 (ما يشمله وما لا يشمله)

**يشمل** (توحيد الإصدار فقط، قبل أي مكننة توزيع):
- مصالحة `main` لإيقاف كونه مرجع نشر متأخّراً (166 خلف).
- ترسيم فرع نشر وحيد (القرار D1).
- أول وسم أسطول معتمد `nassaj-vX.Y.Z` + مؤشّر `fleet-current` (القرار D3).
- تضمين إصلاحَي B-158/B-159 قبل قطع الوسم (القرار D4).
- ترحيل ترافنشر ورخيمي إلى الوسم؛ إصلاح مفارقة إقلاع رخيمي (تسليم `safe-restart.sh`).
- دفع commit المركز غير المدفوع `053d90cf` (بتنسيق الجلسة الموازية).

**لا يشمل** (خارج F0 صراحةً): مكننة GitOps الكاملة (ADR-FLEET-002 مرحلة لاحقة)، القناة العكسية (003)، تزويد المجتنى، أي مسّ بـDNS/نفق Cloudflare/`.env`/قاعدة SQLite على أي عقدة، بوابات AGPL/PDPL للأطراف المستقلة (تُحسم مع legal قبل نشر ترافنشر إن كان طرفاً مستقلاً).

---

## 2. القرارات الأربعة (توصيات مع تبرير)

### D1 — فرع الإصدار: **أنشئ `release/fleet` جديداً** (لا ترسيم `integration/publish`)

**الواقع المقيس (2026-07-10):**
- `origin/main = 7efe9a6c` ⊂ `integration/publish = a23e3d1a` (+113 عن main) ⊂ `HEAD = 053d90cf` (+166 عن main). **التاريخ خطّي تماماً** (113+53=166).
- `integration/publish` **متأخّر 53 commit** عن قمة العمل الحالية (لا «≈60 أمام» — الرقم في الدراسة تقديري/قديم؛ الدقيق: 113 أمام main، 53 خلف القمة).
- `integration/publish` **يحوي أصلاً** `safe-restart.sh` (‏5cdbef55) و`ecosystem.config.example.cjs` — لكنه يفتقد آخر 53 commit (سلسلة الأمان + سيتضمّن B-158/B-159).

**التوصية:** اقطع فرعاً جديداً **`release/fleet`** من commit الإصدار المعتمد (بعد هبوط B-158/B-159 + commit تجهيز F0). **مبرّرات:**
1. **وضوح الدور:** «release» يصرّح بأنه مصدر النشر الوحيد الذي تُقطع منه وسوم `nassaj-v*` وتشتقّ منه العقد. اسم «integration/publish» يعني «دمج قبل النشر» — دور مختلف؛ خلط الدورين على فرع واحد يعيد نفس الالتباس الذي يقتله ADR-FLEET-001.
2. **صفر فقد تاريخ:** `release/fleet` مقطوع من قمة تحوي `integration/publish` بالكامل (سلف مباشر) → لا commit يُفقد.
3. **منع تعدّد فروع النشر:** فرع نشر وحيد اسمه صريح يمنع الانجراف (الدفع للفرع الخطأ). `integration/publish` **يُجمَّد** ويوثَّق «مهجور، خلَفه release/fleet».
4. **لا كلفة تبديل:** لا يوجد بعد أي وسم `nassaj-v*` ولا `fleet-current` ولا أداة أسطول مربوطة بـ`integration/publish` → التبديل شبه مجاني، والوضوح مكسب صافٍ.

**البديل المرفوض:** ترسيم `integration/publish` عبر `merge --ff-only` إلى القمة ثم اعتماده — يعمل تقنياً (خطّي)، لكنه يُبقي الاسم المضلّل ويستبقي فرعاً ثانياً حيّاً بدور غامض.

### D2 — مصالحة `main`: **fast-forward فقط (`merge --ff-only`)** — لا merge، لا reset

**الواقع:** `origin/main` **سلفٌ صارم** لقمة العمل ⇒ **قابل للتقديم السريع بلا أي merge commit ولا force ولا rewrite.**

**التوصية (جراحة دقيقة، مرة واحدة):**
```bash
# على المركز، بعد قطع الوسم nassaj-v1.35.1 (owner-gated):
git checkout main
git merge --ff-only nassaj-v1.35.1     # يفشل بصوت عالٍ لو لم يكن ff (تأكيد أماني)
# git push origin main                  # ← عملية مستقلّة، تحتاج إذن مالك صريح
git checkout release/fleet
```
**لماذا ff لا غيره:**
- **`--ff-only`** يضمن أنه تقديم سريع فقط؛ لو تغيّر شيء وصار غير ff يتوقّف بخطأ بدل إنشاء merge غير مقصود.
- **reset --hard + force-push مرفوض:** يعيد كتابة تاريخ منشور ويكسر أي متفرّع عن main القديم؛ وبما أن ff متاح فالـreset أسوأ بلا مبرّر.
- **merge commit مرفوض:** فقاعة دمج بلا قيمة على تاريخ خطّي.

**سياسة ما بعد المصالحة:** `main` يُقدَّم سريعاً إلى كل وسم `nassaj-v*` جديد ضمن طقس الإصدار (يصبح مرآةً للمُصدَر الأخير، **لا مصدر نشر أبداً**). **لا عقدة تشغّل `main`** (ADR-FLEET-001) — رخيمي (على main حالياً) يُنقل إلى الوسم في §6. تحقّق preflight: رخيمي@`86faa54` سلفٌ نظيف لقمة العمل (مؤكَّد محلياً) → نقله للوسم تقديمٌ نظيف بلا commits متشعّبة.

### D3 — أول وسم: **`nassaj-v1.35.1`** (فضاء اسم بادئة، موقَّع، ثابت) + مؤشّر **ملف `FLEET_RELEASE`** (لا وسم متحرّك)

**اختيار الرقم `nassaj-v1.35.1`:**
- `package.json = 1.35.0` ويتتبّع أساس upstream (قرار T-840) — يبقى **1.35.0 بلا مسّ**؛ إصدار الأسطول يعيش في الوسم + `FLEET_RELEASE`، لا في package.json (تفادياً لصدام T-840).
- `1.35` (major.minor) يعكس أساس upstream الذي يتتبّعه package.json → مقروئية بشرية: «هذا إصدار أسطول مبنيّ على upstream 1.35.x».
- الـpatch **`.1` لا `.0`**: يشير أنه أول إصدار نسّاج مُصحَّح **فوق** أساس 1.35.0 (يحوي 114+ commit تشعّب نسّاج + إصلاحَي أمان B-158/B-159) — **ليس** upstream 1.35.0 الصِرف. الـ`.0` سيوحي زوراً بالتطابق مع upstream.

**فضاء الاسم البادئة `nassaj-v*` (لا اللاحقة `v*-nassaj`):**
- الوسوم القائمة `v1.34.0-nassaj`، `v1.35.0-nassaj` **لاحقة عارضة قديمة**: تتداخل مع upstream في الفرز و`git describe` (اليوم: `git describe HEAD` = `v1.35.0-nassaj-114-g053d90cf` — يخلط نسّاج بـupstream). هذا التداخل بالضبط ما يقتله ADR-FLEET-001.
- **البادئة** `nassaj-v1.35.1` تفرز في فضائها الخاص وتعزل upstream: `git describe --match 'nassaj-v*'` يعطي وصفاً أسطولياً نظيفاً. **اعتمد البادئة رسمياً، وعُدّ اللاحقة إرثاً مهجوراً.**

**المؤشّر — ملف `FLEET_RELEASE` (موصى) مقابل وسم متحرّك `fleet-current` (مرفوض):**

| المعيار | ملف `FLEET_RELEASE` ✅ | وسم متحرّك `fleet-current` ❌ |
|:--|:--|:--|
| ثبات الوسوم | الوسوم `nassaj-v*` تبقى ثابتة (أفضل ممارسة) | يكسر لا-تغيّر الوسم (نقل وسم = مضاد نمط) |
| أثر التدقيق | كل تقديم = commit مؤرَّخ قابل للمراجعة/التراجع (diff بشري) | لا سجل لما أشار إليه سابقاً |
| فخّ الجلب | لا شيء | `git fetch` لا يحدّث وسماً قائماً بلا `--force` → عقد تعلَق على القديم صامتةً |
| آلية النشر | العقدة تقرأ الملف من قمة release/fleet ثم تفحص الوسم الثابت المذكور | نقل يدوي متكرّر معرّض للخطأ |

**التصميم الموصى:**
- وسوم **ثابتة موقَّعة** `nassaj-vX.Y.Z` = أهداف النشر الفعلية (لا تُنقَل أبداً).
- ملف متتبَّع `FLEET_RELEASE` (في جذر `release/fleet`) يحوي اسم الوسم المعتمد حالياً (`nassaj-v1.35.1`). **تقديم الأسطول = commit واحد يعدّل هذا الملف + إذن مالك** — وهذا الـcommit هو سجل التدقيق.
- المُصالِح/الـfan-out يقرأ `FLEET_RELEASE` من قمة `release/fleet` المجلوبة، يحلّ اسم الوسم، ويفحص الوسم الثابت. **العقد تنشر وسماً لا فرعاً** (ADR-FLEET-001).
- تناسق ذاتي: الوسم `nassaj-v1.35.1` يشير إلى commit ملفُّه `FLEET_RELEASE` يقول `nassaj-v1.35.1`.

### D4 — الإصدار **يجب أن يتضمّن B-158/B-159** (بوابة صلبة قبل قطع الوسم)

- T-844 (B-158: تحصين SVG XSS — nosniff + Content-Disposition:attachment + تعقيم DOMPurify) و T-845 (B-159: حارس realpath ضد Symlink Traversal) **حالتهما `in_progress`** بيد backend-dev (وكيل آخر).
- **الفجوتان قائمتان حيّاً على إنتاج ترافنشر** (تدقيق T-839: HEAD المنشور b8fedb62 = الشجرة المُدقَّقة) — فلا يجوز قطع أول وسم أسطول بلا سدّهما.
- **بوابة القطع (كلها خضراء قبل الوسم):**
  1. commits T-844 + T-845 هبطت على فرع العمل (تحقّق `git log` يذكرهما فعلاً، لا ادّعاء وكيل — [[feedback_verify_agent_claims]]).
  2. `npm run build` أخضر على المركز بعد هبوطهما.
  3. تحقّق سلوكي (qa-critic): رأس `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` على مسار مرفق SVG، وحارس realpath يرفض symlink خارج جذر المشروع.
  4. تحديث اللوحة: T-844/T-845 → `done`، ربطهما بإصدار F0.

---

## 3. سجلّ العقد (المصدر: `docs/fleet/nodes.tsv`)

| node_id | display_label | tailnet_ip | ssh_target | repo_dir | port | public_domain | ecosystem_file | wave | ملاحظة حرجة |
|:--|:--|:--|:--|:--|:--|:--|:--|:--|:--|
| nassaj | نسّاج الكندي | 100.105.15.51 | (المركز/self) | `/home/nassaj/Project/nassaj-dev` | 3004 | nassaj.alkindy.tech | `ecosystem.alkindy.config.cjs` | canary | restart بيد المالك (حارس العميل)؛ لا تُطلق fan-out من جلسة ابنة nassaj-dev |
| rukhaimi | نسّاج الرخيمي | 100.105.15.104 | `ibrahim@100.105.15.104` | `/opt/nassaj` | 3004 | nassaj.alrukhaimi.com | `ecosystem.rukhaimi.config.cjs` (يُنشأ) | wave-1 | ⚠️ لغم ecosystem المتتبَّع + مفارقة إقلاع (بلا safe-restart) |
| traventure | نسّاج ترافنشر | 100.105.15.56 | `ibrahim@100.105.15.56` | `/opt/nassaj` | 3004 | nassaj.traventure.sa | `ecosystem.nassaj.config.cjs` | **last** | shallow → `--unshallow`؛ إنتاج منفصل؛ بوابة AGPL إن مستقل |
| mujtana | نسّاج المجتنى | — | — | — | — | — | — | — | غير مزوَّدة — خارج F0 |

**جسر SSH:** `-i ~/.ssh/id_nassaj_fleet` (ed25519 بلا passphrase، NOPASSWD). لا alias — الوصول بالـIP.
**عزل لكل عقدة (لا يُنسَخ مركزياً):** `.env`، `JWT_SECRET`، `db.sqlite`، `ecosystem.<node>.config.cjs`، `WEBAUTHN_RP_ID`، `ALLOWED_ORIGINS`، نفق Cloudflare. **الـ`.gitignore` يحميها** (`\.env`, `ecosystem.config.cjs`, `ecosystem.*.config.cjs` بـ`!ecosystem.config.example.cjs`, `*.sqlite`, `*.db`, `dist-server/`) → `reset --hard` لا يمسّها **إلا لغم رخيمي أدناه**.

**رمز خروج `safe-restart.sh`:** `0` آمن (نُفِّذ إن `--exec`) · `2` خطأ قراءة/إعداد · `3` عمل حيّ → أُجِّل (تجاوز واعٍ بـ`--force`) · `4` العملية غير مسجَّلة في PM2 → ابدأ من ecosystem · `5` فشل `--set`.

---

## 4. بوابة الجاهزية (كلها خضراء قبل أي تنفيذ)

- [ ] `PROJECT_PLAN.md`/تفويض F0 معتمد (T-848 + إذن المالك ببدء التوحيد).
- [ ] B-158/B-159 هبطتا وبُنيتا خضراء ومُتحقَّقتان سلوكياً (بوابة D4).
- [ ] مراجعة qa-critic لهذا الرunbook ولنص أوامر النشر الحسّاسة → PASS.
- [ ] إذن مالك صريح **لكل**: `git push`، إنشاء الوسم، `main` ff، وكل عقدة على حدة.
- [ ] استهلاك موارد المركز < 80% وحصة الاستخدام < 90% قبل الإطلاق.
- [ ] لا جلسة Claude ابنة nassaj-dev على المركز أثناء restart المركز (تجنّب قتل الجلسة المنسّقة).
- [ ] نسخ احتياطية جاهزة: `dist-server.bak-<TS>` على كل عقدة قبل البناء، وOLD_HEAD ملتقَط لكل عقدة.

---

## 5. المرحلة A — تجهيز الإصدار على المركز (push-first)

> كل الأوامر المُعلَّمة `# OWNER-GATED` تحتاج إذناً صريحاً مستقلاً.

### A1 — تنسيق الجلسة الموازية ودفع commit المركز
`053d90cf` **غير مدفوع** (origin/fix عند b8fedb62، القمة أمامه بـ1). يخصّ الجلسة الموازية.
```bash
git status && git diff --stat                       # تحقّق قبلي (بروتوكول الجلسات المتوازية)
git log --oneline origin/fix/security-remediation-2026-07-09..HEAD   # ما سيُدفع
# نسّق مع الجلسة الموازية: لا تدفع فوق عملها؛ تأكّد أن B-158/B-159 التزمت أولاً.
# git push origin fix/security-remediation-2026-07-09   # OWNER-GATED (دفع صريح)
```

### A2 — commit تجهيز F0 (بعد هبوط B-158/B-159)
```bash
printf 'nassaj-v1.35.1\n' > FLEET_RELEASE
git add FLEET_RELEASE docs/fleet/nodes.tsv docs/plans/FLEET-F0-RUNBOOK-2026-07-10.md
git commit                                          # رسالة conventional، كل سطر ≤100 محرف (commitlint)
# package.json يبقى 1.35.0 (T-840) — لا تعدّله.
```

### A3 — فرع release/fleet + الوسم الموقَّع الثابت
```bash
git branch release/fleet HEAD                        # release/fleet من commit الإصدار
git tag -s nassaj-v1.35.1 -m "nassaj fleet release 1.35.1 (base upstream 1.35.0; +B-158/B-159)"  # OWNER-GATED — موقَّع
git tag -v nassaj-v1.35.1                             # تحقّق التوقيع
# git push origin release/fleet nassaj-v1.35.1        # OWNER-GATED (فرع + وسم)
```

### A4 — مصالحة main (ff-only) — §D2
```bash
git checkout main && git merge --ff-only nassaj-v1.35.1
# git push origin main                                # OWNER-GATED
git checkout release/fleet
```

### A5 — بناء وcanary على المركز (nassaj — canary)
```bash
cp -r dist-server "dist-server.bak-$(date +%Y%m%d-%H%M%S)"     # rollback artifact
unset NODE_ENV; npm ci --include=dev; npm run build           # production يقلّم devDeps → لا بد unset
# restart المركز: حارس العميل يعترض pm2 → المالك ينفّذ يدوياً في طرفيته:
ECOSYSTEM=ecosystem.alkindy.config.cjs bash scripts/safe-restart.sh --exec   # OWNER-GATED (طرفية المالك)
#   exit 3 (عمل حيّ) → أجِّل حتى يفرغ، لا --force إلا بقرار واعٍ.
#   exit 4 (غير مسجَّل) → env -u PORT pm2 start ecosystem.alkindy.config.cjs && pm2 save
# health-gate مزدوج:
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3004/           # توقُّع 200
curl -fsS -o /dev/null -w '%{http_code}\n' https://nassaj.alkindy.tech/     # توقُّع 200
```
**بوابة canary:** لا انتقال لأي عقدة بعيدة قبل أن يعطي المركز 200/200 وسلوك B-158/B-159 مؤكَّد.

---

## 6. المرحلة B — نشر لكل عقدة (تتابعاً: canary→wave-1→last)

**الترتيب:** المركز (canary، §A5) → **رخيمي (wave-1)** → **ترافنشر (last)**.
**كل عقدة وحدة owner-gated مستقلّة.** فشل أي عقدة ⇒ rollback لتلك العقدة ثم **ABORT الأسطول** (لا تتقدّم للتالية).

### B0 — القالب العام لعقدة بعيدة (فحوص + التقاط + نشر + بوابة + rollback)
> بدّل المتغيّرات من `nodes.tsv`. `$SSH="ssh -i ~/.ssh/id_nassaj_fleet <ssh_target>"`.
```bash
# (1) فحوص قبلية:
$SSH 'true' && echo reachable                                    # الوصول
$SSH "cd $DIR && git status --porcelain"                         # شجرة نظيفة (فارغ = نظيف)
$SSH "test -x $DIR/scripts/safe-restart.sh && echo has-safe-restart || echo NO-safe-restart"
$SSH "cd $DIR && git rev-parse --abbrev-ref HEAD && git remote get-url origin"   # upstream المتوقَّع
# (2) التقاط OLD_HEAD (هدف rollback):
$SSH "cd $DIR && git rev-parse HEAD"                             # سجّله: OLD_HEAD=<hash>
# (3) fetch (unshallow إن ضحل):
$SSH "cd $DIR && { git rev-parse --is-shallow-repository | grep -q true && git fetch --unshallow origin || git fetch origin; }; git fetch origin --tags --force"
# (4) نشر الوسم الثابت (لا فرع):
$SSH "cd $DIR && cp -r dist-server dist-server.bak-\$(date +%Y%m%d-%H%M%S)"
$SSH "cd $DIR && git reset --hard nassaj-v1.35.1"               # OWNER-GATED — يمسّ المتتبَّع فقط
$SSH "cd $DIR && unset NODE_ENV; npm ci --include=dev && npm run build"
# (5) restart آمن (SSH يتجاوز حارس العميل → OWNER-GATED صراحةً):
$SSH "cd $DIR && ECOSYSTEM=$ECO bash scripts/safe-restart.sh --exec"   # OWNER-GATED
#   exit 3 → عمل حيّ على العقدة، أجِّل. exit 4 → $SSH "cd $DIR && env -u PORT pm2 start $ECO && pm2 save"
# (6) health-gate مزدوج:
$SSH "curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/"   # 200 محلي
curl -fsS -o /dev/null -w '%{http_code}\n' https://$DOMAIN/               # 200 عام
# (7) عند أي فشل → rollback العقدة ثم ABORT:
#   $SSH "cd $DIR && git reset --hard $OLD_HEAD && { unset NODE_ENV; npm ci --include=dev && npm run build; }"
#   $SSH "cd $DIR && ECOSYSTEM=$ECO bash scripts/safe-restart.sh --exec"
#   أعد فحص health؛ ثم توقّف — لا تتقدّم لأي عقدة.
```

### B1 — رخيمي (wave-1) — **حالتان خاصّتان حرجتان**

**مفارقة الإقلاع + لغم ecosystem:** رخيمي على `main@86faa54`، بلا upstream tracking، ~166 خلف، **وبلا `safe-restart.sh`**؛ و`ecosystem.config.cjs` **متتبَّع** في main → `reset --hard nassaj-v1.35.1` **سيحذفه** (الوسم يتتبّع `.example` فقط) → سقوط على 3001 → EADDRINUSE (تكرار B-110).

**التسلسل الصحيح (يُقدَّم safe-restart أولاً، ويُصان ecosystem قبل الـreset):**
```bash
SSH="ssh -i ~/.ssh/id_nassaj_fleet ibrahim@100.105.15.104"; DIR=/opt/nassaj
# فحوص + OLD_HEAD (=86faa54 متوقَّع):
$SSH "cd $DIR && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD"
# (أ) صيانة ecosystem الحيّ قبل أي reset (اللغم):
$SSH "cd $DIR && test -f ecosystem.config.cjs && cp -a ecosystem.config.cjs ecosystem.rukhaimi.config.cjs && echo saved-node-ecosystem"
#     ecosystem.rukhaimi.config.cjs يطابق ecosystem.*.config.cjs في .gitignore → غير متتبَّع → ينجو من reset.
# (ب) ضبط upstream + جلب (clone غالباً ضحل):
$SSH "cd $DIR && git remote set-url origin https://github.com/Kindi-sa/nassaj-dev.git"   # تأكيد المصدر
$SSH "cd $DIR && { git rev-parse --is-shallow-repository | grep -q true && git fetch --unshallow origin || git fetch origin; }; git fetch origin --tags --force"
# (ج) نسخ dist ثم النقل للوسم (owner-gated):
$SSH "cd $DIR && cp -r dist-server dist-server.bak-\$(date +%Y%m%d-%H%M%S)"
$SSH "cd $DIR && git reset --hard nassaj-v1.35.1"                # OWNER-GATED
$SSH "cd $DIR && unset NODE_ENV; npm ci --include=dev && npm run build"
# (د) الآن safe-restart.sh وصل ضمن الوسم (حُلَّت المفارقة) — استعمله بـecosystem العقدة:
$SSH "cd $DIR && ECOSYSTEM=ecosystem.rukhaimi.config.cjs bash scripts/safe-restart.sh --exec"   # OWNER-GATED
#     exit 4 (أول مرة العملية باسم مختلف/غير مسجَّلة) → env -u PORT pm2 start ecosystem.rukhaimi.config.cjs && pm2 save
# (هـ) لا تمسّ نفق cloudflared (pm2 اسم cloudflared، config محلي http2/edge-ip4) ولا .env ولا DNS.
# (و) health-gate:
$SSH "curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3004/"      # 200
curl -fsS -o /dev/null -w '%{http_code}\n' https://nassaj.alrukhaimi.com/   # 200
```
> تحقّق preflight إضافي: منفذ رخيمي (المفترَض 3004) من `ecosystem.rukhaimi.config.cjs` الحيّ ومن ingress نفقه قبل health-gate.
> **rollback رخيمي:** `git reset --hard 86faa54` + rebuild + start من `ecosystem.rukhaimi.config.cjs` (المصان) ثم ABORT.

### B2 — ترافنشر (last)

**سيرفر إنتاج منفصل** — ينشر **آخراً** بعد ثبوت الإصدار على المركز ورخيمي. **shallow clone → `--unshallow` إلزامي** (وإلا يبقى على الكود القديم صامتاً). درس B-110: غياب `.env` أسقطه على 3001 — لكن ecosystem العقدة هنا `ecosystem.nassaj.config.cjs` (inline، لا يعتمد `.env`) فالمسار مختلف؛ مع ذلك تحقّق من وجوده.
```bash
SSH="ssh -i ~/.ssh/id_nassaj_fleet ibrahim@100.105.15.56"; DIR=/opt/nassaj
$SSH "cd $DIR && git rev-parse HEAD"                             # OLD_HEAD=b8fedb62 متوقَّع
$SSH "cd $DIR && test -f ecosystem.nassaj.config.cjs && echo has-node-eco || echo MISSING-ECO"   # بوابة قبلية
$SSH "cd $DIR && git rev-parse --is-shallow-repository"          # true متوقَّع → unshallow
$SSH "cd $DIR && git fetch --unshallow origin; git fetch origin --tags --force"
$SSH "cd $DIR && cp -r dist-server dist-server.bak-\$(date +%Y%m%d-%H%M%S)"
$SSH "cd $DIR && git reset --hard nassaj-v1.35.1"               # OWNER-GATED
$SSH "cd $DIR && unset NODE_ENV; npm ci --include=dev && npm run build"
$SSH "cd $DIR && ECOSYSTEM=ecosystem.nassaj.config.cjs bash scripts/safe-restart.sh --exec"   # OWNER-GATED
#     exit 4 → env -u PORT pm2 start ecosystem.nassaj.config.cjs && pm2 save   (استرداد B-110)
$SSH "curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3004/"        # 200
curl -fsS -o /dev/null -w '%{http_code}\n' https://nassaj.traventure.sa/      # 200
# rollback ترافنشر: git reset --hard b8fedb62 + rebuild + start من ecosystem.nassaj.config.cjs ثم ABORT.
```
> **بوابة legal قبل ترافنشر:** إن كان ترافنشر طرفاً مستقلاً (كيان أصدقاء) → AGPL §13 (رابط مصدر مطابق للـcommit المخدوم) + §10 + عزل per-user + حارس T-50 + قناة عكسية خالية PII. يُحسم مع legal-compliance-advisor قبل النشر (خارج مسؤولية devops).

---

## 7. Rollback و ABORT (بروتوكول موحّد)

1. **لكل عقدة:** الفشل (build فشل / health ≠ 200 / سلوك خاطئ) → `git reset --hard $OLD_HEAD` + rebuild + start من `ecosystem.<node>.config.cjs` المصان → أعد health-gate.
2. **بعد نجاح rollback العقدة:** **ABORT الأسطول فوراً** — لا تتقدّم لأي عقدة تالية. أبلغ المالك.
3. **بديل سريع لـbuild:** `dist-server.bak-<TS>` المُلتقَط قبل البناء (استعادة ذرّية بلا rebuild).
4. **المركز:** rollback = استعادة `dist-server.bak-<TS>` + السطر اليدوي (المالك).
5. **الوسم ثابت:** لا تحذفه/تنقله عند الفشل — أعِد فقط العقد لـOLD_HEAD؛ صحّح على release/fleet واقطع `nassaj-v1.35.2`.

---

## 8. ما بعد النشر

- تحقّق نهائي: العقد الثلاث 200/200 محلي+عام؛ سلوك B-158/B-159 مؤكَّد على كل عقدة منشورة.
- تحديث اللوحة `docs/project-state.json`: T-844/T-845 → done؛ مهمة F0/T-850 → done؛ سجّل `deployed_ref=nassaj-v1.35.1` لكل عقدة.
- توثيق: أضف مدخل «F0 منفَّذ» في `nassaj-server-docs.md` (وسم + عقد + تواريخ)؛ scribe يحدّث memory الأسطول.
- ثبِّت ADR-FLEET-001/002 في `alkindy/decisions/` (بعد اعتماد المالك).

---

## 9. مخاطر مفتوحة / خارج النطاق (صريح)

- **تزويد المجتنى:** خارج F0 (لا عقدة). تُضاف عبر `bootstrap-node.sh` لاحقاً.
- **مكننة GitOps (المُصالِح systemd + نبضة الدفع):** F1+ (ADR-FLEET-002) — **لا تُمكنَن أمراً غير محدَّد الـref**؛ F0 يوحّد الـref أولاً.
- **القناة العكسية (003):** F لاحقة — حارس ثقة: مدخلات العقدة غير موثوقة.
- **`.env`/`JWT_SECRET`/DB/نفق/DNS:** لا تُمسّ في F0 على أي عقدة (عزل B-114/B-115).
- **passkeys رخيمي:** `WEBAUTHN_RP_ID=localhost` (معلّق) — خارج F0.
- **T-155 (hooks بمسار مثبَّت `/home/nassaj`):** يفشل على مستخدم ibrahim → قد يؤثّر على الحوكمة على العقد؛ يُتابَع منفصلاً.
