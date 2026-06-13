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

// ---------------------------------------------------------------------------
// useMediaQuery — copied from HeaderUsageIndicator; tracks matchMedia reactively.
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

type WindowEntry = {
  letter: string;
  key: keyof Pick<
    ClaudeUsage,
    'session' | 'weeklyAllModels' | 'weeklySonnet' | 'weeklyOpus'
  >;
};

const WINDOWS: WindowEntry[] = [
  { letter: 'C', key: 'session' },
  { letter: 'W', key: 'weeklyAllModels' },
  { letter: 'S', key: 'weeklySonnet' },
  { letter: 'O', key: 'weeklyOpus' },
];

/**
 * Collapsed-rail variant for Claude usage windows.
 * Mirrors the style of SystemStatsCollapsed: tiny vertical stacks.
 *
 * Renders only on narrow viewports (<1280px) where HeaderUsageIndicator is
 * hidden. On wide viewports (≥1280px) the header already shows this data, so
 * we return null to avoid duplication. A CSS double-guard (xl:hidden) is also
 * applied to cover any SSR/hydration timing gap.
 *
 * Renders nothing on loading / error / all-null windows.
 */
export function ClaudeUsageCollapsed() {
  // All hooks must be called unconditionally before any conditional return.
  const { t, i18n } = useTranslation('settings');
  const { status, data } = useClaudeUsage(true);
  // Complementary to HeaderUsageIndicator's (min-width: 1280px) guard.
  const isNarrow = useMediaQuery('(max-width: 1279px)');

  // On wide viewports the header already shows usage — skip rendering here.
  if (!isNarrow) return null;

  if (status !== 'success') return null;

  const visible = WINDOWS.filter(({ key }) => data[key] !== null);
  if (visible.length === 0) return null;

  return (
    // CSS double-guard: JS hides on wide viewports; xl:hidden covers any
    // SSR/hydration timing gap. flex flex-col items-center matches the
    // surrounding rail layout so the div is transparent to positioning.
    <>
    <div className="nav-divider my-1 w-6 xl:hidden" />
    <div className="flex flex-col items-center xl:hidden">
      {visible.map(({ letter, key }) => {
        const window = data[key]!;
        const clamped = clampUtilization(window.utilization);
        const percent = formatPercent(clamped, i18n.language);
        const windowLabel = t(`claudeUsage.windows.${key}`);
        const resetText = formatResetTime(window.resetsAt, i18n.language);
        const resetSuffix = resetText
          ? ` — ${t('claudeUsage.resetsIn', { time: resetText })}`
          : '';
        const ariaLabel = `${windowLabel}: ${percent}${resetSuffix}`;

        return (
          <div
            key={key}
            className="flex flex-col items-center gap-1 py-1"
            title={ariaLabel}
            aria-label={ariaLabel}
          >
            <span className="text-xs font-semibold leading-none text-primary">
              {letter}
            </span>
            <span
              className={`text-[11px] leading-none tabular-nums ${usageTextColorClass(clamped)}`}
            >
              {percent}
            </span>
          </div>
        );
      })}
    </div>
    </>
  );
}
