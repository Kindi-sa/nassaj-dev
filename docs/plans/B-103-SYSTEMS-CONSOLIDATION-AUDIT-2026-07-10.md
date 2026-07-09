# تدقيق دمج أنظمة التنفيذ الخلفي / الديمومة / المراقبة (B-103)

> **الغرض:** قبل اعتماد خطة B-103 (`docs/plans/B-103-ASYNC-AGENTS-DESIGN-2026-07-10.md`)، التأكد أنها لا تضيف نظاماً فوق أنظمة متداخلة قائمة. طلب المالك: «لا نسّاجاً ثقيلاً أو محشواً بأنظمة مكررة».
> **الطبيعة:** دراسة قراءة-فقط (architect). لا كود، لا git، لا تعديل ملفات التصميم/اللوحة.
> **منهج الحالة:** كل ادّعاء «نشط/خامل/ميت» مأخوذ من **الكود والأعلام والإعدادات الفعلية** لا من الوثائق — السند (ملف:سطر / اسم علم وقيمته) في **ملحق التحقق (§7)**، وكل بند مُرقَّم للتدقيق ادّعاءً-ادّعاءً.
> **الحالة الحيّة المرجعية:** عملية nassaj-dev = PID 3582900، منذ 2026-07-09T18:52:50Z، 3 restarts (لحظة التدقيق).

---

## 1. الجواب المباشر

**نعم — لدينا نظام مشابه، لكنه ليس منافساً بل هو نفسه أساس B-103.** المحرّك الدائم المبني تحت `server/modules/workflow-supervisor/` (ADR-053 / M-BG-2) هو **بالضبط** ما يوسّعه تصميم DurableTask (intent→DurableTask، نفس `systemd.ts`، نفس `supervisor.ts`، نفس `config.ts`) — التصميم يذكر ~65% إعادة استخدام. فـ B-103 **لا يخلق نظام تنفيذ-خلفي جديداً بجوار القائم؛ بل يُفعِّل هيكلاً خامداً موجوداً** ويعيد استخدام أنماط الرؤية/الشارة.

لكن التدقيق كشف تداخلاً حقيقياً يستحق التبسيط **قبل** التفعيل:

- **ثلاث آليات مستقلة تجيب اليوم على «هل انتهت المهمة الخلفية؟»** (reconcile بالـjournal + liveness بالـpid + scope-liveness الخامد بـsystemd)، و B-103 يضيف رابعة (DurableTask monitor). التصميم يعيد استخدام رسالة reconcile وثابت quiet، لكنه لا يوحّد **سلطة الاكتمال** في واحدة.
- **مسار Layer-2 القديم (`launch-intent.ts` + نقطة `claude-sdk.js:1867`) ميت بقرار (B-126) لكنه ما زال كوداً حيّاً في المسار الحرج** — دَيْن وفخّ قدم، يجب حذفه لا تركه بجوار `writeDurableTask` الجديد.
- **أعلام خامدة لم تُفعَّل قط** (`SESSION_REGISTRY_agy`، `CLAUDE_GHOST_DETACH`) — تعقيد بلا نفع مُثبَت.
- **نظام «المِنوال» (nassaj-ops runner) مشابه ميكانيكياً** (systemd + `claude -p` + عقد ملفات + flock + عزل) لكنه **خارج nassaj-dev**: يستهدف Diwan/AlNuman، وnassaj-dev غير مُسجَّل فيه أصلاً. تشابه محرّك، اختلاف غرض ومستودع.

**الخلاصة التنفيذية:** B-103 **لا يزيد** عدد أنظمة التنفيذ-الخلفي (خامد→نشط، لا +1)، **بشرط** أن يُرافقه تنظيف: حذف مسار Layer-2 الميت، توحيد سلطة كشف الاكتمال، وحسم مصير الأعلام الخامدة والمسار inline الهشّ. بدون هذا التنظيف، سنصل إلى **أربعة كاشفات اكتمال** ومسارَي إطلاق systemd — وهو بالضبط الحشو الذي يخشاه المالك.

---

## 2. حالة الأعلام (الحقيقة الأرضية — لحظة التدقيق)

| العلم | القيمة الحيّة | المصدر الفعلي | الأثر |
|---|---|---|---|
| `WORKFLOW_SUPERVISOR` | **غير مضبوط ⇒ OFF** | غائب عن `/proc/3582900/environ` و`.env` و`ecosystem.alkindy.config.cjs` | كل وحدة workflow-supervisor no-op تام |
| `WORKFLOW_RECONCILE` | **`1` ⇒ ON** | `/proc/environ` + `ecosystem.alkindy.config.cjs:150` | reconcile اكتمال-بعد-restart نشط |
| `SESSION_REGISTRY_claude` | **`1` ⇒ ON** | `/proc/environ` + `.env:39` + `ecosystem:135` | replay/buffer جلسة claude الحيّة نشط |
| `SESSION_REGISTRY_agy` | **غير مضبوط ⇒ OFF** | غائب عن الكل | replay agy خامد |
| `ENABLE_ULTRACODE_WORKFLOWS` | **`true` ⇒ ON** | `.env:32` عبر `load-env.js` (⚠️ غائب عن `/proc` لأنه dotenv وقت-التشغيل لا وقت-exec) | يمرّر `CLAUDE_CODE_WORKFLOWS=1` ⇒ **الورشات inline تعمل فعلاً اليوم** |
| `CLAUDE_GHOST_DETACH` | **غير مضبوط ⇒ OFF** | معلّق في `.env.example:142`، غائب عن `/proc` | فصل الجلسات الشبح عن الدرين خامد |
| `DRAIN_TIMEOUT_MS` | **`0` ⇒ بلا سقف** | `/proc/environ` + `ecosystem:168` | drain ينتظر الأدوار بلا مهلة |
| `treekill` (PM2) | **`false`** | `pm2 jlist` حيّ + `ecosystem:98` | إشارات PM2 تصيب الأم فقط ⇒ الأبناء ينجون restart |
| `kill_timeout` (PM2) | **`86400000` (24h)** | `pm2 jlist` حيّ + `ecosystem:118` | **تصحيح:** ليست 300000 التي ذكرتها ذاكرة قديمة — أُعيدت إلى 24h |
| `max_memory_restart` (PM2) | **`undefined` (مُعطَّل، B-130)** | `pm2 jlist` حيّ + `ecosystem:81-90` | لا restart ذاكرة يقطع درين/جلسة |

> **ملاحظة منهجية حاسمة:** `/proc/<pid>/environ` يُظهر **فقط** متغيّرات وقت-الـexec (حقن PM2 من كتلة `env`)، ولا يُظهر ما يضيفه `load-env.js` من `.env` وقت التشغيل. لذا غياب `ENABLE_ULTRACODE_WORKFLOWS` عن `/proc` **لا** يعني أنه OFF — `load-env.js:20` يضبطه فعلاً في process.env (بأسبقية للـecosystem: يملأ فقط ما لم يُضبط). لا حقول أعلام في قاعدة التطبيق (`app_config` فيه فقط branding + jwt_secret + provider_sharing).

---

## 3. جرد الأنظمة الكامل

المفتاح: 🟢 نشط · 🟡 خامد (مبني، علم OFF) · ⚫ ميت (مُبطَل بقرار) · 🔵 خارج المشروع · ⬜ خارج العائلة (تسمية متشابهة، مجال مختلف).

| # | النظام | الغرض/السند | الملفات | الحالة الفعلية (سند §7) | التداخل مع DurableTask (B-103) | الحكم المقترح (انحياز للحذف) |
|---|---|---|---|---|---|---|
| 1 | **workflow-supervisor** (المحرّك الدائم) | ADR-053 / M-BG-2؛ ديمومة `claude -p` عبر خدمة systemd عابرة تنجو موت المنسّق/restart | `server/modules/workflow-supervisor/` (systemd.ts, supervisor.ts, config.ts, intent.ts, ownership-guard.ts, concurrency.ts, lifecycle.ts, scope-*.ts) | 🟡 **خامد** — `WORKFLOW_SUPERVISOR` OFF؛ `supervisor.ts` لا يُستورَد من الخادم أصلاً (entrypoint مستقل فقط، isMain) | **هذا هو الأساس نفسه** — B-103 يوسّع `intent→DurableTask` ويعيد استخدام systemd.ts/supervisor.ts/config.ts/GATE2/concurrency (~65%) | **يُدمج = يُفعَّل ويُوسَّع** (هو جوهر B-103). لا يُحذف ولا يُكرَّر بمحرّك ثانٍ |
| 2 | **Layer-2 launch-intent bridge** | ADR-053 §ج-1 (المسار المُبطَل) | `workflow-supervisor/launch-intent.ts` + نقطة `claude-sdk.js:1867-1902` | ⚫ **ميت بقرار** (B-126، حسم المالك ب1 2026-07-03) — no-op مضاعف: علم OFF + حارس `inlineWorkflowsActive` | التصميم صريح: يبقى مُبطَلاً ويُبنى `writeDurableTask` مواز جديد بمُطلِق مختلف | **يُحذف** بعد نزول `writeDurableTask` (T-820): كود ميت + فخّ تنفيذ-مزدوج في المسار الحرج. عبء الإبقاء على النظام |
| 3 | **workflow-reconcile** (Layer-1) | ADR-048؛ بطاقة اكتمال مشتقّة من journal بعد restart لحادثة `run.stopped` | `providers/list/claude/workflow-reconcile.service.ts` | 🟢 **نشط** — `WORKFLOW_RECONCILE=1`؛ بوابة `:382` في مسار getSessionMessages | كاشف اكتمال #1؛ B-103 يعيد استخدام `buildReconcileMessage` (نمط بطاقة non-LLM §د) و`DEFAULT_QUIET_MS` | **يبقى منفصلاً مؤقتاً** لكن **يُقصَر على حالة الورشة-inline (أداة Workflow) بعد restart حصراً**، مع خطة تقاعده حين تُهجَّر inline إلى DurableTask (T-825) |
| 4 | **workflow-liveness / workflow-status** (Layer-A، T-242) | ADR-051/ADR-053؛ رؤية اليتيم B-103 من pid الابن (لا mtime) | `services/workflow-liveness.js` + `providers/services/workflow-status.service.ts` + `session-process-monitor.js:152` | 🟢 **نشط بلا علم** — pid-based، مربوط عبر session-process-monitor (مستقل عن WORKFLOW_SUPERVISOR) | كاشف اكتمال/رؤية #2؛ التصميم يعيد استخدامه كطبقة رؤية | **يبقى (مُعاد استخدام)** كطبقة رؤية؛ لكن يُدمَج تحت سلطة اكتمال واحدة مع #3 و DurableTask (T-825) بدل ثلاثة كاشفات |
| 5 | **inline workflows (ultracode)** | B-86؛ تمرير `CLAUDE_CODE_WORKFLOWS=1` للـCLI | `claude-sdk.js:1405-1413` | 🟢 **نشط** — `ENABLE_ULTRACODE_WORKFLOWS=true` | **هذا هو «التنفيذ الخلفي» الفعلي اليوم** — لكنه **inline في عملية المنسّق** ⇒ يموت بموتها (سبب B-103 كله) | **قرار مالك:** بعد إثبات B-103، **إهمال الورشات inline الخلفية** لصالح DurableTask (تبقى للاستخدام المتزامن داخل الدور فقط). أكبر مصدر ازدواج مستقبلي (T-828) |
| 6 | **B-N-DRAIN** (بقاء الأبناء عبر restart) | ADR-021/022/028؛ B-95/B-130 | `ecosystem.alkindy.config.cjs` (treekill/kill_timeout/max_memory) + `services/shutdown-drain.service.js` + `listen-with-guard.service.js` | 🟢 **نشط** — treekill:false + kill_timeout 24h + DRAIN_TIMEOUT_MS=0 (مؤكَّد PM2 حيّ) | **خاصية بنية تحتية لا نظام** — مهام B-103 أحفاد systemd، مستقلة عن عدّ الدرين بالتصميم | **يبقى منفصلاً** (بنية تحتية للمنصّة كلها). B-103 يوسّع `safe-restart` برؤية قراءة-فقط لـ`wf-*.service` (المرحلة 5، موجود بالخطة) |
| 7 | **session survival/replay — claude** | ADR-041/B-80 (RingBuffer، live replay) | `session-registry.js` + `claude-sdk.js:67` (registry) + `chat-websocket` attach | 🟢 **نشط** — `SESSION_REGISTRY_claude=1` | **مجال مجاور لا متداخل** — مرايا جلسة تفاعلية حيّة (مشاهدون/refresh)، لا ديمومة مهمة خلفية | **يبقى منفصلاً** (غرض وظيفي مختلف: بثّ تفاعلي لا تنفيذ خلفي) |
| 8 | **session survival — agy (Phase 0)** | ADR-021 Phase-0 (بوابة `SESSION_REGISTRY_agy`) | `agy-cli.js:49` + `session-registry.js` | 🟡 **خامد** — `SESSION_REGISTRY_agy` OFF؛ agy نفسه مُخفَّض الأولوية (upstream sync) | لا تداخل مباشر مع DurableTask | **يُحسَم: تفعيل-أو-حذف** (T-826). عبء الإثبات على البقاء؛ agy مُعطَّل مؤقتاً أصلاً |
| 9 | **ghost-session detach** | ADR-042/B-80c؛ فصل جلسة شبح عن عدّ الدرين | `claude-sdk.js:214` (ghostSweepTimer) + `ghostDetachEnabled()` | 🟡 **خامد** — `CLAUDE_GHOST_DETACH` OFF (لم يُفعَّل قط) | لا تداخل — B-103 يجعل المهام درين-مستقلة بنيوياً فيغني عن هذا للمهام | **يُحسَم: تفعيل-أو-حذف** (T-826). خامد منذ إنشائه بلا نفع مُثبَت |
| 10 | **runner «المِنوال»** (المحرّك المستقل) | ADR-RUNNER-*؛ آلة build/verify ذاتية تحت systemd+cron | `nassaj-ops/scripts/runner/` (مستودع منفصل) + جسر `server/modules/runner/` | 🔵 **خارج nassaj-dev** — يستهدف Diwan (enabled) + AlNuman (disabled)؛ **nassaj-dev غير مُسجَّل ⇒ registered:false**؛ cron `*/10` حيّ لكن **لا `RUNNER_ARMED` ⇒ خامل** | **تشابه ميكانيكي قويّ** (systemd + `claude -p` + عقد ملفات + flock + عزل CLAUDE_CONFIG_DIR) لكن **غرض مختلف** (حلقة ذاتية لمشاريع أخرى، تسليم بملفات لا تسليم-للمنسّق) | **يبقى منفصلاً** (خارج المشروع والغرض). لكن **قرار معماري (T-827):** توحيد بدائية إطلاق systemd بين المحرّكين بدل تطبيقَين. **الجسر/الشارة (runner-watcher) يُعاد استخدام نمطه في B-103 — يبقى** |
| 11 | **agent.js headless** (`POST /api/agent`) | API خارجي upstream (claude/cursor/codex/gemini/opencode + فرع/PR) | `server/routes/agent.js` | 🟢 نشط لكن **متزامن مربوط-بالطلب** — `await queryClaudeSDK` inline؛ يموت بقطع الاتصال/العملية؛ **زر الواجهة أُزيل** (dca47951)، لا مكوّن AgentsPanel باقٍ | **نقيض الديمومة** — B-103 يعيد استخدام صنفَي الكاتب (`SSEStreamWriter`/`ResponseCollector`) فقط كنمط للحاقن | **يبقى منفصلاً** (سطح API خارجي، لا يضيف نظام ديمومة). لا حذف مطلوب؛ ليس منافساً |
| — | TaskMaster | تكامل claude-task-master (كشف `.taskmaster`، PRD، مهام) | `routes/taskmaster.js` + `utils/taskmaster-websocket.js` + `projects-has-taskmaster.service.ts` | ⬜ **خارج العائلة** — إدارة مهام مشروع، لا تنفيذ خلفي؛ UI خلف علم | لا تداخل | **خارج نطاق B-103** — لا يُلمَس هنا |
| — | project-reconcile | B-38/B-150؛ أرشفة صفوف مشاريع مفقودة القرص (6h) | `modules/database/project-reconcile.service.ts` | ⬜ **خارج العائلة** — صيانة صفوف DB، «reconcile» بالاسم فقط | لا تداخل | **خارج نطاق B-103** |

---

## 4. خريطة «قبل / بعد»

### كم نظام تنفيذ-خلفي/ديمومة لدينا **اليوم** (عائلة B-103 لعمل نسّاج ذاته)؟

| الطبقة | الأنظمة | الحالة |
|---|---|---|
| **مُنفِّذ فعلي** | inline workflows (#5) | 🟢 نشط لكن **هشّ** (inline، يموت بموت المنسّق) — هو علّة B-103 |
| **كواشف اكتمال/رؤية** | reconcile (#3) + liveness/status (#4) + scope-liveness الخامد (ضمن #1) | 🟢🟢🟡 — **ثلاث آليات** لسؤال واحد |
| **محرّك دائم** | workflow-supervisor (#1) | 🟡 خامد (مبني، جاهز) |
| **كود ميت في المسار** | Layer-2 launch-intent (#2) | ⚫ ميت لكن حاضر |
| **بنية بقاء** | B-N-DRAIN (#6) | 🟢 نشط (بنية تحتية) |
| **مجاور** | session-replay claude (#7) | 🟢 نشط (بثّ تفاعلي) |
| **خامد بلا نفع** | agy-registry (#8) + ghost-detach (#9) | 🟡🟡 |
| **خارج المشروع** | المِنوال (#10) | 🔵 يستهدف Diwan، nassaj-dev غير مسجَّل |

**العدّ الصريح:** مُنفِّذ واحد هشّ + **3 كواشف اكتمال** + محرّك دائم خامد + جسر ميت + عَلَمان خامدان = **بنية متكرّرة الوظيفة**.

### بعد B-103 **مع التنظيف المقترح**

| الطبقة | الأنظمة | التحوّل |
|---|---|---|
| **مُنفِّذ دائم واحد** | DurableTask = workflow-supervisor مُفعَّل (#1) | خامد → نشط (**لا +1**) |
| **سلطة اكتمال واحدة** | DurableTask monitor **سلطة** الاكتمال للمهام الصريحة؛ reconcile (#3) يُقصَر على inline-Workflow-tool؛ liveness (#4) مُعاد استخدامه كرؤية تحتها | 3 كواشف → 1 سلطة + 1 إرث مؤقت |
| **كود ميت** | Layer-2 (#2) **محذوف** | ⚫ → 🗑️ |
| **خامد** | agy-registry (#8) + ghost-detach (#9) **محسوم (تفعيل/حذف)** | 🟡 → قرار |
| **inline** | مُهمَل خلفياً لصالح DurableTask (#5) | 🟢 هشّ → متزامن-فقط |
| بلا تغيير | drain (#6)، replay (#7)، المِنوال (#10)، agent.js (#11) | كما هي |

**النتيجة:** عدد **محرّكات التنفيذ الخلفي** يبقى ثابتاً (1، خامد→نشط)؛ عدد **كواشف الاكتمال المتوازية** ينخفض من 3 نحو 1 سلطة؛ ويُحذف كود ميت وعَلَمان. **صافي التغيير = أقل قطعاً متحرّكة، لا أكثر** — يوافق مطلب المالك.

---

## 5. الأثر الملموس على خطة B-103

**لا مرحلة جديدة للمحرّك** (الهيكل موجود؛ المراحل T-819..T-823 كما هي). التداخل يُعالَج بمهام **دمج/حذف** تُضاف، بترقيم مقترح T-824 صعوداً (المنسّق يثبّته):

| المهمة | النوع | الوصف | الاعتماد | المرحلة |
|---|---|---|---|---|
| **T-824** | حذف (bug/debt) | حذف مسار Layer-2 الميت (`launch-intent.ts` + نقطة `claude-sdk.js:1867-1902` + الحارس `inlineWorkflowsActive`) بعد نزول `writeDurableTask`. لا يبقى كاتبا نيّة متوازيان في المسار الحرج | بعد T-820 | ضمن/بعد T-820 |
| **T-825** | دمج | تعريف **سلطة اكتمال واحدة**: DurableTask monitor سلطةُ المهام الصريحة؛ قصر `workflow-reconcile` على حالة inline-Workflow-tool بعد restart حصراً؛ توثيق `workflow-liveness/status` كطبقة رؤية تحتها؛ خطة تقاعد reconcile+liveness حين تُهجَّر inline | بعد T-821 | المرحلة 3+ |
| **T-826** | حذف/قرار | حسم `SESSION_REGISTRY_agy` و`CLAUDE_GHOST_DETACH`: تفعيل بمبرر وظيفي، أو حذف الكود والأعلام والاختبارات الخامدة | مستقل | أي وقت |
| **T-827** | قرار معماري (ADR) | توحيد بدائية إطلاق systemd بين `workflow-supervisor/systemd.ts` وسكوبات المِنوال (`minwal-*.scope`) — أو قبول تطبيقَين صراحةً بمبرر | بعد T-821 | تصميم |
| **T-828** | قرار مالك | إهمال الورشات inline الخلفية (`ENABLE_ULTRACODE_WORKFLOWS` للخلفية) لصالح DurableTask بعد إثبات B-103؛ إبقاء المتزامن داخل الدور | بعد T-823 (soak) | بعد التفعيل |

**تعديل صياغي مقترح على وثيقة التصميم** (لا يغيّر البنية): إضافة سطر في §ب-1 يربط `workflow-reconcile`/`workflow-liveness` بخطة التقاعد (T-825) صراحةً، كي لا يُقرأ إعادة-الاستخدام على أنه إبقاء دائم لثلاثة كواشف.

---

## 6. قرارات للمالك (مرقّمة)

1. **(حاجز اعتماد B-103) تنظيف مرافق للتفعيل — نعم/لا:** هل تعتمد أن تفعيل B-103 يُرافقه T-824 (حذف Layer-2 الميت) و T-825 (سلطة اكتمال واحدة) **ضمن نفس السلسلة**، لا كتحسين مؤجَّل؟ (توصية architect: نعم — بدونه نصل لأربعة كواشف اكتمال.)
2. **مصير inline workflows (T-828):** بعد إثبات B-103، هل نُهمل الورشات الخلفية inline لصالح DurableTask (تبقى للاستخدام المتزامن)؟ أم نُبقي المسارين متوازيين؟ (توصية: إهمال — هو أكبر ازدواج مستقبلي، وهشاشته سبب B-103.)
3. **الأعلام الخامدة (T-826):** `SESSION_REGISTRY_agy` و`CLAUDE_GHOST_DETACH` — تفعيل بمبرر أم حذف؟ (توصية: حذف ما لم يُوجد مبرر وظيفي قريب؛ عبء الإثبات على البقاء.)
4. **توحيد بدائية systemd (T-827):** هل نستثمر في بدائية إطلاق systemd مشتركة بين B-103 والمِنوال، أم نقبل تطبيقَين منفصلين (مستودعان مختلفان)؟ (توصية: قرار ADR منفصل، أولوية متوسطة — ليس حاجزاً لـ B-103.)
5. **المِنوال والرؤية:** مؤكَّد أن المِنوال **خارج** نطاق B-103 (يستهدف Diwan، nassaj-dev غير مسجَّل، خامل بلا RUNNER_ARMED). هل تريد أيضاً مراجعة إبقائه مُسلَّحاً على cron `*/10` (حاليّاً no-op بلا arming)، أم تركه؟ (خارج نطاق B-103 لكنه سطح تشغيل حيّ.)

---

## 7. ملحق التحقق — كل ادّعاء حالة مع سنده

> يُدقَّق ادّعاءً-ادّعاءً. `/proc` = `/proc/3582900/environ` (عملية nassaj-dev الحيّة). PM2 = `pm2 jlist`.

**الأعلام:**
- WORKFLOW_SUPERVISOR = OFF: غائب عن `/proc`, `.env`, `ecosystem.alkindy.config.cjs`. البوابة: `workflow-supervisor/config.ts:35-38` (`isSupervisorEnabled`)؛ no-op الإقلاع: `supervisor.ts:148-151`؛ الخادم لا يستورد runSupervisor (entrypoint isMain فقط: `supervisor.ts:163-167`).
- WORKFLOW_RECONCILE = ON(`1`): `/proc` (حاضر) + `ecosystem.alkindy.config.cjs:150`. البوابة: `workflow-reconcile.service.ts:80` (`workflowReconcileEnabled`) + `:382`.
- SESSION_REGISTRY_claude = ON(`1`): `/proc` (حاضر) + `.env:39` + `ecosystem:135`. الاستهلاك: `claude-sdk.js:67`.
- SESSION_REGISTRY_agy = OFF: غائب عن `/proc` والكل. التعريف: `agy-cli.js:49`.
- ENABLE_ULTRACODE_WORKFLOWS = ON(`true`): `.env:32`؛ التحميل: `load-env.js:14-24` (يقرأ `<APP_ROOT>/.env`، أسبقية `!process.env[key]`)؛ الاستهلاك: `claude-sdk.js:1405-1413` (⇒ `CLAUDE_CODE_WORKFLOWS=1`). **قيد:** غائب عن `/proc` (dotenv وقت-تشغيل لا وقت-exec) — ليس دليل OFF.
- CLAUDE_GHOST_DETACH = OFF: معلّق `.env.example:133-150`، غائب عن `/proc`. الاستهلاك: `index.js:32` (`ghostDetachEnabled`)، sweep: `claude-sdk.js:214`.
- DRAIN_TIMEOUT_MS = `0`: `/proc` + `ecosystem:168`.

**PM2/الدرين (قيم حيّة من pm2 jlist):**
- treekill = false: `ecosystem:98` + مؤكَّد حيّ.
- kill_timeout = 86400000: `ecosystem:118` + مؤكَّد حيّ (**نقض ذاكرة «300000»**).
- max_memory_restart = undefined: `ecosystem:81-90` + مؤكَّد حيّ.

**الأنظمة:**
- workflow-supervisor خامد: `config.ts:35`, `supervisor.ts:147-159`؛ launchScope: `systemd.ts:158,173-206` (systemd-run --unit عابر)؛ GATE2: `ownership-guard.ts`؛ concurrency: `config.ts:46-49`.
- Layer-2 ميت: `launch-intent.ts:20-31` (رأس «DECOMMISSIONED») + `:90-101` (حارسا OFF + inlineWorkflowsActive)؛ نقطة الحقن: `claude-sdk.js:1867-1902`.
- reconcile نشط: `workflow-reconcile.service.ts:1-59` (رأس ADR-048) + `:73` (`DEFAULT_QUIET_MS` مُصدَّر يشاركه liveness) + `:382`.
- liveness/status نشط بلا علم: `services/workflow-liveness.js:166,233,287` (pid + classify)؛ ربط: `session-process-monitor.js:52,152` (registerWorkflowPid) + `:174` (poll)؛ السطح: `workflow-status.service.ts:1-43,58` (يستورد classify + readJournalKeySets؛ scope-resolver اختياري null عند OFF: `:59-68`).
- inline نشط: `claude-sdk.js:1405-1413`.
- B-N-DRAIN نشط: `ecosystem.alkindy.config.cjs:76-168` + `services/shutdown-drain.service.js` (مستورَد `index.js:18`) + `listen-with-guard.service.js` (`index.js:19`).
- replay claude نشط: `session-registry.js:4` + `claude-sdk.js:58,67,848,1902,1934`.
- المِنوال خارج المشروع/خامل: registry `nassaj-ops/scripts/runner/projects/registry.json` (diwan enabled / alnuman disabled؛ لا nassaj-dev)؛ dirs: `diwan.json→/home/nassaj/Project/Diwan`, `alnuman.json→/home/nassaj/Project/AlNuman/...`؛ **صفر ملف `RUNNER_ARMED`** (find على `state/`)؛ cron `*/10 * * * * minwal-supervisor.sh` حيّ (crontab nassaj)؛ الجسر: `runner-bridge.service.ts:339-407` (`readRunnerStatus`، registered:false للمشروع غير المسجَّل)؛ الشارة: `runner-watcher.service.ts` (`ensureRunnerWatcher`, index.ts:7).
- agent.js متزامن: `routes/agent.js:844-1026` (`await queryClaudeSDK/queryCodex/...` inline داخل الطلب)؛ لا مكوّن AgentsPanel في `src/` (grep صفر)؛ الأصناف المُعاد استخدامها: `agent.js:454` (SSEStreamWriter), `:491` (ResponseCollector).
- app_config بلا أعلام: مفاتيح فعلية = branding.* + jwt_secret + provider_sharing فقط (SELECT read-only على `~/.local/share/nassaj-dev/db.sqlite`).
- خارج العائلة: TaskMaster `routes/taskmaster.js:1-18`؛ project-reconcile `modules/database/project-reconcile.service.ts:1-29` + ربط `init-db.ts:29` (6h).

**قيود التدقيق:** قراءة-فقط في كل مكان؛ الكتابة في هذا الملف حصراً؛ المصادر من `server/` و`src/` (لا `dist-server*`/`.claude/worktrees`/`*.bak`). `cli.js:451,532 detached:true` = أداة `cloudcli sandbox` المستقلّة (VMs)، خارج runtime الخادم وخارج العائلة.
