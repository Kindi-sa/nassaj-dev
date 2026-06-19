# معمارية nassaj-dev — المزوّدون ونماذج المورّدين

> نطاق هذا المستند: طبقة النماذج متعددة المزوّدين، مع التركيز على نماذج المورّدين
> المستضافة (Kimi / DeepSeek / GLM) وFable 5 المضافة في ADR-036. هذه أداة تطوير
> **داخلية أحادية المستخدم** (فورك AGPL-3.0 من claudecodeui). انظر
> `docs/decisions/036-vendor-models-integration.md`.

## طبقة المزوّدين

كل تكامل نموذج هو مزوّد تحت `server/modules/providers/list/<id>/` يعرض ستة أوجه
(`server/shared/interfaces.ts`):

| الوجه | المسؤولية |
| --- | --- |
| `models` | حلّ كتالوج النماذج + النموذج الفعّال/المختار |
| `auth` | الإبلاغ عن حالة التثبيت/المصادقة |
| `mcp` | قراءة/سرد/كتابة إعداد MCP الأصلي للمزوّد |
| `skills` | اكتشاف مهارات المزوّد الأصلية |
| `sessions` | تطبيع الأحداث الحيّة + جلب التاريخ |
| `sessionSynchronizer` | فهرسة ملفّات الجلسات في قاعدة البيانات |

`models` و`auth` و`sessions` و`sessionSynchronizer` تُطبَّق concretely (تعتمد صيغ
الـSDK/CLI الأصلية). `mcp`/`skills` ترث أساسات مجرّدة مشتركة
(`shared/mcp/mcp.provider.ts` و`shared/skills/skills.provider.ts`). مزوّد Cursor هو
المرجع؛ مزوّدو المورّدين الجدد يتبعونه.

تُسجَّل المزوّدات في `provider.registry.ts`، فتُحلّ عبر `resolveProvider` وتظهر
آلياً في `/api/providers/:provider/models` و`/auth/status`.

## المزوّدون الحاليون

`claude` و`codex` و`cursor` و`gemini` و`antigravity` و`opencode`، والمورّدون
المستضافون الثلاثة `kimi` و`deepseek` و`glm`.

## Fable 5 (كتالوج فقط)

`claude-fable-5` نموذج Anthropic يظهر عبر كتالوج مزوّد `claude` القائم
(`CLAUDE_FALLBACK_MODELS`). التطبيق يقود Claude عبر Agent SDK (`query()`) الذي
يقبل معرّف النموذج مباشرةً — لا طلب Messages خام لتعديله. Fable يمرّ بمسار claude
فيشمله حارس القاعدة الحديدية آلياً.

## نماذج المورّدين المستضافة (Kimi / DeepSeek / GLM)

هذه واجهات HTTP بعيدة (Moonshot وDeepSeek وZhipu/Z.ai)، لا CLIs محلية. أُضيفت
للاستخدام الداخلي الفردي؛ يصبح المورّد فعّالاً لحظة تهيئة مفتاحه (سلوك auth-status
في ADR-030)، بلا بوابة توجيه.

### القاعدة الحديدية (حدّ صارم)

seam تشغيل المورّد لا يمكنه أبداً توجيه عميل Claude إلى منافس:

- عناوين القاعدة **ثابتة في الكود** في `shared/vendor/vendor-config.ts`، لا تُقرأ
  من `ANTHROPIC_BASE_URL`.
- المفتاح متغيّر بيئة خاص بالمزوّد (`KIMI_API_KEY` / `DEEPSEEK_API_KEY` /
  `GLM_API_KEY`) يحقنه `resolveProviderEnv` — لا `ANTHROPIC_AUTH_TOKEN` ولا أي
  مفتاح تحت namespace ‏`ANTHROPIC_*`/`CLAUDE_*`.
- الـseam يستخدم `fetch` خام ولا يستورد `@anthropic-ai/*` ولا `claude-sdk.js`.

يُفرض باختبارين (`node:test`):
`server/services/isolation/iron-rule-guard.test.ts` (ثابت: لا استيراد SDK أنثروبيك
ولا ذكر `ANTHROPIC_*`/`CLAUDE_*` في الـseam) و
`server/services/isolation/resolve-provider-env.test.ts` (موجب: البيئة الناتجة
تحمل مفتاح المورّد فقط، بلا مفتاح في namespace أنثروبيك).

### عزل الأسرار لكل مستخدم

`server/services/isolation/provider-secrets-store.js` يشفّر مفاتيح كل مستخدم عند
الراحة (AES-256-GCM؛ مفتاح الخادم من `NASSAJ_PROVIDER_SECRETS_KEY` أو ملف مفتاح
‏0600 مُولَّد خارج المستودع) تحت `~/.nassaj-users/<userId>/.provider-secrets/`
(مخزن مشترك على جذر الـhome في الوضع الأحادي). `resolveProviderEnv` يفكّ ويحقن لكل
spawn. المورّدون الثلاثة افتراضهم `'isolated'` في `provider-sharing.js`، فلا
يرتدّون أبداً إلى مفتاح مشغّل مشترك.

### النصوص والتاريخ

نسّاج يملك نص جلسة المورّد (الواجهة البعيدة لا تخزّن محلياً): سطر JSONL واحد لكل
حدث تحت `~/.nassaj-vendor-sessions/<provider>/<projectHash>/`، يكتبه seam التشغيل،
ويفهرسه المُزامن، ويعيد تشغيله `fetchHistory`.

### توافق كل مورّد

- **Kimi** — `tool_choice='required'` غير مدعوم؛ الحرارة محصورة في [0,1].
- **DeepSeek** — نحو 11% من استدعاءات الأدوات قد تأتي نصّاً؛ تُنقذ إلى `tool_use`
  في وجه sessions.
- **GLM** — البث الطويل قد ينكسر منتصفه؛ التسجيل بـJSONL لكل حدث يجعل صحّة التاريخ
  مستقلّة عن طول البث.

## الحواجز (النطاق الداخلي الفردي)

الحواجز الحقيقية: القاعدة الحديدية، ومخزن الأسرار المشفّر لكل مستخدم، وseam
التشغيل المستقل (الذي يضمن أيضاً عدم تقطير مخرجات Claude)، وفحص ترخيص أي تبعية
جديدة (لم تُضَف تبعية — أدوات Node المدمجة والوحدات القائمة فقط). بوابات
PDPL/DPA/data-residency/المراجعة القانونية الخارجية لا تنطبق على الاستخدام الداخلي
الفردي على بيانات المالك نفسه.
