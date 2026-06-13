import { useTranslation } from 'react-i18next';
import { useClaudeUsage } from '../../../quick-settings-panel/hooks/useClaudeUsage';
import {
  clampUtilization,
  formatPercent,
  formatResetTime,
  usageTextColorClass,
} from '../../../quick-settings-panel/claudeUsageHelpers';
import type { ClaudeUsage } from '../../../quick-settings-panel/claudeUsageTypes';

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
 * Renders nothing on loading / error / all-null windows.
 */
export function ClaudeUsageCollapsed() {
  const { t, i18n } = useTranslation('settings');
  const { status, data } = useClaudeUsage(true);

  if (status !== 'success') return null;

  const visible = WINDOWS.filter(({ key }) => data[key] !== null);
  if (visible.length === 0) return null;

  return (
    <>
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
            className="flex flex-col items-center gap-0.5 py-1"
            title={ariaLabel}
            aria-label={ariaLabel}
          >
            <span className="text-[10px] font-semibold leading-none text-primary">
              {letter}
            </span>
            <span
              className={`text-[9px] leading-none tabular-nums ${usageTextColorClass(clamped)}`}
            >
              {percent}
            </span>
          </div>
        );
      })}
    </>
  );
}
