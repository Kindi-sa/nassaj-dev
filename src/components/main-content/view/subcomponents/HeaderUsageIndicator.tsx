import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useClaudeUsage } from '../../../quick-settings-panel/hooks/useClaudeUsage';
import {
  clampUtilization,
  formatPercent,
  usageTextColorClass,
} from '../../../quick-settings-panel/claudeUsageHelpers';
import type { ClaudeUsage } from '../../../quick-settings-panel/claudeUsageTypes';

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
export default function HeaderUsageIndicator() {
  const { i18n, t } = useTranslation('settings');

  // Only fetch and render when the viewport is at least xl (1280px).
  const isWide = useMediaQuery('(min-width: 1280px)');

  const usageState = useClaudeUsage(isWide);

  // Hide on narrow viewports (CSS guard via hidden xl:flex is the primary
  // mechanism; this JS guard stops any rendering work entirely).
  if (!isWide) return null;

  // Silent during loading / error — keep the header clean.
  if (usageState.status !== 'success') return null;

  const { data } = usageState;

  // Build the list of windows that actually have data.
  const items = WINDOWS.flatMap(({ letter, key }) => {
    const win = data[key];
    if (win === null) return [];
    const clamped = clampUtilization(win.utilization);
    return [{ letter, clamped }];
  });

  // Nothing to show — all windows are null.
  if (items.length === 0) return null;

  return (
    <div
      // CSS double-guard: JS hides on narrow, CSS hides in case of SSR/hydration mismatch.
      className="hidden xl:flex items-center gap-3 flex-shrink-0 select-none"
      aria-label={t('claudeUsage.title')}
    >
      {items.map(({ letter, clamped }) => {
        const percent = formatPercent(clamped, i18n.language);
        const colorClass = usageTextColorClass(clamped);
        // Resolve the human-readable window label for aria/title.
        const windowKey = WINDOWS.find((w) => w.letter === letter)!.key;
        const label = t(`claudeUsage.windows.${windowKey}`);

        return (
          <span
            key={letter}
            className="flex items-baseline gap-0.5 text-xs"
            title={`${label}: ${percent}`}
            aria-label={`${label}: ${percent}`}
          >
            <span className="font-semibold text-primary">{letter}</span>
            <span className={`tabular-nums ${colorClass}`}>{percent}</span>
          </span>
        );
      })}
    </div>
  );
}
