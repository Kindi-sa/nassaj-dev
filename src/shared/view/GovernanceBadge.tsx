import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { useProviderGovernance } from '../../components/chat/hooks/useProviderGovernance';
import type { LLMProvider } from '../../types/app';

type GovernanceBadgeProps = {
  provider: LLMProvider | undefined | null;
  className?: string;
};

/**
 * Pill badge reflecting the live governance status of the active session's
 * provider (T-900, §المرحلة 3). Three honest states:
 *
 *   governed + enforced=true  → emerald, ShieldCheck, governed label
 *   governed + enforced=false → emerald (muted), ShieldCheck, governed label,
 *                               tooltip "حاضر غير مُنفَّذ / present but not enforced"
 *   ungoverned                → amber, ShieldOff, ungoverned label
 *   null (absent / error)     → renders nothing (fail-HIDDEN, not fail-ungoverned)
 *
 * A11y: role="status", aria-label contains the full tooltip text so screen
 * readers get the explanation without needing to hover. RTL-safe: gap/logical
 * flow only — no left/right overrides needed.
 *
 * Re-fetches only when `provider` changes (MVP cadence per T-900 §4).
 */
export default function GovernanceBadge({ provider, className }: GovernanceBadgeProps) {
  const { t } = useTranslation('common');
  const descriptor = useProviderGovernance(provider);

  if (!descriptor) {
    // Fail-HIDDEN: unknown server state or old endpoint not yet deployed.
    return null;
  }

  if (descriptor.status === 'governed') {
    const tooltipKey = descriptor.enforced
      ? 'governanceBadge.tooltip.enforced'
      : 'governanceBadge.tooltip.present';
    const tooltip = t(tooltipKey);
    const label = t('governanceBadge.governed');

    return (
      <span
        role="status"
        title={tooltip}
        aria-label={`${label} — ${tooltip}`}
        className={cn(
          'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4',
          descriptor.enforced
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
            : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600/70 dark:text-emerald-500/60',
          className,
        )}
      >
        <ShieldCheck className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }

  // status === 'ungoverned'
  const tooltip = t('governanceBadge.tooltip.none');
  const label = t('governanceBadge.ungoverned');

  return (
    <span
      role="status"
      title={tooltip}
      aria-label={`${label} — ${tooltip}`}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4',
        'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        className,
      )}
    >
      <ShieldOff className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
