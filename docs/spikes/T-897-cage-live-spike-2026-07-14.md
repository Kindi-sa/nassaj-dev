# T-897 — Live Cage Spike / سبايك القفص الحيّ (2026-07-14)

**Scope / النطاق:** تحقّق حيّ فقط (verification spike). لا كود إنتاج، لا تعديل مُطلِقات المزوّدات، لا commit، لا restart. المخرَج تقرير + قرار.
**Flag / العلم:** `NASSAJ_PROVIDER_CAGE=true` (افتراضياً مطفأ).
**Module under test / الوحدة:** `server/services/isolation/provider-cage.js` → `buildCagedLaunch`.
**bwrap:** `node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap` (resolved by the module itself).
**usersRoot:** `/home/nassaj/.nassaj-users` (real users on disk: 1,2,3,5,6,7,99,user-A,user-B,…).
**Method / المنهج:** الـargv مُشتَقّ من الوحدة نفسها (`buildCagedLaunch`) لمستخدم حقيقي (`userId=2`)، cwd = `mktemp -d` (لا مجلد المشروع)، probes نسخة/مساعدة فقط (لا جلسات تولّد transcript). لا fixtures — كل شيء على أشجار فعلية.

## Derived caged argv / الوصفة الفعلية المُشتقّة

```
bwrap --unshare-user --unshare-pid --unshare-ipc \
      --ro-bind / / --dev /dev --proc /proc \
      --tmpfs /run --tmpfs /tmp \
      --tmpfs /home/nassaj/.nassaj-users \
      --bind /home/nassaj/.nassaj-users/2 /home/nassaj/.nassaj-users/2 \
      --bind <cwd> <cwd> \
      -- <providerCmd> <args...>
```
`cageEnabled`: claude/gemini/agy/opencode/hermes = true ; codex = false ; kimi/deepseek/glm = false. مطابق للتصميم.

---

## 1) Provider boot under the cage / إقلاع كل مزوّد

Probe = `<bin> --version` داخل الـargv المُقفَّص، cwd مؤقت، `timeout 60`.

| Provider | Bin | يُقلِع؟ | Evidence / سبب |
|---|---|---|---|
| claude | `~/.local/bin/claude` | ✅ exit 0 | `2.1.207 (Claude Code)` |
| gemini | `~/.local/bin/gemini` | ✅ exit 0 | `1.1.1` |
| agy | `~/.local/bin/agy` | ✅ exit 0 | `1.1.1` |
| opencode | `~/.opencode/bin/opencode` | ✅ exit 0 | `1.17.18` |
| hermes | `~/.local/bin/hermes` | ✅ exit 0 | `Hermes Agent v0.17.0 … Python 3.11.15` |
| codex | `/usr/bin/codex` | معفى (exempt) | يقفّص نفسه — لا يُلَفّ (double-bwrap) |
| cursor | — | غير مثبّت | لا probe ممكن؛ لا مبرّر خاص متوقّع (يلفّه القفص كـagy) |

**النتيجة:** الخمسة المحليّة القابلة للقفص تُقلِع جميعاً exit 0 بلا أي تعديل. الـFS كامل متاح للقراءة (ro-bind /) فالثنائيات ومكتباتها وnode/python كلها حاضرة. أول دليل عزل ظهر هنا: `id` داخل القفص = `groups=nassaj,nogroup` — **مجموعة docker أُسقِطت** (uid 1000 لا يزال مُطابَقاً عبر userns).

---

## 2) Claude + MCP — النتيجة: يعمل، القفص لا يكسر MCP

`claude mcp list` داخل القفص **مطابق حرفياً** لتشغيله خارج القفص (نفس الإخراج، exit 0): يفحص صحة الخوادم فعلياً. `plugin:github` (خادم HTTP) يفشل الاتصال في الحالتين لسبب مصادقة/شبكة **لا علاقة له بالقفص**.

آليات MCP الحرجة اختُبرت مباشرة داخل القفص:

| القدرة | لماذا تهمّ MCP | النتيجة داخل القفص |
|---|---|---|
| توليد عملية فرعية (node → child → grandchild) | خوادم MCP stdio أبناء عمليات | ✅ `grandchild pid 10 status 0` — `--unshare-pid` لا يمنع الـfork، يعطي فضاء pid جديد فقط |
| فضاء مستخدم متداخل `unshare -Ur` | سandbox كروم في playwright يُنشئ userns خاصاً به | ✅ `NESTED_USERNS_OK`, `id -u = 0` داخل المتداخل |
| `/dev/shm` | كروم يحتاج shm | ✅ حاضر (`--dev` يوفّره) |
| bwrap متداخل | مُطلِق playwright/إعادة قفص | ✅ `NESTED_BWRAP_OK` |

**الحكم:** خوادم MCP (بما فيها playwright الذي يُطلق متصفحاً) تعمل تحت القفص. لا `--unshare-*` ولا bind يكسر MCP. cache المتصفح `~/.cache/ms-playwright` مرئي (ro-bind /). التحفّظ الوحيد: كتابة المتصفح لملفاته المؤقتة تعتمد على `/tmp`/`/dev/shm` (tmpfs داخل القفص) — متاحة.

---

## 3) Interactive PTY — النتيجة: يعمل

شُغّل الأمر المُقفَّص تحت PTY حقيقي (`python3 pty.spawn`، مُكافئ node-pty):

```
tty=/dev/console
STDIN_IS_TTY
STDOUT_IS_TTY
[pty child exit=0]
```

- `isatty(stdin)` و`isatty(stdout)` = **true** داخل القفص → الجلسات التفاعلية تحصل على tty فعلي.
- الفرق الوحيد عن خارج القفص: `tty` يُرجع `/dev/console` بدل `/dev/pts/N`. سلوك معروف لـbwrap مع `--dev` (يربط الـstdio الموروث على `/dev/console` في devtmpfs الجديد). **تجميلي فقط**: البرامج تستعمل `isatty()`/termios على الـfd لا على المسار. `/dev/pts` و`/dev/ptmx` و`/dev/tty` كلها حاضرة داخل `--dev`.
- `stty size` أعطى `0 0` **داخل وخارج** القفص في هذا الـharness (pty.spawn لم يضبط حجم النافذة) — ليس قيد قفص؛ node-pty الحقيقي يضبط cols/rows على الـmaster فتنتشر.

**الحكم:** node-pty يعمل تحت القفص. لا قيد عملي على الجلسات التفاعلية.

---

## 4) Live isolation re-verification (real trees) / إعادة التحقّق من العزل حيّاً

من داخل القفص لمستخدم `2`، على بيانات فعلية:

| البند | متوقّع | مُثبَت |
|---|---|---|
| (أ) شجرة مستخدم آخر مخفية | usersRoot يُظهر `2` فقط | ✅ `ls /home/nassaj/.nassaj-users` → `. .. 2` ؛ المستخدم 1 و3 → `No such file or directory` |
| (أ') مجلّد المستخدم نفسه | مقروء + قابل للكتابة | ✅ محتوى كامل (`.claude .codex .config .gemini .local …`) + `WRITE_OK` (rebind rw) |
| (ب) docker.sock | مُختفٍ | ✅ `/run/docker.sock` و`/var/run/docker.sock` → غير موجودَين؛ `/run` = tmpfs فارغ (`.` `..`). (`/var/run`→`/run` symlink على المضيف، فالـtmpfs يغطّيهما معاً) |
| (ج) عزل /proc خارجي | pid خارجي محجوب | ✅ pid حيّ فعلي `2147`: `/proc/2147/root` و`/proc/2147/environ` → غير موجودَين؛ pids المرئية داخل القفص = `1 2 17 18 19` فقط (فضاء pid جديد بـ`--unshare-pid`) |

العزل الذي صُمِّم القفص لأجله **قائم ومُتحقَّق حيّاً على أشجار حقيقية** — لا fixtures (درس 2026-06-28).

---

## 5) Allowlist vs denylist — القرار المسبَّب

### الدليل الحاسم: ما يتسرّب رغم الـdenylist
الوصفة «denylist» (ro-bind / كامل ثم tmpfs يخفي `/run`,`/tmp`, أشجار المستخدمين الأخرى) **تحقّق ميثاقها المُعلَن** (عزل بين-المستخدمين + إخفاء sockets + ختم /proc) لكنها **تُبقي كامل أسرار المالك مقروءة** داخل القفص (كل ما يقرؤه uid nassaj):

| مسار حسّاس | داخل القفص |
|---|---|
| `~/.ssh/id_nassaj_fleet` (المفتاح الخاص الذي يمنح SSH لكامل الأسطول) | **مقروء** — `-----BEGIN OPENSSH PRIVATE KEY-----` |
| `~/.ssh/id_ed25519`, `known_hosts`, `config` | **مقروء** |
| `~/.claude.json` (توكن/اعتماد Anthropic OAuth للمالك) | **مقروء** |
| `Project/nassaj-dev/.env` (JWT_SECRET، مسار DB) | **مقروء** |
| `~/.local/share/nassaj-dev/db.sqlite` (قاعدة التطبيق: كل المستخدمين/المشاريع) | **مقروء** |
| `/etc/shadow` | محجوب — **لكن بصلاحيات DAC للنظام، لا بالقفص** |

الجوهرة الأثمن (`id_nassaj_fleet`) تعني: عملية مزوّد مخترَقة أو وكيل مُحقَن بالبرومبت داخل القفص **يستطيع تسريب مفتاح يتيح الحركة الجانبية لكل عقد الأسطول**، ونفس الشيء لتوكن Anthropic.

### الموازنة
- **ملاحظة تخفيف:** اليوم (العلم مطفأ) المزوّد يعمل **بلا قفص** كـuid nassaj ويقرأ كل ما سبق أصلاً. فالقفص الحالي **ليس تراجعاً** — هو تحسين صافٍ (عزل بين-المستخدمين + docker + pid). المسألة: هل نُغلق أيضاً تسريب أسرار المالك؟
- **تكلفة allowlist صارم** (ro-bind انتقائي): هشاشة إقلاع عالية. يجب تعداد يدوي لكل: node، ثنائيات المزوّدات (`~/.local/bin`, `~/.opencode/bin`)، `hermes` يحتاج `~/.hermes/hermes-agent` + python + OpenAI SDK، playwright يحتاج `~/.cache/ms-playwright` + مكتبات كروم + خطوط + `/dev/shm`، `~/.npm` لخوادم MCP عبر npx، `/etc/ssl` + `/etc/resolv.conf` + `/etc/hosts` + `/etc/passwd`. **كل خادم MCP جديد أو تحديث مزوّد يخاطر بكسر مسار.** ثبت في هذا السبايك أن hermes يعتمد على شجرة python كاملة تحت home وplaywright على cache تحت home — allowlist ساذج يكسرهما فوراً.

### القرار القاطع
**الـdenylist كافٍ لميثاق القفص ويُشحَن كما هو** (تحسين صافٍ، صفر كسر مزوّد، MCP وPTY سليمان). **allowlist كامل غير مبرّر** الآن — نسبة الهشاشة/العائد سيئة، ويكسر hermes/playwright بلا تعداد شاق مستمر.

**لكن قبل تفعيله في الإنتاج، أضِف طبقة إخفاء أسرار مُستهدَفة رخيصة (denylist++)** فوق الوصفة الحالية — لا allowlist:
1. **إلزامي:** `--tmpfs /home/nassaj/.ssh` — يُخفي مفتاح الأسطول وكل مفاتيح SSH. رخيص، لا مزوّد محليّ يحتاج SSH keys المالك.
2. **مُوصى (تحقّق per-provider أولاً):** `--tmpfs /home/nassaj/.claude.json` — اعتماد Anthropic للمالك؛ المزوّد المُقفَّص per-user يستخدم `~/.nassaj-users/<id>/.claude` لا global. يُتحقَّق أن لا مزوّد يسقط fallback على `~/.claude.json` قبل الإخفاء.
3. **يُدرَس:** إخفاء `.env`/DB عن المزوّد إن لم يحتجهما (المزوّد لا يقرأ DB التطبيق عادةً) عبر tmpfs مُستهدَف على مساراتهما.

هذه «denylist++»: تُغلق تسريب الجوهرة دون فقدان مرونة الإقلاع التي أثبتها هذا السبايك. **راجِع allowlist الكامل فقط** إذا فرض متطلّب امتثال أشدّ منع قراءة مصدر المضيف عموماً.

---

## Artifacts / الأوامر والمخرجات (مُختصرة)
- الوصفة مُشتقّة من `buildCagedLaunch` (لا يدوية). Helper: `/tmp/cagerun.mjs` (يستورد الوحدة، يشغّل الـargv المُقفَّص، يرث stdio).
- boot: `<bin> --version` × 5 → كلها exit 0 (النسخ أعلاه).
- MCP: `claude mcp list` caged == uncaged ؛ nested userns/`/dev/shm`/nested bwrap = OK.
- PTY: `python3 pty.spawn(cagedArgv)` → `STDIN_IS_TTY`/`STDOUT_IS_TTY`, exit 0.
- Isolation: usersRoot=`. .. 2` ؛ user1/user3 absent ؛ docker.sock ×2 absent ؛ `/proc/2147/{root,environ}` absent.
- Leak: `id_nassaj_fleet`/`.claude.json`/`.env`/`db.sqlite` readable ؛ `/etc/shadow` perm-denied.

## System / النظام
استهلاك الذاكرة ~31% طوال السبايك (< 80%). لا restart، لا commit، لم يُلمَس: `resolve-provider-env.js`, `src/components/sidebar/*`, `useProjectsState.ts`, `i18n/*/sidebar.json`.
