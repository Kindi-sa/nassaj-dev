# تصميم سدرة الموحَّد — Sidra Unified Design

> **الحالة:** مُدخَل معماري لبوابة بدء المشروع (Proposed) — **ليس اعتماداً للتنفيذ.**
> **Status:** Architecture input for the project-start gate (Proposed) — **not an implementation approval.**
>
> دمج أبعاد التصميم الأربعة (التخزين/الأرشفة، الهيكلة/التصنيف، التكاملات، الوصول/الواجهة/النشر) في تصميم واحد متماسك، مع حسم التعارضات صراحةً.
>
> Merges the four design dimensions into one coherent design, resolving conflicts explicitly.
>
> **اللغة:** العربية أساسية، الإنجليزية مكمِّلة. **Language:** Arabic primary, English supplementary.
> **التاريخ:** 2026-06-22 · **المؤلف:** architect (بوابة بدء مشروع سدرة).

---

## 0. حسم التعارض الجوهري قبل أي شيء — The Foundational Conflict, Resolved First

الأبعاد الأربعة المُسلَّمة عاملت سدرة وكأنها **مخزن ملفات/كائنات جديد** (MinIO مقابل Seafile مقابل NextCloud). لكن **الواقع المرصود في المستودع `/home/nassaj/Project/sidra/` يقول غير ذلك:**

> **سدرة موجودة فعلاً، وهي قاعدة معرفة Git-native متعددة الشركات** (ADR-T2)، مصدر حقيقتها الوحيد Git، وفهارسها (BM25 + pgvector) **مشتقة قابلة للحذف**، وفيها schema إلزامي (`_schema/frontmatter.md`)، وCI كاسر (`_ci/validate.py`)، وثلاث شركات (`traventure`/`alkindy`/`holding`)، وفصل جمهور ثلاثي (`public`/`internal`/`sensitive`)، وrouter استرجاع fail-closed.

**القرار الحاكم (يلغي تأطير «MinIO مقابل Seafile كبديلين لسدرة»):**

سدرة = **طبقة معرفة (Knowledge) فوق طبقة تخزين (Storage)**. الطبقتان لا تتنافسان، بل تتراصّان:

| الطبقة | الدور | الأداة |
|:---|:---|:---|
| **L0 — المعرفة (موجودة)** | مصدر الحقيقة: Markdown + frontmatter في Git، فهارس مشتقة، router | **Git (Forgejo) + pgvector + خدمة استرجاع** |
| **L1 — الإدخال (Ingest)** | استقبال واتساب/ترافنشر/drop → اقتراح ملف → PR | **محوِّلات مصدر + طابور + فاتح PR** |
| **L2 — الملفات البشرية (Files)** | أصول `seafile_path`: عقود، تراخيص، مرفقات، مستندات | **Seafile CE** |
| **L3 — الكائنات/النسخ (Object/Backup)** | نسخ مشفّرة، أرشيف بارد، مرايا، WORM | **MinIO (S3)** |

**ما يتغيّر عن الأبعاد الأربعة:** Seafile وMinIO **ليسا «سدرة»** ولا بديلاً لها — هما طبقتا التخزين **تحت** قاعدة المعرفة Git القائمة. كل ما وُصف في الأبعاد عن MinIO/Seafile صحيح، لكنه يخدم L2/L3، بينما L0 (جوهر سدرة) موجود ومحسوم بـ ADR-T2.

---

## 1. حسم MinIO مقابل Seafile — المكدّس النهائي

الأبعاد الأربعة اتفقت ضمناً على الهجين واختلفت في التفاصيل. **الحسم النهائي:**

### القرار: أربع طبقات، أدوار غير متداخلة، لا منتج يلغي آخر

| السؤال | الحسم | المبرّر الحاسم |
|:---|:---|:---|
| MinIO أم Seafile؟ | **كلاهما، لطبقتين مختلفتين** | Seafile CE **لا يدعم S3 backend** (ميزة Pro حصراً)، فلا يكتب فوق MinIO؛ هما متجاوران لا متراكبان. |
| NextCloud؟ | **مرفوض نهائياً** | أثقل من MinIO+Seafile مجتمعَين على VM بـ16GB، وأداؤه يتدهور على الأرشيف الطويل. |
| backend تخزين Seafile؟ | **SQLite لا MariaDB** | احترام سقف 16GB؛ SQLite مدعوم رسمياً للنشر الصغير ويوفّر ~300MB. |
| وضع MinIO؟ | **single-node single-drive (SNSD)** | لا erasure coding على قرص واحد؛ بصمة ~150-250MB. |
| الأصول البشرية (PDF/عقود/صور)؟ | **Seafile (L2)** عبر `seafile_path` | يطابق عقد schema القائم (`seafile_path` إلزامي كاسر لـ contract/license). |
| النسخ والأرشيف الآلي؟ | **MinIO (S3)** | S3 هي اللغة المشتركة لأدوات backup (`mc`, `restic`). |

### مسألة الموارد (حاجز إلزامي على 16GB)

| المكوّن | RAM متوقَّع | ربط |
|:---|:---|:---|
| Git (Forgejo) | ~200-400MB | tailscale0 |
| MinIO (SNSD) | ~150-250MB | tailscale0:9000/9001 |
| Seafile CE + SQLite | ~300-500MB | 127.0.0.1:8000 خلف عكسي |
| PostgreSQL + pgvector (فهارس L0) | ~300-500MB | internal |
| خدمة الاسترجاع + router | ~150-300MB | tailscale0 |
| WAHA (إدخال واتساب) | ~400-700MB (Chromium) / ~150MB (NOWEB) | 127.0.0.1:3000 |
| فاتح PR / طابور إدخال | ~100MB | internal |
| reverse proxy (Caddy) | ~64MB | tailscale0:443 |
| **الإجمالي** | **~1.9-3.4GB** | يترك هامشاً على 16GB |

**حاجز:** إن ضاقت الموارد مع خدمات مجتنى الأخرى → (أ) WAHA بمحرك NOWEB بلا Chromium أولاً، (ب) ثم ترحيل MinIO لعقدة أسطول أخرى، (ج) آخر ملاذ: Seafile وحده + rclone لتوفير S3 محلياً. **لا نقلّص Git/pgvector/router — هي جوهر سدرة.**

---

## 2. خريطة البيانات — أين تذهب كل معلومة

قاعدة قرار صريحة (decision tree). أول شرط ينطبق يحسم الوجهة:

1. **سرّ/مفتاح/`.env`؟** → **لا يدخل سدرة إطلاقاً** (حاجز fail-closed؛ `.gitignore` + رفض الإدخال).
2. **كود مصدري حيّ؟** → GitHub + `~/Project`، ليس سدرة.
3. **حالة/لوحة مشروع حية (`project-state.json`)؟** → الريبو، ليس سدرة.
4. **معرفة منظَّمة قابلة للقراءة كصفحة (تجربة/سياسة/FAQ/SOP/runbook)؟** → **L0 Git** كـ Markdown بـ frontmatter في مجلد الشركة الصحيح.
5. **عقد/ترخيص/مستند أصلي (PDF/مرفق ثقيل)؟** → **L2 Seafile**؛ والميتاداتا في L0 بحقل `seafile_path`.
6. **نسخة احتياطية/أرشيف بارد لا يُقرأ يدوياً؟** → **L3 MinIO** (مشفّر، WORM).
7. **وارد من واتساب/الويب/ترافنشر لم يُهضَم؟** → **L1 Ingest** → طابور → اقتراح PR إلى L0/L2.
8. **بيانات ترافنشر فيها PII (حجوزات/عملاء)؟** → بعد فلتر `03-Data-Retention-Deletion-Policy-AR.md` فقط، ثم `audience: sensitive` أو `internal`.
9. **مخرج وكيل اعتمده المالك؟** → L0 (`audience: internal`) إن كان معرفة، أو L3 إن كان أرشيفاً ثقيلاً.

### جدول الوجهات الموحَّد

| نوع المعلومة | الطبقة | الوجهة الدقيقة | `audience` افتراضي |
|:---|:---|:---|:---|
| تجارب/وجهات/FAQ ترافنشر | L0 Git | `traventure/{experiences,destinations,faq}/` | public (بعد مراجعة) |
| سياسات/SOP ترافنشر | L0 Git | `traventure/{policies,sops}/` | internal |
| منتجات/runbooks الكِندي | L0 Git | `alkindy/{products,runbooks}/` | internal |
| سجل المؤسسة (شركات/فريق) | L0 Git | `holding/{companies,team}/` | internal (لا public أبداً) |
| ميتاداتا عقود/تراخيص | L0 Git | `holding/{contracts,licenses}/` (+`seafile_path`) | internal/sensitive |
| **أصل** العقد/الترخيص (PDF) | **L2 Seafile** | مكتبة `holding-contracts` (مشفّرة طرفياً) | — |
| مستندات/أصول/صور بشرية | L2 Seafile | مكتبات حسب الشركة | — |
| رسائل واتساب (نص) | L1→L0/L3 | اقتراح PR؛ الأرشيف الخام → MinIO `whatsapp/` | internal/sensitive |
| مرفقات واتساب (صور/صوت) | L2 Seafile | مكتبة `inbox-media` + `seafile_path` | — |
| محتوى ترافنشر المُصدَّر | L1→L0 | اقتراح PR إلى `traventure/` | internal→public بمراجعة |
| نسخ DB احتياطية (الأسطول) | L3 MinIO | `sidra/<server>-backups/` (مشفّرة GPG) | — |
| نسخ vault SilverBullet | L3 MinIO | `sidra/silverbullet-mirror/` | — |
| أرشيف معرفي بارد/logs | L3 MinIO | `sidra/archive/` (WORM + lifecycle) | — |

---

## 3. التصنيف (Taxonomy) — موحَّد فوق schema القائم

**لا نخترع taxonomy جديداً — نبني على المُعتمد في `_schema/frontmatter.md`:** التصنيف الأساسي ثلاثي الأبعاد قائم بالفعل: `company` × `audience` × `type`. هذا هو المرجع الكاسر، لا بديل له.

### الأبعاد الثلاثة (من schema القائم)

- **`company`** (إلزامي، يطابق المجلد): `traventure | alkindy | holding`.
- **`audience`** (إلزامي، يحدد الفهرس): `public | internal | sensitive`.
- **`type`** (معدود، يطابق المجلد عبر R6): `experience, destination, policy, faq, sop, partner, product, runbook, company, team, contract, license, changelog`.

### امتداد التصنيف لطبقات L1/L2/L3 (جديد — يُضاف بلا كسر schema القائم)

التصنيف عبر L0 محسوم. أما L1/L2/L3 فيُصنَّفان بـ **sidecar metadata موحّد** متوافق مع schema سدرة (لا يحلّ محله):

```json
{
  "id": "sdr-<uuid>",
  "company": "traventure|alkindy|holding",
  "audience": "public|internal|sensitive",
  "source": "whatsapp|web|salla|manual|agent|backup-job",
  "sensitivity": "public|internal|confidential|pii",
  "retention": "permanent|7y|1y|90d|transient",
  "seafile_path": "...",
  "origin_host": "nassaj|mina|rukhaimi|traventure|mujtana",
  "checksum_sha256": "...",
  "ingested_at": "ISO8601"
}
```

- في **L2 Seafile**: `.meta.json` مجاور للأصل.
- في **L3 MinIO**: S3 object tags/metadata.
- `audience` و`retention` **إلزاميان** — لا يُؤرشف عنصر بدونهما (يفرضه فاتح PR / scribe-filter).
- عنصر `pii` يُطبَّق عليه تلقائياً أقصر retention مطابق للسياسة القانونية، ولا يصل `audience: public` أبداً.

### المبدأ الناظم (من ADR-T2)

> **الجمهور على مستوى الملف لا أقسامه.** محتوى بجمهور مختلف = ملف منفصل. هذا يسري على كل الطبقات: لا خلط `internal` و`public` في عنصر واحد.

---

## 4. خطة التكاملات — واتساب + ترافنشر

### 4.0 المبدأ الناظم (لا يُكسر)

> **لا تكامل يكتب في Git المعتمد مباشرة.** كل مصدر خارجي يُنتج اقتراح ملف Markdown بـ frontmatter كامل ويُقدِّمه عبر **Pull Request** على فرع `ingest/<source>/<id>`. الفاحص الكاسر `_ci/validate.py` يعمل على الـ PR، والمراجعة البشرية إلزامية لأي `public`. سطح الكتابة الآلي الوحيد = فتح PR.

### 4.1 خط الإدخال العام (Ingestion Pipeline)

```
[Source Adapter] → [Normalize] → [Classify+Draft] → [Stage:PR] → [Human Review] → [Merge→CI→Reindex]
   منطقة ثقة منخفضة    مغلّف موحّد    اقتراح frontmatter   فرع ingest/    بوابة بشرية    مصدر الحقيقة
```

| المرحلة | المسؤولية | الحاجز |
|:---|:---|:---|
| 1. Adapter | استقبال + تحقق توقيع/مصدر + حفظ الخام والوسائط | DMZ منطقية؛ الإدخال **غير موثوق**؛ المرفقات → Seafile فوراً لا Git |
| 2. Normalize | توحيد إلى `IngestEnvelope` (نص، مراجع وسائط، مُرسِل، ts، مصدر) | تجريد المصدر |
| 3. Classify+Draft | اقتراح `company`/`audience`/`type`/`program`/`lang` + frontmatter | **fail-closed: `audience: internal` افتراضاً، لا `public` آلياً أبداً** |
| 4. Stage (PR) | كتابة الملف على فرع `ingest/<source>/<id>` + فتح PR | لا كتابة على الفرع المعتمد؛ `validate.py` يكسر المخالف |
| 5. Review→Merge | مراجِع بشري يصحّح/يقرّ/يرفض/يرقّي `public` يدوياً | الدمج وحده يُطلق إعادة فهرسة الزوج `(company, audience)` |

**نقطة التوسعة:** أي مصدر مستقبلي = محوِّل واحد يملأ `IngestEnvelope` + قواعد تصنيف افتراضية + سرّ مصادقة. المراحل 2-5 مشتركة.

**التصنيف الآلي (مرحلة 3):** يجوز استخدام LLM للاقتراح **عبر اشتراك المالك الداخلي/API متوافق ToS** فقط (قيد ملزم: لا أتمتة على اشتراك شخصي لطرف ثالث). الاقتراح ليس الحاجز — الحاجز هو fail-closed + المراجعة البشرية. **لا نثق في LLM لقرار جمهور.**

### 4.2 واتساب — القرار التقني

| الخيار | الأمن | امتثال ToS | الحكم |
|:---|:---|:---|:---|
| **WhatsApp Cloud API** (Meta) | webhook موقّع `X-Hub-Signature-256`، لا استضافة جلسة | **متوافق رسمياً** | **المعتمد للإنتاج / لأي حجم رسمي** |
| WAHA Core (WhatsApp Web، MIT) | جلسة شخصية مستضافة، QR | **مخالفة محتملة لـ ToS واتساب** | **مقبول للتجريب الداخلي الفردي فقط؛ يُحسَم قانونياً قبل أي توسّع** |
| Baileys / whatsapp-web.js مباشرة | خطر حظر عالٍ | مخالف | **مرفوض** |

> **حسم تعارض الأبعاد:** بُعد التكاملات اعتمد Cloud API؛ بُعد الوصول اقترح WAHA Core. **الحسم:** Cloud API هو المسار المتوافق المعتمد لأي استخدام رسمي/متوسّع. WAHA Core يبقى خياراً للتجريب الداخلي الفردي **بشرط حسم قانوني صريح من legal-compliance-advisor قبل البناء** (نفس مبدأ صرامة امتثال Anthropic على الأسطول). القرار النهائي بين المسارين **مهمة قرار تنتظر المالك (انظر §8).**

**التدفق (مستقل عن المحرك):**
```
واتساب → [wa-ingress: تحقق توقيع، ردّ 200 فوري، صفّ في الطابور]
       → [wa-worker: سحب الوسائط → Seafile، بناء IngestEnvelope]
       → خط الإدخال (مراحل 2-5) → PR على ingest/whatsapp/<id>
```

**قرارات أمنية حاكمة (واتساب أخطر سطح إدخال):**
1. `wa-ingress` لا يلمس Git/Seafile مباشرة — يستقبل، يتحقق، يصفّ فقط.
2. تحقق التوقيع إلزامي fail-closed؛ webhook بلا توقيع صحيح يُرفض ويُسجَّل.
3. **allowlist للمُرسِلين** — أرقام الفريق فقط أولاً؛ رقم خارجها يُهمَل (يسدّ حقن الغرباء).
4. `audience: internal` افتراضاً؛ الترقية بشرية في الـ PR.
5. الوسائط → Seafile، والملف في Git يحمل `seafile_path` فقط.
6. الأسرار (App Secret/verify token/Seafile token) في خزنة أسرار خارج Git؛ نقطة webhook هي الاستثناء الوحيد المعرَّض عاماً (عبر نفق، UFW يسمح بمنفذ النفق فقط).

### 4.3 ترافنشر — مزامنة المحتوى

- **الاتجاه: أحادي (ترافنشر → سدرة، read-only من جانب سدرة).** سدرة قاعدة معرفة لا CMS؛ لا تكتب لموقع ترافنشر. الأسعار الحية تبقى في منصة الحجز (سلة) — تأكيداً لمبدأ schema «الأسعار الحية ليست هنا».
- **التكرار: مجدول ليلي خفيف (systemd timer) + يدوي عند الطلب.** لا webhook لحظي في المرحلة الأولى (المحتوى الوصفي بطيء التغيّر).
- **التقنية (بترتيب تفضيل):** (1) API/feed رسمي من سلة/الـCMS، (2) export منظَّم (JSON/sitemap)، (3) scraping مهيكل read-only كملاذ أخير. **يلزم فحص ما يتيحه الموقع فعلاً قبل التثبيت (مهمة للمالك §8).**
- **Idempotency:** كل عنصر له مفتاح مصدر مستقر في frontmatter؛ المزامنة **تحدّث الملف القائم لا تكرّره** (R8 يحرس). المزامنة تفتح PR بالـ diff لا ملفات عمياء، ولا تدهس تعديلاً بشرياً صامتاً (تُظهر التعارض للمراجع).
- **PII:** بيانات الحجوزات تمرّ على `03-Data-Retention-Deletion-Policy-AR.md` القائمة قبل أي أرشفة، ولا تصل `public`.

---

## 5. خطة النشر المرحلية على مجتنى

### 5.0 واقع البنية التحتية (حاجز توثيق)

- **مجتنى = VM على Proxmox.** السياق يحدد مواصفات: Intel Core 7 240H، 16GB RAM. **لكن** `references/hypervisors/jalal.md` لا يحوي هذه المواصفات (يصف jalal كمضيف صديق يستضيف `mina`). **تعارض مرجعي:** تُعتمد مواصفات السياق (16GB) كأساس تصميم، **ومهمة إلزامية قبل أول نشر: إنشاء `~/.claude/docs/mujtana-server.md`** (نمط mina-server) يثبّت المضيف/الموارد/الشبكة الفعلية.
- **التشغيل: Docker Compose** (stack واحد) — يطابق نمط الأسطول (silverbullet/odoo/wafeq compose).
- **الشبكة: Tailscale حصراً، UFW deny-all-incoming**، المنافذ على `tailscale0` فقط، لا قاعدة public واحدة (استثناء وحيد محتمل: نقطة webhook واتساب عبر نفق Cloudflare، تُبرَّر بـ ADR).

### 5.1 المراحل

| المرحلة | المحتوى | بوابة الخروج |
|:---|:---|:---|
| **P0 — التأسيس** | توثيق مجتنى، اعتماد PROJECT_PLAN، ADRs، خزنة أسرار، Tailscale+UFW | `mujtana-server.md` + خطة معتمدة + 5 ADRs |
| **P1 — L0 المعرفة (الموجود)** | نقل Git مصدر الحقيقة، Forgejo، PostgreSQL+pgvector، خدمة الاسترجاع+router | استرجاع `(company, audience)` يعمل fail-closed |
| **P2 — L3 الأرشفة** | MinIO SNSD على tailscale0، مفتاح/سياسة لكل سيرفر، object-lock+lifecycle | `mc cp` من سيرفر تجريبي ينجح؛ لا DeleteObject |
| **P3 — L2 الملفات** | Seafile CE + SQLite خلف عكسي، مكتبات الشركات، مكتبة عقود مشفّرة | رفع/مزامنة + `seafile_path` يربط L0↔L2 |
| **P4 — L1 الإدخال** | فاتح PR + طابور؛ محوِّل واتساب (المحرك المحسوم §8)؛ محوِّل ترافنشر | PR آلي يمرّ `validate.py` ويُراجَع بشرياً |
| **P5 — النسخ والإلغاء** | نسخ سدرة نفسها 3-2-1، هجرة القديم، تقاعد المصادر القديمة | استعادة مُختبَرة 5/5 + القديم مُلغى موثّقاً |

### 5.2 مخطط النشر

```
مجتنى VM (Proxmox) — Debian, ضمن Tailscale, UFW deny-all
└── /opt/sidra/  (docker-compose.yml)
    ├── forgejo      → tailscale0        vol:/data/git     (L0 مصدر الحقيقة)
    ├── postgres+pgvector → internal     vol:/data/pg      (L0 فهارس)
    ├── retrieval-api → tailscale0        (router fail-closed على (company,audience))
    ├── minio        :9000/:9001 → tailscale0  vol:/data/minio  (L3)
    ├── seafile+sqlite :8000 → 127.0.0.1  vol:/data/seafile     (L2)
    ├── waha         :3000 → 127.0.0.1   vol:/data/waha   (L1، أو Cloud API لا حاوية)
    ├── ingest-prbot → internal          (طابور SQLite + فاتح PR)
    └── caddy        :443 → tailscale0    (عكسي TLS داخلي أمام seafile/retrieval)
```

### 5.3 الوصول الآلي للسيرفرات الخمسة

| نوع الكتابة | البروتوكول | العميل |
|:---|:---|:---|
| نسخ احتياطية آلية | S3 → MinIO (L3) | `mc` في systemd/cron |
| استهلاك المعرفة (بوت/تطبيق) | HTTPS → retrieval-api (L0) | مفتاح API مقيّد بأزواج `(company, audience)` |
| ملفات بشرية | WebDAV → Seafile (L2) | `rclone` عند الطلب / عميل Seafile |

**نمط الأرشفة المعياري (يطابق diwan):**
```
backup → gzip → gpg --symmetric AES256 → mc cp - sidra/<server>-backups/<TS>.ext.gpg
```
التشفير على المصدر قبل المغادرة → مجتنى يخزّن ciphertext فقط (zero-trust). مفتاح S3 لكل سيرفر بسياسة `PutObject` على prefix نفسه فقط، **بلا `DeleteObject`** (حماية من ransomware/خطأ سكربت)؛ الحذف يديره مجتنى عبر lifecycle.

**لا mount شبكي دائم** (NFS/WebDAV-mount) — هشّ على انقطاع Tailscale (يُجمّد الكتابة D-state). S3 وsync يتعافيان بنظافة.

### 5.4 الواجهات الرسومية للمالك

- **Forgejo Web** (`sidra-git.<tailnet>.ts.net`): تصفّح/مراجعة PR للمعرفة.
- **Seafile Web** (`sidra.<tailnet>.ts.net`): ملفات بشرية يومية.
- **MinIO Console** (`…:9001`): تدقيق buckets/سياسات.
- **التسمية:** Tailscale MagicDNS داخلي — **لا CNAME عام على alkindy.tech** (سياسة لا-public).

---

## 6. النسخ الاحتياطي لسدرة نفسها (سدرة «المرجع الوحيد» = SPOF)

**المبدأ: 3-2-1، نسخة خارج مجتنى، استعادة مُختبَرة.**

1. **L0 Git:** Forgejo مُنسوخ + **مرآة احتياطية مشفّرة على GitHub خاص** (`Kindi-sa`) كـ legacy/backup (لا مصدر حقيقة). الفهارس مشتقة → تُعاد بناءً من Git، لا تُنسَخ.
2. **MinIO (L3):** `versioning` + `object-lock` (WORM) على buckets الأرشيف؛ `mc mirror` يومي إلى MinIO على سيرفر أسطول آخر عبر Tailscale → يلغي «المرجع الوحيد» كـ SPOF.
3. **Seafile (L2):** `seaf-gc` ثم tar لـ`seafile-data/` + dump DB، مشفّر GPG، يُرفع لـ bucket MinIO ومنه يُرحَّل مع mirror البند 2.
4. **المكدّس كله:** `restic` يومي إلى وجهة off-box مشفّرة (سيرفر أسطول آخر)، AES256، retention 30 يوم؛ systemd timer + `*-failure@.service` للتنبيه.
5. **اختبار استعادة دوري إلزامي** (درس diwan: «5/5») — نسخة بلا استعادة مُختبَرة ليست نسخة. ربع سنوي، يُسجَّل في `ops/backup/`.
6. **lifecycle** على buckets الأرشيف لمنع التضخم على VM محدود.

---

## 7. إلغاء «القديم» والهجرة إلى سدرة

### 7.1 جرد المصادر القديمة وقرار كلٍّ منها

| المصدر القديم | الحجم/الطبيعة | القرار | الآلية |
|:---|:---|:---|:---|
| **SilverBullet** (`nassaj-core`, vault المعرفة الحية ~50MB md) | محرّر معرفة حيّ مربوط بـ claude-config fleet-sync و`~/.claude` memory | **يبقى منفصلاً — لا يُدمَج** | سدرة تأخذ نسخة احتياطية دورية (`mc mirror` → `sidra/silverbullet-mirror/`)؛ SB يبقى مصدر الحقيقة الحي. دمجه يكسر fleet-sync الموثّق. |
| `nassaj-core/projects/` (~1GB session-data/jsonl) | ضوضاء تشغيلية للوكلاء | **مُستبعَد نهائياً** | ليس معرفة؛ لا يدخل سدرة إطلاقاً. |
| `raw/_inbox` (مهجور، README فقط) | نية إدخال غير منفَّذة | **تُلغى لصالح L1** | سدرة L1 هي التنفيذ الفعلي لهذه النية؛ يُؤرشف README ويُتقاعد المسار. |
| **مرفقات SilverBullet الثقيلة** (PDF/صور داخل vault) | تضخّم vault | **تنتقل لـ L2 Seafile** | SB يخزّن رابطاً، الأصل في Seafile (`seafile_path`). |
| نسخ احتياطية متفرقة محلية (`~/diwan-backups` نمط) | تخزين مبعثر | **تُوحَّد في L3** | استبدال الوجهة المحلية بـ `mc cp` إلى MinIO. |
| GitHub `Kindi-sa/rukhaimi-kb` | ريموت سدرة الحالي | **يصبح legacy/backup mirror** | بعد هجرة المركز لخادم المؤسسة الأم؛ إعادة تسميته إجراء خارجي مؤجّل بإذن (موثّق في README). |
| محتوى/بيانات ترافنشر المبعثرة | محتوى موقع + حجوزات | **تُهاجَر عبر L1** | محوِّل ترafنشر → PR إلى `traventure/` (بعد فلتر PII). |

### 7.2 مبدأ الهجرة (لا «انقلاب» واحد)

> **الهجرة تدريجية بالتوازي، لا تبديل مفاجئ.** كل مصدر قديم يُهاجَر، يُتحقَّق من سلامة الهجرة (checksum/عيّنة)، **ثم** يُتقاعد موثّقاً — لا حذف قبل تحقّق. درس memory: «لا إصلاح/حذف قبل تشخيص». المصادر الحيّة (SilverBullet) **لا تُكسَر لأجل توحيد مبكّر** — تُؤرشَف وتبقى عاملة.

---

## 8. القرارات المعمارية المطلوبة (ADRs — بوابة رفض)

> قاعدة تخصص architect: **قرار معماري بلا ADR موثَّق = رفض.** هذه القرارات تستلزم ADR (Context → Alternatives → Decision → Consequences → Status) في `alkindy/decisions/` قبل أي اعتماد للتنفيذ. (ملاحظة: ADR-T2 القائم يحكم L0 بالفعل.)

| ADR | الموضوع | Status |
|:---|:---|:---|
| **ADR-SEDRA-001** | المكدّس الرباعي (L0 Git + L1 Ingest + L2 Seafile + L3 MinIO)؛ رفض NextCloud؛ Seafile CE لا S3 → خدمتان متجاورتان | Proposed |
| **ADR-SEDRA-002** | علاقة سدرة بـ SilverBullet: فصل بأدوار (SB محرّر حي، سدرة أرشيف) — لا دمج ولا فصل تام | Proposed |
| **ADR-SEDRA-003** | بروتوكول الوصول S3-عبر-Tailscale + مفتاح-لكل-سيرفر least-privilege؛ رفض mount الشبكي | Proposed |
| **ADR-SEDRA-004** | نسخ سدرة 3-2-1 خارج مجتنى + zero-trust encryption على المصدر | Proposed |
| **ADR-SEDRA-005** | محرّك واتساب: Cloud API (معتمد) مقابل WAHA Core (تجريبي مشروط) — يحتاج حسم legal | Proposed (blocked on legal) |

---

## 9. الامتثال والقيود المنعكسة في التصميم

- **Tailscale only، لا تعريض عام** — استثناء وحيد محتمل: webhook واتساب عبر نفق، بـ ADR مستقل، لا default.
- **AGPL/تراخيص:** MinIO (AGPLv3)، Seafile CE (AGPLv3/GPLv2)، WAHA Core (MIT)، Forgejo (MIT) — كلها متوافقة مع الاستخدام الداخلي؛ يُتحقَّق في ADR-001.
- **Anthropic ToS:** سدرة مخزن بيانات ساكنة؛ لا تشغّل نماذج كلود ولا تمسّ اشتراكاً. التصنيف الآلي LLM (إن استُخدم) عبر API متوافق فقط، لا اشتراك شخصي.
- **PDPL/PII (ترافنشر/واتساب):** `audience`/`sensitivity`/`retention` إلزامية؛ الحذف الآلي يطبّق `03-Data-Retention-Deletion-Policy-AR.md`؛ `pii` لا يصل `public` أبداً. **يحتاج مراجعة legal-compliance-advisor قبل بناء L1.**

---

## 10. البوابات قبل أي تنفيذ (تُعاد للمنسّق)

1. **لا `PROJECT_PLAN.md` معتمد لسدرة بعد.** هذا التصميم مُدخَل لبوابة بدء المشروع، لا بديل عنها. ممنوع كود/نشر/تركيب قبل دمج مخرج product-strategist + هذا التصميم في الخطة + **موافقة صريحة مكتوبة** (الخطوة 5).
2. **5 ADRs** (§8) تُكتب وتُعتمد قبل التنفيذ.
3. **توثيق مجتنى** (`mujtana-server.md`) قبل أول عملية.
4. **legal-compliance-advisor:** حسم محرّك واتساب (ToS) + PDPL لبيانات الإدخال **قبل** بناء L1، لا بعده.
5. **إذن إنتاج منفصل** لأي سيرفر إنتاج (الكِندي/ميناء) كوجهة backup — لم يُمنح.
6. **قرار/صلاحية المالك:** رقم WhatsApp Business + Meta App (إن Cloud API)، وتوفّر API ترافنشر.

---

## مراجع (مسارات مطلقة)

- `/home/nassaj/Project/sidra/README.md` — فلسفة سدرة وبنيتها القائمة (ADR-T2).
- `/home/nassaj/Project/sidra/_schema/frontmatter.md` — schema الحقول والقواعد الكاسرة.
- `/home/nassaj/Project/sidra/_ci/validate.py` — الفاحص الكاسر (R1-R8).
- `/home/nassaj/Project/sidra/_templates/contract.md` — نموذج عقد `seafile_path`.
- `/home/nassaj/nassaj-server-docs.md` — أنماط الأسطول التشغيلية.
- `/home/nassaj/nassaj-core/references/hypervisors/jalal.md` — مرجع Proxmox (ناقص لمجتنى — يلزم `mujtana-server.md`).
- `/home/nassaj/Project/traventure/docs/legal/03-Data-Retention-Deletion-Policy-AR.md` — retention الملزم لبيانات ترافنشر.
