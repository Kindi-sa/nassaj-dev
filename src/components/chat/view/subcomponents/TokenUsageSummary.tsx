import { useTranslation } from 'react-i18next';
import { ActivityIcon } from 'lucide-react';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
};

// --- Configurable context-rot tuning ------------------------------------------------
// The effective context window is shorter than the model's nominal window because
// attention degrades ("context rot") well before the real limit is reached.
const EFFECTIVE_CONTEXT_FACTOR = 0.6; // sole knob for the color level only

// Color-level thresholds (share of the *effective* window via rotRatio).
const ATTENTION = 0.3; // >= here: start paying attention (yellow)
const WARNING = 0.5; // >= here: possible degradation (orange)
const CRITICAL = 0.7; // >= here: severe degradation (red)
// ------------------------------------------------------------------------------------

type RotLevel = 'safe' | 'attention' | 'warning' | 'critical';

const LEVEL_BAR_CLASS: Record<RotLevel, string> = {
  safe: 'bg-emerald-500',
  attention: 'bg-amber-500',
  warning: 'bg-orange-500',
  critical: 'bg-red-500',
};

// Border/text accent classes per level (dark-mode aware via the palette).
const LEVEL_ACCENT_CLASS: Record<RotLevel, string> = {
  safe: 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
  attention: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  warning: 'border-orange-500/40 text-orange-600 dark:text-orange-400',
  critical: 'border-red-500/50 text-red-600 dark:text-red-400',
};

// Tinted icon-chip background per level.
const LEVEL_CHIP_CLASS: Record<RotLevel, string> = {
  safe: 'bg-emerald-500/10',
  attention: 'bg-amber-500/10',
  warning: 'bg-orange-500/10',
  critical: 'bg-red-500/10',
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const levelFromRatio = (ratio: number): RotLevel => {
  if (ratio >= CRITICAL) return 'critical';
  if (ratio >= WARNING) return 'warning';
  if (ratio >= ATTENTION) return 'attention';
  return 'safe';
};

export default function TokenUsageSummary({ usage }: TokenUsageSummaryProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;

  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? (usage.breakdown as Record<string, unknown>)
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  const totalTokens = readUsageNumber(usage?.total);
  const cacheRead = readUsageNumber(breakdown?.cacheRead);

  const hasWindow = totalTokens > 0 && Number.isFinite(totalTokens);

  // --- Neutral / empty state: no valid window, render a plain badge (as before) ----
  if (!hasWindow) {
    return (
      <div
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground sm:gap-2 sm:px-2.5"
        title={usedTokens > 0 ? `${usedTokens.toLocaleString(locale)}` : t('contextRot.empty')}
      >
        <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
          <ActivityIcon className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
        <span className="hidden text-muted-foreground/70 sm:inline">{t('contextRot.label')}</span>
      </div>
    );
  }

  // Displayed percentage / bar / number = raw occupancy of the real window.
  const rawRatio = clamp01(usedTokens / totalTokens);
  // Color level = context-rot signal: raw occupancy of the *effective* window
  // (shorter than nominal because attention degrades before the real limit).
  const rotRatio = clamp01(usedTokens / (totalTokens * EFFECTIVE_CONTEXT_FACTOR));
  const level = levelFromRatio(rotRatio);
  const percentValue = rawRatio * 100;
  const percentLabel = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(rawRatio);

  // Multi-line native tooltip (RTL-friendly, dependency-free).
  const tooltipLines = [
    t('contextRot.levels.' + level),
    t('contextRot.tooltipUsed', {
      used: usedTokens.toLocaleString(locale),
      total: totalTokens.toLocaleString(locale),
    }),
    cacheRead > 0
      ? t('contextRot.tooltipCacheRead', { value: cacheRead.toLocaleString(locale) })
      : null,
  ].filter(Boolean);

  return (
    <div
      className={`inline-flex h-9 items-center gap-1.5 rounded-lg border bg-background/70 px-2 text-xs shadow-sm transition-colors sm:gap-2 sm:px-2.5 ${LEVEL_ACCENT_CLASS[level]}`}
      title={tooltipLines.join('\n')}
      role="img"
      aria-label={t('contextRot.percentUsed', { percent: percentLabel })}
    >
      <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md ${LEVEL_CHIP_CLASS[level]}`}>
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>

      {/* Progress bar — flex fill mirrors automatically under RTL/LTR. */}
      <div
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-border/60 sm:w-20"
        role="progressbar"
        aria-hidden="true"
        aria-valuenow={Math.round(percentValue)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width,background-color] duration-500 ease-out ${LEVEL_BAR_CLASS[level]}`}
          style={{ width: `${percentValue}%` }}
        />
      </div>

      <span className="font-medium tabular-nums text-foreground">{percentLabel}</span>
      <span className="hidden tabular-nums text-muted-foreground/70 sm:inline">
        {formatTokenCount(usedTokens)} / {formatTokenCount(totalTokens)}
      </span>
    </div>
  );
}
