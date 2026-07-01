import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useClaudeUsage } from '../../../quick-settings-panel/hooks/useClaudeUsage';
import {
  clampUtilization,
  formatPercent,
  formatResetTime,
  usageTextColorClass,
} from '../../../quick-settings-panel/claudeUsageHelpers';
import type { ClaudeUsage } from '../../../quick-settings-panel/claudeUsageTypes';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';

// ---------------------------------------------------------------------------
// useMediaQuery — tiny hook that tracks a CSS media query result reactively.
// Mirrors the matchMedia listener pattern from src/hooks/useDeviceSettings.ts.
// ---------------------------------------------------------------------------
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);

    // Sync once on mount in case the value changed between render and effect.
    setMatches(mq.matches);

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }

    // Fallback for older browsers.
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, [query]);

  return matches;
}

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
}

export default function HeaderUsageIndicator({ tabsMode }: HeaderUsageIndicatorProps) {
  const { i18n, t } = useTranslation('settings');
  const { preferences } = useUiPreferences();

  // In icon-only mode the tab bar is narrower, so indicators fit at a lower
  // breakpoint. In normal mode keep the original xl (1280px) threshold.
  const minWidth = preferences.tabsIconOnly ? 900 : 1280;
  const isWide = useMediaQuery(`(min-width: ${minWidth}px)`);

  const usageState = useClaudeUsage(isWide);

  // "hidden" mode suppresses both the tab bar and the usage indicator together.
  // "minimal" mode hides only the tab bar — the indicator stays visible. All
  // other modes (full/compact/undefined) follow the normal width-based guard below.
  if (tabsMode === 'hidden') return null;

  if (!isWide) return null;

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

  return (
    <div
      // JS guard above is the primary visibility control; inline flex here since
      // the breakpoint is dynamic (900px or 1280px depending on tabsIconOnly).
      className="flex items-center gap-3 flex-shrink-0 select-none"
      aria-label={t('claudeUsage.title')}
    >
      {items.map(({ letter, clamped, resetsAt }) => {
        const percent = formatPercent(clamped, i18n.language);
        const colorClass = usageTextColorClass(clamped);
        // Resolve the human-readable window label for aria/title.
        const windowKey = WINDOWS.find((w) => w.letter === letter)!.key;
        const label = t(`claudeUsage.windows.${windowKey}`);
        // Build tooltip: show reset time when available, label-only otherwise.
        const resetText = formatResetTime(resetsAt, i18n.language);
        const tooltip = resetText
          ? `${label} — ${t('claudeUsage.resetsIn', { time: resetText })}`
          : label;
        // aria-label carries both the percentage and optional reset time so
        // screen-reader users receive the full context (the percentage is
        // visually rendered but the tooltip alone omits it when no reset time
        // is present, and even with it the percentage is buried).
        const ariaLabel = resetText
          ? `${label}: ${percent} — ${t('claudeUsage.resetsIn', { time: resetText })}`
          : `${label}: ${percent}`;

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
