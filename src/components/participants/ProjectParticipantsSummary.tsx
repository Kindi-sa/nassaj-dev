import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';

import ParticipantAvatarStack from './ParticipantAvatarStack';
import { useProjectParticipants } from './hooks';

type ProjectParticipantsSummaryProps = {
  projectId: string;
  locale: string;
  t: TFunction;
  // Lazily fetched; the parent activates this on hover or when expanded.
  active: boolean;
  className?: string;
};

/**
 * Project-level participation line (F-3): "N users · M agents" with a small
 * avatar stack, rendered under the project name. Lazy-loaded.
 */
export default function ProjectParticipantsSummary({
  projectId,
  locale,
  t,
  active,
  className,
}: ProjectParticipantsSummaryProps) {
  const { status, users, agents, load } = useProjectParticipants(projectId);

  useEffect(() => {
    if (active) {
      load();
    }
  }, [active, load]);

  if (!active || status === 'error') {
    return null;
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <span className={cn('mt-0.5 inline-flex items-center gap-1', className)} aria-hidden>
        <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-muted/60" />
        <span className="h-2.5 w-16 animate-pulse rounded bg-muted/40" />
      </span>
    );
  }

  if (users.length === 0 && agents.length === 0) {
    return null;
  }

  const summary = t('participants.projectSummary', {
    users: users.length,
    agents: agents.length,
    defaultValue: '{{users}} users · {{agents}} agents',
  });

  return (
    <span className={cn('mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground', className)}>
      {users.length > 0 && (
        <ParticipantAvatarStack participants={users} size="xs" max={3} locale={locale} t={t} />
      )}
      <span className="truncate">{summary}</span>
    </span>
  );
}
