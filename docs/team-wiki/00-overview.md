# صورة نسّاج الكبيرة

أهلاً بك. نسّاج منظومة عمل تُساعد الفريق على إنجاز المشاريع بكفاءة. دعنا نفهم الصورة الكبيرة قبل الدخول للتفاصيل.

## الهيكل الكامل

نسّاج أداة تطوير داخلية تابعة لمؤسسة مجتنى — المظلة الإدارية التي تنظّم عمل الفريق. الكِندِي (AlKindy) علامة ومؤسسة تجارية منفصلة عن نسّاج، تحتضن منتجات وخدمات (مفتوحة المصدر تحت AlKindy-OSS، وتجارية مغلقة تحت Kindi-sa)، ونسّاج يخدم تطوير هذه المنتجات من الخلف.

### نسّاج — أداة داخلية

أداة ذكاء اصطناعي داخلية **لا تُباع ولا تُسوّق ولا تظهر للعملاء**. تخدم الفريق الداخلي فقط. مثل مطبخ المطعم — الزبائن لا يرونها، لكنها ضرورية للعمل.

**نسّاج جزآن:**

- **نسّاج كور** — العقل: المنسّق والوكلاء والقواعد التنظيمية
- **نسّاج ديف** — الواجهة: الموقع الذي تفتحه بالمتصفح (وهو تحديداً fork — تفريعة معدَّلة — من مشروع مفتوح المصدر claudecodeui، مرخّص برخصة **AGPL-3.0**، وليست MIT)

## أين يقيم كل شيء فعلياً؟

سؤال يتكرر: "نسّاج هذا... وين بالضبط؟" وَ"وين يشتغل الذكاء الاصطناعي فعلياً؟" الإجابة المختصرة: **التنسيق محلي، والتفكير الفعلي بعيد دائماً.**

<svg class="wiki-diagram" viewBox="0 0 1180 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="مخطط الهيكل الكامل لنسّاج: طبقة الوصول (متصفح، طرفية، agy، Hermes) تصل إلى الخادم المحلي (نفق كلاودفلير، كود نسّاج ديف، المنسّق، وكيل متخصص) الذي ينسّق محلياً فقط، بينما التفكير يجري دائماً في السحابة البعيدة (سحابة Anthropic افتراضياً، وسحابة Antigravity وسحابة Nous عند التفعيل الصريح).">
  <title>الهيكل الكامل لنسّاج — التنسيق محلي، والتفكير سحابي دائماً</title>
  <desc>ثلاث طبقات من الأعلى للأسفل: كيف تصل، الخادم المحلي (تنسيق فقط)، ومعالجة الذكاء الاصطناعي السحابية. الخطوط الممتلئة مسارات دائمة والمنقّطة مسارات مباشرة أو عند التفعيل الصريح.</desc>
  <defs>
    <marker id="ov1-arrow-solid" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(var(--muted-foreground))" />
    </marker>
    <marker id="ov1-arrow-dash" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(var(--ring))" />
    </marker>
    <marker id="ov1-arrow-local" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(145 55% 42%)" />
    </marker>
  </defs>

  <!-- المحتوى (عرضه 900) موسّط داخل viewBox=1180 بإزاحة 140 على كل جانب، فلا قصّ ولا هامش أعرج.
       عناوين الأشرطة اليمنى تحمل direction="rtl" مع text-anchor="end" لتُثبَّت حافتها اليمنى عند المرساة
       وتتدفّق يساراً — يمنع أي تجاوز للحافة اليمنى مهما طال النص. -->
  <g transform="translate(140,10)">

  <!-- ═══ طبقة ١: كيف تصل؟ ═══ -->
  <g>
    <rect x="0" y="0" width="900" height="132" rx="18" fill="hsl(var(--muted) / 0.45)" stroke="hsl(var(--border))" stroke-width="1.5" />
    <text x="882" y="27" text-anchor="start" direction="rtl" font-family="Tajawal, 'IBM Plex Sans Arabic', sans-serif" font-size="16" font-weight="700" fill="hsl(var(--foreground))">كيف تصل؟</text>

    <!-- متصفح (أقصى اليمين) -->
    <g transform="translate(688,44)">
      <rect x="0" y="0" width="194" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <rect x="16" y="24" width="26" height="20" rx="3" fill="none" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <line x1="16" y1="30" x2="42" y2="30" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <circle cx="19.5" cy="27" r="1.1" fill="hsl(var(--primary))" />
      <circle cx="23.5" cy="27" r="1.1" fill="hsl(var(--primary))" />
      <text x="178" y="32" text-anchor="start" font-family="Tajawal, sans-serif" font-size="14" font-weight="700" fill="hsl(var(--card-foreground))">متصفح</text>
      <text x="178" y="54" text-anchor="end" font-family="Tajawal, sans-serif" font-size="10.5" fill="hsl(var(--muted-foreground))" direction="ltr">nassaj.alkindy.tech</text>
    </g>

    <!-- طرفية -->
    <g transform="translate(466,44)">
      <rect x="0" y="0" width="204" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <rect x="16" y="23" width="26" height="22" rx="3" fill="hsl(var(--foreground) / 0.06)" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <path d="M20,30 l4,4 l-4,4" fill="none" stroke="hsl(var(--primary))" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="28" y1="39" x2="36" y2="39" stroke="hsl(var(--primary))" stroke-width="1.6" stroke-linecap="round" />
      <text x="188" y="32" text-anchor="start" font-family="Tajawal, sans-serif" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">طرفية Claude Code</text>
      <text x="188" y="54" text-anchor="start" font-family="Tajawal, sans-serif" font-size="10.5" fill="hsl(var(--muted-foreground))">اتصال CLI مباشر</text>
    </g>

    <!-- agy -->
    <g transform="translate(244,44)">
      <rect x="0" y="0" width="204" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <circle cx="29" cy="34" r="13" fill="none" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <ellipse cx="29" cy="34" rx="13" ry="5.5" fill="none" stroke="hsl(var(--primary))" stroke-width="1.4" />
      <line x1="29" y1="21" x2="29" y2="47" stroke="hsl(var(--primary))" stroke-width="1.4" />
      <text x="188" y="32" text-anchor="start" font-family="Tajawal, sans-serif" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">عميل agy</text>
      <text x="188" y="54" text-anchor="start" font-family="Tajawal, sans-serif" font-size="10.5" fill="hsl(var(--muted-foreground))">مزوّد Antigravity</text>
    </g>

    <!-- Hermes (أقصى اليسار) -->
    <g transform="translate(18,44)">
      <rect x="0" y="0" width="204" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" stroke-dasharray="4 3" />
      <path d="M22,46 l0,-18 a7,7 0 0 1 14,0 l0,18 M18,46 l22,0" fill="none" stroke="hsl(var(--primary))" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      <text x="188" y="32" text-anchor="start" font-family="Tajawal, sans-serif" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">عميل Hermes</text>
      <text x="188" y="54" text-anchor="start" font-family="Tajawal, sans-serif" font-size="10.5" fill="hsl(var(--muted-foreground))">مزوّد Nous · تكامل جزئي</text>
    </g>
  </g>

  <!-- ═══ طبقة ٢: الخادم المحلي ═══ -->
  <g>
    <rect x="0" y="200" width="900" height="238" rx="18" fill="hsl(145 45% 42% / 0.08)" stroke="hsl(145 50% 42%)" stroke-width="1.75" />
    <g transform="translate(882,228)">
      <text x="0" y="0" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="16" font-weight="700" fill="hsl(var(--foreground))">الخادم — محلي عندنا</text>
      <text x="0" y="20" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="11.5" fill="hsl(145 45% 38%)">تنسيق فقط · بلا تفكير ذكاء اصطناعي</text>
    </g>

    <!-- نفق Cloudflare -->
    <g transform="translate(660,270)">
      <rect x="0" y="0" width="222" height="66" rx="12" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.55)" stroke-width="1.5" />
      <path d="M18,44 a11,11 0 0 1 2,-21 a13,13 0 0 1 24,3 a9,9 0 0 1 -2,18 Z" fill="hsl(145 55% 42% / 0.14)" stroke="hsl(145 55% 42%)" stroke-width="1.5" stroke-linejoin="round" />
      <text x="206" y="27" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">نفق Cloudflare</text>
      <text x="206" y="47" text-anchor="end" font-family="Tajawal, sans-serif" font-size="10" fill="hsl(var(--muted-foreground))" direction="ltr">nassaj.alkindy.tech → 127.0.0.1:3004</text>
    </g>

    <!-- كود نسّاج ديف -->
    <g transform="translate(660,352)">
      <rect x="0" y="0" width="222" height="64" rx="12" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.55)" stroke-width="1.5" />
      <path d="M28,22 l-9,10 l9,10 M20,22 l7,0 l0,20 l-7,0" fill="none" stroke="hsl(145 55% 42%)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      <rect x="30" y="26" width="14" height="12" rx="2" fill="none" stroke="hsl(145 55% 42%)" stroke-width="1.5" />
      <text x="206" y="27" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">كود نسّاج ديف</text>
      <text x="206" y="47" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="10" fill="hsl(var(--muted-foreground))">الخادم الرئيسي · fork من claudecodeui</text>
    </g>

    <!-- المنسّق -->
    <g transform="translate(338,274)">
      <rect x="0" y="0" width="266" height="76" rx="14" fill="hsl(var(--primary))" stroke="hsl(var(--primary))" stroke-width="1.5" />
      <g transform="translate(30,38)" stroke="hsl(var(--primary-foreground))" fill="none" stroke-width="1.7">
        <circle cx="0" cy="0" r="7" />
        <g stroke-linecap="round">
          <line x1="0" y1="-13" x2="0" y2="-10" /><line x1="0" y1="13" x2="0" y2="10" />
          <line x1="-13" y1="0" x2="-10" y2="0" /><line x1="13" y1="0" x2="10" y2="0" />
          <line x1="-9.2" y1="-9.2" x2="-7" y2="-7" /><line x1="9.2" y1="9.2" x2="7" y2="7" />
          <line x1="9.2" y1="-9.2" x2="7" y2="-7" /><line x1="-9.2" y1="9.2" x2="-7" y2="7" />
        </g>
        <circle cx="0" cy="0" r="2.4" fill="hsl(var(--primary-foreground))" />
      </g>
      <text x="248" y="32" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="16" font-weight="800" fill="hsl(var(--primary-foreground))">المنسّق</text>
      <text x="248" y="54" text-anchor="end" font-family="Tajawal, sans-serif" font-size="11.5" fill="hsl(var(--primary-foreground) / 0.85)" direction="ltr">Fable 5</text>
    </g>

    <!-- وكيل متخصص (يسار، مباعد عن المنسّق) -->
    <g transform="translate(18,262)">
      <rect x="0" y="0" width="266" height="100" rx="14" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.55)" stroke-width="1.5" />
      <g transform="translate(30,32)" stroke="hsl(145 55% 42%)" fill="none" stroke-width="1.7">
        <circle cx="0" cy="-4" r="6" />
        <path d="M-9,14 a9,9 0 0 1 18,0" stroke-linecap="round" />
      </g>
      <text x="248" y="30" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="14.5" font-weight="800" fill="hsl(var(--card-foreground))">وكيل متخصص واحد</text>
      <text x="248" y="54" text-anchor="end" font-family="Tajawal, sans-serif" font-size="10.5" fill="hsl(var(--muted-foreground))" direction="ltr">architect · backend-dev · frontend-dev</text>
      <text x="248" y="74" text-anchor="end" font-family="Tajawal, sans-serif" font-size="10.5" fill="hsl(var(--muted-foreground))" direction="ltr">qa-critic · scribe · devops · tester …</text>
    </g>
  </g>

  <!-- ═══ طبقة ٣: السحابة ═══ -->
  <g>
    <rect x="0" y="484" width="900" height="152" rx="18" fill="hsl(202 85% 55% / 0.09)" stroke="hsl(202 80% 52%)" stroke-width="1.75" />
    <g transform="translate(882,512)">
      <text x="0" y="0" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="16" font-weight="700" fill="hsl(var(--foreground))">معالجة الذكاء الاصطناعي — سحابية دائماً</text>
      <text x="0" y="20" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="11.5" fill="hsl(202 65% 45%)">خارج الخادم · كل مستخدم باشتراكه الخاص</text>
    </g>

    <!-- سحابة Anthropic -->
    <g transform="translate(626,550)">
      <rect x="0" y="0" width="256" height="70" rx="14" fill="hsl(202 85% 55% / 0.10)" stroke="hsl(202 80% 52%)" stroke-width="1.6" />
      <path d="M18,50 a12,12 0 0 1 2,-23 a14,14 0 0 1 26,3 a10,10 0 0 1 -2,20 Z" fill="hsl(202 85% 55% / 0.16)" stroke="hsl(202 80% 52%)" stroke-width="1.6" stroke-linejoin="round" />
      <text x="240" y="30" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--foreground))">سحابة Anthropic</text>
      <text x="240" y="50" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="10" fill="hsl(var(--muted-foreground))">الافتراضي · حارس القاعدة الحديدية</text>
    </g>

    <!-- سحابة Antigravity -->
    <g transform="translate(340,550)">
      <rect x="0" y="0" width="262" height="70" rx="14" fill="hsl(202 85% 55% / 0.06)" stroke="hsl(202 60% 52% / 0.7)" stroke-width="1.5" stroke-dasharray="5 4" />
      <path d="M18,50 a12,12 0 0 1 2,-23 a14,14 0 0 1 26,3 a10,10 0 0 1 -2,20 Z" fill="hsl(202 85% 55% / 0.10)" stroke="hsl(202 65% 52%)" stroke-width="1.5" stroke-linejoin="round" />
      <text x="246" y="30" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="14" font-weight="700" fill="hsl(var(--foreground))">سحابة Antigravity</text>
      <text x="246" y="50" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="10" fill="hsl(var(--muted-foreground))">عبر agy · عند التفعيل الصريح</text>
    </g>

    <!-- سحابة Nous -->
    <g transform="translate(18,550)">
      <rect x="0" y="0" width="298" height="70" rx="14" fill="hsl(202 85% 55% / 0.06)" stroke="hsl(202 60% 52% / 0.7)" stroke-width="1.5" stroke-dasharray="5 4" />
      <path d="M18,50 a12,12 0 0 1 2,-23 a14,14 0 0 1 26,3 a10,10 0 0 1 -2,20 Z" fill="hsl(202 85% 55% / 0.10)" stroke="hsl(202 65% 52%)" stroke-width="1.5" stroke-linejoin="round" />
      <text x="282" y="30" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="14" font-weight="700" fill="hsl(var(--foreground))">سحابة Nous</text>
      <text x="282" y="50" text-anchor="start" direction="rtl" font-family="Tajawal, sans-serif" font-size="10" fill="hsl(var(--muted-foreground))">عبر Hermes · عند التفعيل الصريح</text>
    </g>
  </g>

  <!-- ═══ الوصلات ═══ -->
  <!-- متصفح → نفق (ممتلئ) -->
  <path d="M785,116 L771,270" fill="none" stroke="hsl(var(--muted-foreground))" stroke-width="2" marker-end="url(#ov1-arrow-solid)" />
  <!-- طرفية → منسّق (منقّط مباشر) -->
  <path d="M568,116 C560,180 520,222 500,274" fill="none" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-dash)" />
  <!-- agy → منسّق (منقّط) -->
  <path d="M346,116 C366,180 430,228 455,274" fill="none" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-dash)" />
  <!-- Hermes → منسّق (منقّط) -->
  <path d="M120,116 C150,190 320,240 360,290" fill="none" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-dash)" />
  <text x="470" y="176" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="10.5" font-weight="600" fill="hsl(var(--ring))">بلا نفق · اتصال مباشر</text>

  <!-- نفق → كود (محلي ممتلئ) -->
  <path d="M771,336 L771,352" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2" marker-end="url(#ov1-arrow-local)" />
  <!-- كود → منسّق (محلي ممتلئ) -->
  <path d="M660,384 L604,326" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2" marker-end="url(#ov1-arrow-local)" />
  <!-- منسّق → وكيل (محلي ممتلئ، يفوّض) -->
  <path d="M338,312 L284,312" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2.4" marker-end="url(#ov1-arrow-local)" />
  <text x="311" y="366" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="10.5" font-weight="700" fill="hsl(145 45% 38%)">يفوّض فوراً · لا ينفّذ بنفسه</text>

  <!-- منسّق → Anthropic (ممتلئ سحابي، استدلال) -->
  <path d="M560,350 C640,430 710,486 754,550" fill="none" stroke="hsl(202 80% 52%)" stroke-width="2.4" marker-end="url(#ov1-arrow-solid)" />
  <text x="712" y="460" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="10.5" font-weight="700" fill="hsl(202 65% 45%)">استدلال النموذج</text>
  <!-- منسّق → Antigravity (منقّط سحابي) -->
  <path d="M468,350 C470,430 470,486 466,550" fill="none" stroke="hsl(202 60% 52%)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-solid)" />
  <!-- منسّق → Nous (منقّط سحابي) -->
  <path d="M386,350 C300,430 220,486 178,550" fill="none" stroke="hsl(202 60% 52%)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-solid)" />
  <text x="250" y="460" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="10.5" font-weight="600" fill="hsl(202 60% 48%)">عند التفعيل الصريح · مرونة المورّد</text>

  <!-- مفتاح الخطوط (أسفل طبقة السحابة، خارج حدّها) -->
  <g transform="translate(18,662)">
    <line x1="0" y1="0" x2="26" y2="0" stroke="hsl(var(--muted-foreground))" stroke-width="2" />
    <text x="32" y="4" font-family="Tajawal, sans-serif" font-size="11" fill="hsl(var(--muted-foreground))">مسار دائم</text>
    <line x1="150" y1="0" x2="176" y2="0" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" />
    <text x="182" y="4" font-family="Tajawal, sans-serif" font-size="11" fill="hsl(var(--muted-foreground))">مباشر / عند التفعيل</text>
  </g>

  </g>
</svg>

**كيف تقرأ هذا المخطط:**

| الطبقة | المعنى |
|---|---|
| **كيف تصل؟** | أربع طرق: متصفح إلى الموقع، طرفية Claude Code مباشرة، عميل agy، أو عميل Hermes (تكامل جزئي حالياً) |
| **الخادم — محلي** | نسّاج ديف (الكود الفعلي، fork من claudecodeui) يعمل على الخادم الرئيسي، ويُخدَّم عبر نفق Cloudflare من `nassaj.alkindy.tech` إلى `127.0.0.1:3004`. هنا المنسّق يستقبل طلبك ويفوّضه فوراً لوكيل واحد متخصص — **تنسيق فقط، لا معالجة ذكاء اصطناعي محلياً** |
| **معالجة الذكاء الاصطناعي — سحابية دائماً** | الاستدلال الفعلي للنموذج (تفكير الوكيل) يحدث دوماً خارج هذا الخادم: على سحابة Anthropic افتراضياً، أو على سحابة مزوّد بديل (Antigravity، Nous) عند تفعيل صريح ضمن مبادرة مرونة المورّد. كل مستخدم باشتراكه/مفتاحه الخاص — لا اشتراك مشترك |

**الخلاصة بجملة واحدة:** نسّاج (التنسيق) عندنا، دائماً؛ والذكاء الاصطناعي (التفكير) بعيد، دائماً.

## رحلة سريعة: ماذا يحدث عندما تكتب طلباً؟

<svg class="wiki-diagram" viewBox="0 0 960 340" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="رحلة طلب سريعة عبر خط زمني من ست محطات، تُقرأ من اليمين لليسار: تكتب طلباً، ثم نسّاج ديف يمرّره، ثم المنسّق يفحص الحصة والموارد، ثم وكيل متخصص ينفّذ ويختبر، ثم المنسّق يحدّث لوحة المشروع، وأخيراً ترى النتيجة مباشرة.">
  <title>رحلة طلب سريعة — من كتابتك للطلب إلى رؤية النتيجة</title>
  <desc>خط زمني من ست محطات يُقرأ من اليمين لليسار: أنت، نسّاج ديف، المنسّق يفحص، الوكيل ينفّذ، المنسّق يحدّث اللوحة، ثم تعود النتيجة إليك.</desc>
  <defs>
    <marker id="ov2-tip" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(var(--ring))" />
    </marker>
    <linearGradient id="ov2-rail" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="hsl(var(--primary))" />
      <stop offset="1" stop-color="hsl(var(--ring))" />
    </linearGradient>
  </defs>

  <!-- كل المحتوى مُزاح 40 وحدة لضمان هامش داخلي على الحافتين (viewBox 0..960) -->
  <g transform="translate(40,0)">

  <!-- القضيب الزمني (يمين → يسار) -->
  <line x1="70" y1="170" x2="810" y2="170" stroke="url(#ov2-rail)" stroke-width="4" stroke-linecap="round" />
  <path d="M78,170 l14,-6 l0,12 Z" fill="hsl(var(--ring))" />

  <!-- محطة ١: أنت (يمين) -->
  <g transform="translate(810,170)">
    <circle cx="0" cy="0" r="20" fill="hsl(var(--primary))" />
    <text x="0" y="5" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="15" font-weight="800" fill="hsl(var(--primary-foreground))">١</text>
    <g transform="translate(-92,-140)">
      <rect x="0" y="0" width="164" height="86" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <text x="146" y="30" text-anchor="start" font-family="Tajawal, sans-serif" font-size="15" font-weight="800" fill="hsl(var(--card-foreground))">أنت</text>
      <text x="146" y="55" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">تكتب طلباً</text>
      <text x="146" y="73" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">بوضوح وتفصيل</text>
    </g>
    <line x1="0" y1="-20" x2="0" y2="-54" stroke="hsl(var(--border))" stroke-width="1.5" />
  </g>

  <!-- محطة ٢: نسّاج ديف -->
  <g transform="translate(662,170)">
    <circle cx="0" cy="0" r="18" fill="hsl(var(--card))" stroke="hsl(var(--ring))" stroke-width="2.5" />
    <text x="0" y="5" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--foreground))">٢</text>
    <g transform="translate(-82,22)">
      <rect x="0" y="0" width="164" height="80" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <text x="146" y="28" text-anchor="start" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--card-foreground))">نسّاج ديف</text>
      <text x="146" y="52" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">يمرّر الطلب</text>
      <text x="146" y="70" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">للمنسّق</text>
    </g>
    <line x1="0" y1="18" x2="0" y2="42" stroke="hsl(var(--border))" stroke-width="1.5" />
  </g>

  <!-- محطة ٣: المنسّق يفحص -->
  <g transform="translate(514,170)">
    <circle cx="0" cy="0" r="20" fill="hsl(var(--primary))" />
    <text x="0" y="5" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="15" font-weight="800" fill="hsl(var(--primary-foreground))">٣</text>
    <g transform="translate(-84,-134)">
      <rect x="0" y="0" width="168" height="80" rx="12" fill="hsl(var(--primary) / 0.08)" stroke="hsl(var(--primary))" stroke-width="1.5" />
      <text x="150" y="28" text-anchor="start" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--foreground))">المنسّق</text>
      <text x="150" y="52" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">يفحص الحصة</text>
      <text x="150" y="70" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">والموارد</text>
    </g>
    <line x1="0" y1="-20" x2="0" y2="-54" stroke="hsl(var(--border))" stroke-width="1.5" />
  </g>

  <!-- محطة ٤: الوكيل ينفّذ -->
  <g transform="translate(366,170)">
    <circle cx="0" cy="0" r="20" fill="hsl(145 55% 42%)" />
    <text x="0" y="5" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="15" font-weight="800" fill="hsl(0 0% 100%)">٤</text>
    <g transform="translate(-84,22)">
      <rect x="0" y="0" width="168" height="80" rx="12" fill="hsl(145 45% 42% / 0.08)" stroke="hsl(145 50% 42%)" stroke-width="1.5" />
      <text x="150" y="28" text-anchor="start" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--foreground))">وكيل متخصص</text>
      <text x="150" y="52" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">ينفّذ المهمة</text>
      <text x="150" y="70" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">ويختبرها</text>
    </g>
    <line x1="0" y1="20" x2="0" y2="42" stroke="hsl(var(--border))" stroke-width="1.5" />
  </g>

  <!-- محطة ٥: المنسّق يحدّث اللوحة -->
  <g transform="translate(218,170)">
    <circle cx="0" cy="0" r="18" fill="hsl(var(--card))" stroke="hsl(var(--ring))" stroke-width="2.5" />
    <text x="0" y="5" text-anchor="middle" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--foreground))">٥</text>
    <g transform="translate(-84,-134)">
      <rect x="0" y="0" width="168" height="80" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <text x="150" y="28" text-anchor="start" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--card-foreground))">المنسّق</text>
      <text x="150" y="52" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">يحدّث لوحة</text>
      <text x="150" y="70" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">المشروع</text>
    </g>
    <line x1="0" y1="-18" x2="0" y2="-54" stroke="hsl(var(--border))" stroke-width="1.5" />
  </g>

  <!-- محطة ٦: النتيجة (يسار) -->
  <g transform="translate(70,170)">
    <circle cx="0" cy="0" r="20" fill="hsl(var(--ring))" />
    <path d="M-6,0 l4,4 l8,-9" fill="none" stroke="hsl(0 0% 100%)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    <g transform="translate(-76,22)">
      <rect x="0" y="0" width="152" height="80" rx="12" fill="hsl(var(--ring) / 0.12)" stroke="hsl(var(--ring))" stroke-width="1.5" />
      <text x="134" y="30" text-anchor="start" font-family="Tajawal, sans-serif" font-size="14" font-weight="800" fill="hsl(var(--foreground))">أنت</text>
      <text x="134" y="55" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">ترى النتيجة</text>
      <text x="134" y="73" text-anchor="start" font-family="Tajawal, sans-serif" font-size="12" fill="hsl(var(--muted-foreground))">مباشرة</text>
    </g>
    <line x1="0" y1="20" x2="0" y2="42" stroke="hsl(var(--border))" stroke-width="1.5" />
  </g>

  </g>
</svg>

## المصطلحات الأساسية الأربع

| المصطلح | معناه |
|---|---|
| **المشروع** | مجلد عمل (مثل nassaj-dev): فيه الملفات والكود والمهام |
| **الجلسة** | محادثة مستمرة واحدة مع وكيل حول مهمة محددة |
| **لوحة المشروع** | شاشة تلخص حالة المشروع: المراحل والمهام والأخطاء |
| **الوكيل** | متخصص واحد من فريق الأذكياء: مبرمج، مصمم، محلل، إلخ |

## خريطة وصول سريع

**تريد أن تعرف…** **؟ اقرأ…**

| السؤال | الصفحة |
|---|---|
| كيف يعمل نسّاج؟ من ينفّذ؟ ومن الوكلاء الـ23؟ | [نسّاج كور: القلب والقواعد](02-nassaj-core.md) |
| كيف أستخدم الموقع؟ أين أكتب الطلب؟ وأين لوحة المشروع؟ | [نسّاج ديف: الواجهة](03-nassaj-dev.md) |
| ماذا يحدث بعد أن أكتب طلباً؟ كم من الوقت يستغرق؟ | [كيف تجري المهمة من البداية للنهاية](04-how-work-flows.md) |
| سؤالي لم يُجب عليه؟ ابدأ هنا | [أسئلة شائعة](05-faq.md) |
| كلمات غريبة من الموقع؟ ابحث هنا | [المسرد](06-glossary.md) |
| كيف يعمل التنفيذ الذاتي الليلي (المنوال)؟ | [المنوال: المُنفِّذ الذاتي لمشاريع نسّاج](08-minwal.md) |

## كم من الوقت يستغرق فهم كل شيء؟

- **هذا الملف:** ٣ دقائق
- **الملفات الأساسية (نسّاج كور + الواجهة):** ١٠ دقائق
- **المهام والـ FAQ:** ٥ دقائق إضافية

**المجموع: ٢٠ دقيقة** كي تفهم المنظومة كاملة. أو اقفز للصفحة التي تحتاجها مباشرة من الجدول أعلاه.

---

**الترتيب الموصى به:** [نسّاج كور والقواعد](02-nassaj-core.md) ← [نسّاج ديف والواجهة](03-nassaj-dev.md) ← [المهام والعمل](04-how-work-flows.md).
