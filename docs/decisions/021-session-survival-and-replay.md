# ADR-021 — Session Survival & Replay (non-claude)

> **سجلّ قرار معماري (ADR).** الصيغة: Context → Decision → Consequences → Status.
> الكود في `/home/nassaj/Project/nassaj-dev`. مبادرة فرعية في مشروع `nassaj-dev`.

| الحقل | القيمة |
|---|---|
| **Status** | ✅ **Accepted** — بوابة تصميم مكتملة، اعتماد المستخدم **2026-06-06**. شريحة الترميز + التحصينات مكتملة؛ **فيتو qa-critic مرفوع 2026-06-06** (202/0)؛ **التفعيل الإنتاجي محجوب فقط بـB-N-DRAIN**. |
| **التاريخ** | 2026-06-06 |
| **المالك** | i.rukhaimi |
| **يحلّ محلّ** | فكرة «فصل خدمة الجلسات لعملية worker مستقلة» (أُسقطت — انظر Context). |
| **مرتبط بـ** | ADR-022 (process supervisor: PM2 + SIGTERM drain) · `docs/workitems/PHASE-SR-0.md` |

---

## Context (السياق)

عملية Node واحدة (`pm2 nassaj-dev`) تجمع دورين: خادم HTTP+WebSocket، وأبٌ لكل جلسات الـ CLI. ينتج عن ذلك مشكلتان:

1. **النشر يقتل الجلسات النشطة:** `pm2 restart` يُنهي العملية الأب فتموت معها كل جلسات الـ CLI الجارية.
2. **بثّ الحالة pull لا push:** الواجهة تحتاج تحديثاً يدوياً لرؤية حالة الجلسة الحيّة.

**فكرة الفصل سقطت بفيتو qa-critic** بحقيقتين كوديّتين مؤكَّدتين:

- جلسات **claude/codex** تعيش **داخل عملية Node عبر SDK** (`@anthropic-ai/claude-agent-sdk`، `@openai/codex-sdk`). الـ SDK يملك العملية الابن داخلياً، والـ stdio مُمرَّر (piped) بلا `detached`، **والكود لا يملك PID الابن**. → فصلهما لعملية مستقلة **مستحيل**.
- **SDK resume = تاريخ مُثبَّت (turns مكتملة) فقط**، لا API لإعادة الالتصاق (attach) بـ turn حيّ سقط. → «بقاء حيّ مستحيل لهذين المزوّدين، استرداد رشيق فقط».

**حقيقة معمارية حاسمة تُبرِّر المسار الأخضر لـ agy وحده:**

- `agy` يُشغَّل بـ `spawn()` **مباشر**، والكود يملك المقبض (`agProcess`) في `server/agy-cli.js:400-416`:
  ```js
  let agProcess;
  agProcess = spawn(AGY_PATH, args, {
      cwd: cleanCwd,
      env: resolveProviderEnv(userId, 'agy', process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
  });
  ```
  خلافاً لـ claude/codex المملوكين داخل SDK. لهذا حصل **agy وحده** على المسار الأخضر في Phase SR-0.

**مسار البوابة:** product-strategist + architect → تصميم worker/socket-proxy → **فيتو qa-critic** (SDK يملك الأبناء) → architect أعاد التأطير → **مراجعة qa-critic ثانية** برفع الفيتو مشروطاً على المزوّدين غير-claude.

---

## Decision (القرار)

بدل الفصل عبر عملية مستقلة → **مقاربة من شقّين:**

1. **Graceful drain** للنشر المُخطَّط (لا فصل).
2. **Replay buffer** للاسترداد (per-session RingBuffer + replay تفاضلي).

**يُعتمد Phase SR-0 للمزوّدين غير-claude فقط** — **agy رائداً ثم codex** — بشروط البوابة:

- **B-N5** (connectionId مؤقت ثم rekey لـ sessionId)
- **B-N7** (توحيد مصدر حالة active)
- **attach للقراءة فقط دون swap الـ writer** (احترام قيد `if(!isActive)`)
- **بوابة اختبارات** قبل الدمج.

المنطق الجديد كله **خلف علم `SESSION_REGISTRY_<P>`** لكل مزوّد، بتعايش قديم/جديد.

### ثلاثة تصحيحات من المراجعة (مُثبَّتة صراحةً)

1. **نقطة حقن RingBuffer** = عند بثّ agy الحيّ `safeSend({ kind: 'stream_delta', ... })` في **`server/agy-cli.js:461`** — **لا** عند `AntigravitySessionsProvider.normalizeMessage` الذي **يُرجع `[]` في `antigravity-sessions.provider.ts:249-251`** (طبقة ميتة؛ التاريخ يُحمَّل من قرص transcript فقط، والـ live normalizer لا يُنتج رسائل).

2. **منصّة النشر (B-N2):** البقاء على **PM2** + drain مُحفَّز بـ **SIGTERM فقط** + `kill_timeout`؛ **لا ترحيل إلى systemd الآن**. السبب: `exec_mode:'fork'` يستخدم SIGTERM القياسي = يطابق systemd → إعادة العمل المستقبلية شبه صفر. (مُدوَّن منفصلاً في **ADR-022**: «process supervisor: PM2 + SIGTERM drain».)

3. **بوابة نشر:** أول `pm2 restart` يحمل الـ slice **سيقتل جلسات agy النشطة** — المعالج الحالي في **`server/index.js:1789-1794`** يفعل `process.exit(0)` فوراً بلا drain:
   ```js
   const shutdownPlugins = async () => {
     await stopAllPlugins();
     process.exit(0);            // ← خروج فوري بلا drain
   };
   process.on('SIGTERM', () => void shutdownPlugins());
   process.on('SIGINT',  () => void shutdownPlugins());
   ```
   قبل أول نشر يلزم **الحدّ الأدنى من B-N2** (drain موقوت + `kill_timeout`) **أو** نشر يدوي في نافذة بلا جلسات نشطة ومن instance منفصل.

---

## Consequences (التبعات)

**مقبولة:**

- **PM2 يقتل OOM قتلاً صلباً بلا تدرّج** (لا مكافئ `MemoryHigh` كما في systemd). مقبول لأن OOM استثناء يغطّيه الـ replay، وليس مسار النشر المُخطَّط.
- **systemd يبقى خياراً مستقبلياً منخفض الكلفة** (إعداد فقط، بلا إعادة عمل كود — لأن SIGTERM متطابق).
- التعايش خلف flag لكل مزوّد يضاعف مسارات الاختبار مؤقتاً حتى إزالة العلم.

**خارج النطاق (فيتو qa-critic باقٍ):**

- **مسار claude بالكامل:**
  - **B-N1** — رفع `if(!isActive)` غير مُثبَت، **قد يُعيد regression `56d67f3`** (تبديل الـ writer وسط query يفسد تزامن SDK).
  - **B-N6** — تمرير المسار الحرج للموافقات/complete خلف flag واحد غير مقبول.
- **drain-lock الكامل B-N3/B-N4** (drain لا يكتمل مع أدوات `timeoutMs:0` وjobs الساعات؛ سباق drained↔restart اليدوي) — نصف مُؤجَّل؛ يُكتفى بالحدّ الأدنى من B-N2 كبوابة نشر.

---

## Alternatives المرفوضة

| البديل | سبب الرفض |
|---|---|
| **فصل الجلسات لعملية worker مستقلة + socket-proxy** | مستحيل تقنياً لـ claude/codex: الـ SDK يملك العملية الابن، الكود لا يملك PID، ولا API لـ attach حيّ. |
| **حقن RingBuffer عند `normalizeMessage`** | طبقة ميتة تُرجع `[]`؛ لا تمرّ بها الرسائل الحيّة. |
| **ترحيل فوري إلى systemd لأجل drain متدرّج** | إعادة عمل غير ضرورية: SIGTERM متطابق مع PM2 `fork`؛ مكسب MemoryHigh لا يبرّر الكلفة الآن. |
| **رفع `if(!isActive)` لتفعيل swap الـ writer لـ claude** | يُعيد regression موثَّق (`56d67f3`)؛ خارج النطاق ببقاء الفيتو. |

---

## Amendment — تحصينات ما بعد المراجعة (2026-06-06)

> جولة نقد مُلزِمة (**architect + qa-critic**، 2026-06-06) عالجت ملاحظات Phase SR-0. هذه التحصينات **مُثبَّتة كقرار**، والعلم يبقى **مُطفأً** والتفعيل الإنتاجي **محجوب بفيتو qa-critic** حتى إعادة المراجعة.

### 1. دورة حياة الـ RingBuffer (مُعرَّفة صراحةً)

| المعامل | القيمة | السلوك |
|---|---|---|
| `BUFFER_RETENTION_MS` | `120000` | **drop مؤجَّل** عند `close`/`error` عبر `setTimeout(...).unref()` — **لا** drop فوري؛ نافذة سماح لإعادة الاتصال قبل التحرير. |
| `MAX_LIVE_SESSIONS` | `200` | سقف الإدخالات الحيّة بطرد **LRU للإدخالات غير النشطة فقط** — **لا طرد لجلسة نشطة** مهما بلغ الضغط. |
| `RING_CAPACITY` | `2000` | سعة الرسائل لكل جلسة (كما هو، بلا تغيير). |

- `.unref()` إلزامي على مؤقّت الـ drop كي لا يُبقي مؤقّتُ التحرير العمليةَ حيّة ويعيق الخروج/الـ drain.

### 2. RESUME — البفر لا يَعبُر حدود تشغيل جديد (clean-buffer)

- **spawn لـ `sessionId` منتهٍ** يفعل **`drop` ثم `open`** → بفر **نظيف** للتشغيل الجديد. البفر لا يَعبُر حدّ تشغيل إلى آخر؛ يُحسَم بذلك سؤال B-N-RESUME لصالح **مسح البفر عند بدء تشغيل جديد** (لا توثيق replay كامل).
- **عقد `lastSeq`:** غياب القيمة أو قيمة **غير رقمية → `0`** = إعادة بثّ **التشغيل الحالي فقط** (محدود ببفر التشغيل الجاري، **لا ترانسكربت تشغيل سابق**). انتفت بذلك حالة «`lastSeq=0` يستلم كامل ترانسكربت التشغيل السابق».

### 3. B-N7 — مصدر وحيد فعلي (إسقاط الـ fallback)

- عند **تفعيل العلم** يُسقَط fallback `|| activeSessions.has()` في `isAntigravitySessionActive` → مصدر الحقيقة الوحيد يُحقَّق حرفياً.
- السلوك القديم (الـ fallback) يبقى **عند إطفاء العلم فقط** (تعايش قديم/جديد بلا regression).

### 4. حذف فرع rekey-onto-existing

- فرع **rekey إلى sessionId قائم** صار **كوداً ميتاً** بعد قرار RESUME clean-buffer (لا يلتقي تشغيلان على نفس البفر) → **يُحذف ويُستبدل بـ `throw` صريح** يكشف الحالة المستحيلة بدل دمج صامت لجلستين.

### 5. توقيت ProviderSessionPort — **مؤجَّل** (بوابة B-N-PORT)

- تجريد **نقطة الحقن** (stdout/PID لـ `agy` مقابل SDK لـ `codex`) في `ProviderSessionPort` **لا يُستخرَج قبل وجود codex** — تجريد مزوّد واحد سابق لأوانه. يصبح **بوابة `B-N-PORT`** شرطاً مسبقاً إلزامياً لأي عمل codex (انظر `PHASE-SR-0.md`).

### حالة الفيتو بعد التحصينات

- العلم `SESSION_REGISTRY_agy` **مُطفأ**.
- **التفعيل الإنتاجي محجوب بفيتو qa-critic** حتى إعادة المراجعة، حتى بعد تنفيذ التحصينات.
- **اختبار التكامل agy↔registry الحقيقي** = **شرط فيتو** لرفع ثقة البوابة (لا مجرّد تحسين).

> **تحديث الحالة — فيتو qa-critic مرفوع (2026-06-06):** بعد إعادة مراجعة qa-critic فوق commitَي التحصينات (`423f2b8` تحصينات backend-dev + `42d0b46` اختبار التكامل الحقيقي)، أُغلقت البنود الخمسة (دورة الحياة، RESUME clean-buffer، اختبار التكامل الحقيقي، B-N7، عدم الانحدار) — **202/0، الفيتو مرفوع**. **التفعيل الإنتاجي محجوب الآن فقط بـ B-N-DRAIN** (drain موقوت + `kill_timeout`)؛ بقية البوابات مغلقة. بندان [تحسين] غير حاجبين مرصودان في `PHASE-SR-0.md` (تسرّب مؤقّت drop ثانوي عند `_enforceCap`؛ فرع rekey المملوء ميت إنتاجياً — حارس دفاعي مقبول).
