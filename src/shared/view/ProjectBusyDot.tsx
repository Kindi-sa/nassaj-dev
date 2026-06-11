import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { useAnySessionProcessing } from '../../stores/sessionProcessStateStore';

type ProjectBusyDotProps = {
  /** Ids of the project's (loaded) sessions — the dot shows while any is running. */
  sessionIds: ReadonlyArray<string | null | undefined>;
  className?: string;
};

/**
 * Small pulsing dot shown next to a project's name in the sidebar while any
 * of its sessions has a live provider run (processing/streaming). Same data
 * source as SessionProcessBadge — the global sessionProcessStateStore fed by
 * the server's /proc monitor `process_state` broadcasts — so it appears and
 * disappears in lockstep with the per-session "Running" badge.
 *
 * Renders nothing when idle. Colors match the running badge (green-500 works
 * on both light and dark themes); layout is flex/gap-based so RTL needs no
 * overrides.
 */
export default function ProjectBusyDot({ sessionIds, className }: ProjectBusyDotProps) {
  const { t } = useTranslation('common');
  const busy = useAnySessionProcessing(sessionIds);

  if (!busy) {
    return null;
  }

  return (
    <span
      role="status"
      aria-label={t('sessionProcessState.projectBusyHint')}
      title={t('sessionProcessState.projectBusyHint')}
      className={cn('relative inline-flex h-2 w-2 flex-shrink-0', className)}
    >
      <span className="absolute inset-0 animate-ping rounded-full bg-green-500/60" aria-hidden="true" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />
    </span>
  );
}
