import type { LLMProvider } from '../../../types/app';
import type { PermissionMode } from '../types/types';

/**
 * T-904 (روح ADR-047، م0) — واصف قدرات واجهة المُؤلِّف لكل مزوّد. المصدر
 * الوحيد المعتمد لكل "provider === 'x'" التي كانت مبعثرة في ChatComposer.tsx
 * و useChatProviderState.ts. القيم أدناه تُعيد سلوك اليوم حرفياً 1:1 — هذا
 * الملف لا يغيّر أي سلوك بذاته، فقط يجمع الشروط القائمة في مكان واحد.
 *
 * القاعدة الحاكمة (قرار المالك T-904): يُستهلك عبر `displayProvider` (مزوّد
 * الجلسة المفتوحة = selectedSession?.__provider ?? provider العام) لا
 * `provider` العام وحده، فتبقى أدوات جلسة claude ثابتة مهما تغيّر الاختيار
 * العام؛ الاختيار العام يؤثّر فقط على جلسة جديدة (لا selectedSession بعد).
 *
 * نطاق T-904: effort/tokenCounter/command.supportsImages/permissions/quota
 * فقط (ما تستهلكه ChatComposer/useChatProviderState/أشرطة الحصة). تعميم
 * مكافئات هرمز الفعلية (reasoning_effort حقيقي، حصة حيّة…) مؤجَّل لما بعد
 * T-905 — لا تُستنتج هنا قيم "true" غير مثبتة خادمياً اليوم.
 *
 * T-905 يضيف حقلين فقط: effort.modes (مجموعة فرعية اختيارية من هويّات
 * effortModes حين لا يطابق المزوّد مجموعة claude الكاملة) وposture.supported
 * (زر معلومات السقف الفعلي — sandbox/شبكة — بجانب زرّ وضع الأذونات؛ codex
 * فقط اليوم لأنه المزوّد الوحيد ذو سقف قابل للتباين الفعلي بين الأوضاع).
 */

export interface ProviderUiCapabilities {
  /** مطابق للقيمة الممرَّرة — يبقى كما هي حتى لمزوّد غير معروف. */
  id: string;
  /**
   * اسم عرض إنجليزي مختصر (تسمية تقنية، ليس نصاً مترجَماً). يُستهلك عبر
   * getProviderDisplayName المصدَّرة أدناه في أربعة مواضع (T-224 م0):
   * ProviderSelectionEmptyState، وChatInterface×2، وMessageComponent.
   * المزوّدات غير المُدرَجة تعرض اسمها الخام (لا «Claude») عبر safeFallbackCapabilities.
   */
  displayName: string;
  /**
   * منتقي التفكير/الجهد (ThinkingModeSelector + شارة ULTRACODE). `modes`
   * (اختياري) يحصر القائمة على هويّات effortModes بعينها — غيابه يعني القائمة
   * الكاملة (سلوك claude الحالي بلا تغيير). عند supported=false يُتجاهل modes.
   */
  effort: { supported: boolean; modes?: string[] };
  /** عدّاد التوكنز/تعفّن السياق (TokenUsageSummary). */
  tokenCounter: { supported: boolean };
  /** شكل أمر الإرسال ذو الصلة بالمُؤلِّف (تلميح إرفاق الملفات/الصور). */
  command: { supportsImages: boolean };
  /** أوضاع الأذونات المتاحة فعلياً لهذا المزوّد (getPermissionModesForProvider سابقاً). */
  permissions: { modes: PermissionMode[] };
  /** هل أشرطة حصة C/W/S/O (حساب Claude) تطابق مزوّد هذه الجلسة فعلياً. */
  quota: { isClaudeAccount: boolean };
  /** زرّ معلومات سقف الـsandbox/الشبكة الفعلي بجانب زرّ وضع الأذونات (T-894/T-905). */
  posture: { supported: boolean };
  /**
   * قناة «/btw» الجانبية (T-849): سؤال جانبي على سياق الجلسة يُنفَّذ خادمياً
   * كجلسة SDK مفروكة (fork) وتُعرض إجابته في overlay — بلا مساس بالبث الجاري ولا
   * بسجل المحادثة. claude وحده true اليوم (المزوّد الوحيد ذو آلية الفرك)؛ غيره
   * false فلا يتفعّل استثناء الإرسال أثناء البث ولا اعتراض التوجيه.
   */
  sideChannel: { supported: boolean };
}

// المجموعة الافتراضية لأي مزوّد لم يُخصَّص له سلوك أذونات خاص — مطابقة
// حرفياً لفرع else في getPermissionModesForProvider الأصلية.
const DEFAULT_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
];

/**
 * سقوط آمن لمزوّد غير مُدرَج في PROVIDER_UI_CAPABILITIES (مزوّد مستقبلي، أو
 * قيمة displayProvider نصّية غير متوقّعة إذ النوع في ChatComposer هو
 * `Provider | string`): كل القدرات الحسّاسة false/none، ما عدا الأذونات التي
 * تبقى مجموعة صالحة غير فارغة (['default']) كي لا يتعطّل دوّار الأذونات.
 */
function safeFallbackCapabilities(id: string): ProviderUiCapabilities {
  return {
    id,
    displayName: id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Unknown',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: ['default'] },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  };
}

// claude محايد حرفياً (بوابة الحياد AC-0.1 من PLAN-v1 §9/م0): القيم أدناه
// تُعيد سلوك اليوم بلا أي انحراف بصري أو سلوكي.
export const PROVIDER_UI_CAPABILITIES: Record<LLMProvider, ProviderUiCapabilities> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    effort: { supported: true },
    tokenCounter: { supported: true },
    command: { supportsImages: true },
    permissions: {
      modes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    },
    quota: { isClaudeAccount: true },
    posture: { supported: false },
    // T-849: القناة الجانبية «/btw» — claude وحده يملك آلية الفرك (fork) اليوم.
    sideChannel: { supported: true },
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    // T-905: يفعّل ThinkingModeSelector للـcodex بمجموعة فرعية بلا max/ultracode
    // (لا مقابل لهما في ModelReasoningEffort). 'none' يبقى مضمَّناً — يعني حذف
    // الحقل فيُترك للجهد الافتراضي config.toml (medium)، مطابقاً معنى claude.
    effort: { supported: true, modes: ['none', 'low', 'medium', 'high', 'xhigh'] },
    tokenCounter: { supported: true },
    command: { supportsImages: false },
    permissions: { modes: ['default', 'acceptEdits', 'bypassPermissions'] },
    quota: { isClaudeAccount: false },
    // T-894/T-905: زرّ معلومات السقف الفعلي (sandbox/شبكة) بجانب زرّ وضع
    // الأذونات — codex وحده اليوم لأن نصوصه القديمة كانت تُضلِّل (ADR-058/T-884).
    posture: { supported: true },
    sideChannel: { supported: false },
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    effort: { supported: false },
    tokenCounter: { supported: true },
    command: { supportsImages: false },
    permissions: { modes: ['default'] },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  antigravity: {
    id: 'antigravity',
    displayName: 'Antigravity (agy)',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes (Nous)',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    // T-224 (م1): hermes -z يتجاوز الأذونات خادمياً (server/hermes-cli.js:179-181)
    // فالدوّار يبقى أحادياً — المستخدم يرى زرّ أذونات واحداً ثابتاً لا يدور.
    permissions: { modes: ['default'] },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  glm: {
    id: 'glm',
    displayName: 'GLM',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
  sakana: {
    id: 'sakana',
    displayName: 'Sakana',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
  },
};

/**
 * القارئ الوحيد المعتمد للواصف. خالصة (بلا I/O ولا حالة داخلية) — مذكِّرها
 * موقع الاستهلاك عبر useMemo عند اللزوم. تقبل أي نص (وليس فقط LLMProvider)
 * لأن `displayProvider`/`provider` في ChatComposer مطبوعان `Provider | string`؛
 * قيمة فارغة/غير معروفة تسقط بأمان (راجع التعليق أعلى safeFallbackCapabilities).
 */
export function getProviderCapabilities(
  provider: string | null | undefined,
): ProviderUiCapabilities {
  const key = provider || 'claude';
  return PROVIDER_UI_CAPABILITIES[key as LLMProvider] ?? safeFallbackCapabilities(key);
}

/**
 * T-224 (م0) — اسم العرض الكانوني للمزوّد. مصدر الحقيقة الوحيد بديلاً عن:
 *   - getProviderDisplayName المحلية في ProviderSelectionEmptyState.tsx
 *   - الترناريات المكرّرة في ChatInterface.tsx وMessageComponent.tsx
 *
 * مزوّد معروف → displayName من الواصف.
 * مزوّد غير معروف → اسمه الخام (الحرف الأول كبير) لا «Claude».
 * لا يُترجَم: هذه أسماء تقنية ثابتة (Claude API، Hermes، Kimi…).
 */
export function getProviderDisplayName(provider: string | null | undefined): string {
  return getProviderCapabilities(provider).displayName;
}
