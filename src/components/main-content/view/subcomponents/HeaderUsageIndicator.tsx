import { useTranslation } from 'react-i18next';
import { useClaudeUsage } from '../../../quick-settings-panel/hooks/useClaudeUsage';
import {
  clampUtilization,
  formatPercent,
  formatResetTime,
  usageTextColorClass,
} from '../../../quick-settings-panel/claudeUsageHelpers';
import type { ClaudeUsage } from '../../../quick-settings-panel/claudeUsageTypes';
import { getProviderCapabilities } from '../../../chat/constants/providerCapabilities';

// ---------------------------------------------------------------------------
// Window definitions — order determines display order.
// ---------------------------------------------------------------------------
type WindowKey = keyof Pick<
  ClaudeUsage,
  'session' | 'weeklyAllModels' | 'weeklySonnet' | 'weeklyOpus'
>;

const WINDOWS: { letter: string; key: WindowKey }[] = [
  { letter: 'C', key: 'session' },
  { letter: 'W', key: 'weeklyAllModels' },
  { letter: 'S', key: 'weeklySonnet' },
  { letter: 'O', key: 'weeklyOpus' },
];

// ---------------------------------------------------------------------------
// HeaderUsageIndicator
// ---------------------------------------------------------------------------
interface HeaderUsageIndicatorProps {
  tabsMode?: 'full' | 'compact' | 'minimal' | 'hidden';
  /**
   * مزوّد الجلسة المفتوحة حالياً (selectedSession?.__provider). أشرطة الحصة
   * تبقى بيانات حساب Claude دوماً (T-5) — لا تُحجَب حين الجلسة ليست claude،
   * لكنها تُوسَم بذلك صراحةً كي لا تُفهَم خطأً كبيانات مزوّد الجلسة الحالية.
   */
  sessionProvider?: string | null;
}

export default function HeaderUsageIndicator({ tabsMode, sessionProvider }: HeaderUsageIndicatorProps) {
  const { i18n, t } = useTranslation('settings');
  const isClaudeSession = getProviderCapabilities(sessionProvider).quota.isClaudeAccount;

  // Visible at any viewport width in every mode except "hidden". A previous
  // version gated this on a 900px/1280px width query to protect room for the
  // tab bar, but that guard fired regardless of tabsMode — including on
  // mobile, where the indicator disappeared even though the tab bar itself
  // scrolls/truncates on narrow screens instead of needing the guard. The tab
  // bar's own layout (overflow-x-auto) handles narrow viewports; the indicator
  // no longer needs a width gate of its own.
  const isWide = tabsMode !== 'hidden';

  const usageState = useClaudeUsage(isWide);

  // "hidden" mode is the only mode that suppresses the indicator (together
  // with the tab bar). full/compact/minimal all keep it visible regardless of
  // viewport width — the tab bar itself scrolls/truncates on narrow screens
  // instead of the indicator being width-gated.
  if (tabsMode === 'hidden') return null;

  // Silent during loading / error — keep the header clean.
  if (usageState.status !== 'success') return null;

  const { data } = usageState;

  // Build the list of windows that actually have data.
  const items = WINDOWS.flatMap(({ letter, key }) => {
    const win = data[key];
    if (win === null) return [];
    const clamped = clampUtilization(win.utilization);
    return [{ letter, clamped, resetsAt: win.resetsAt }];
  });

  // Nothing to show — all windows are null.
  if (items.length === 0) return null;

  // T-5: the indicator always reflects the Claude ACCOUNT's usage (the API has
  // no per-provider quota concept), never hidden for a non-claude session —
  // but a non-claude session gets an explicit disambiguation note so it never
  // reads as "this session's" quota.
  const crossProviderNote = !isClaudeSession
    ? t('claudeUsage.crossProviderNote', {
        provider: getProviderCapabilities(sessionProvider).displayName,
      })
    : null;

  return (
    <div
      className="flex items-center gap-3 flex-shrink-0 select-none"
      aria-label={crossProviderNote ? `${t('claudeUsage.title')} — ${crossProviderNote}` : t('claudeUsage.title')}
      title={crossProviderNote ?? undefined}
    >
      {items.map(({ letter, clamped, resetsAt }) => {
        const percent = formatPercent(clamped, i18n.language);
        const colorClass = usageTextColorClass(clamped);
        // Resolve the human-readable window label for aria/title.
        const windowKey = WINDOWS.find((w) => w.letter === letter)!.key;
        const label = t(`claudeUsage.windows.${windowKey}`);
        // Build tooltip: show reset time when available, label-only otherwise,
        // plus the cross-provider disambiguation note when relevant (T-5).
        const resetText = formatResetTime(resetsAt, i18n.language);
        const baseTooltip = resetText
          ? `${label} — ${t('claudeUsage.resetsIn', { time: resetText })}`
          : label;
        const tooltip = crossProviderNote ? `${baseTooltip} — ${crossProviderNote}` : baseTooltip;
        // aria-label carries both the percentage and optional reset time so
        // screen-reader users receive the full context (the percentage is
        // visually rendered but the tooltip alone omits it when no reset time
        // is present, and even with it the percentage is buried).
        const baseAriaLabel = resetText
          ? `${label}: ${percent} — ${t('claudeUsage.resetsIn', { time: resetText })}`
          : `${label}: ${percent}`;
        const ariaLabel = crossProviderNote ? `${baseAriaLabel} — ${crossProviderNote}` : baseAriaLabel;

        return (
          <span
            key={letter}
            className="flex items-baseline gap-0.5 text-xs"
            title={tooltip}
            aria-label={ariaLabel}
          >
            <span className="font-semibold text-primary">{letter}</span>
            <span className={`tabular-nums ${colorClass}`}>{percent}</span>
          </span>
        );
      })}
    </div>
  );
}
