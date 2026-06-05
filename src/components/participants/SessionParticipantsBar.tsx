import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

import AgentChipRow from './AgentChipRow';
import ParticipantAvatar from './ParticipantAvatar';
import ParticipantAvatarStack from './ParticipantAvatarStack';
import { useSessionParticipants } from './hooks';
import { isOwnerRole } from './utils';

type SessionParticipantsBarProps = {
  sessionId: string | null | undefined;
  className?: string;
};

/** Owner-first, then by recency — same contract as the avatar stack. */
function orderForNames<T extends { role: string; last_seen: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ownerA = isOwnerRole(a.role) ? 1 : 0;
    const ownerB = isOwnerRole(b.role) ? 1 : 0;
    if (ownerA !== ownerB) return ownerB - ownerA;
    return (new Date(b.last_seen).getTime() || 0) - (new Date(a.last_seen).getTime() || 0);
  });
}

/**
 * Wider participants strip shown at the top of an open conversation (F-2).
 *
 * The strip's primary content is the agent/role row (model + subagents),
 * derived from the transcript and fully independent of identity/multi-user.
 * It renders whenever any agents are present. The human-participants block
 * (avatar stack + names) is an *optional, additive* layer that degrades
 * safely to nothing when the identity layer returns no participants — it
 * never gates the bar on its own.
 */
export default function SessionParticipantsBar({ sessionId, className }: SessionParticipantsBarProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const { status, participants, agents, load } = useSessionParticipants(sessionId);

  useEffect(() => {
    if (sessionId) {
      load();
    }
  }, [sessionId, load]);

  if (!sessionId) {
    return null;
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border/60 px-3 py-2 sm:px-4',
          className,
        )}
        aria-hidden
      >
        <span className="h-6 w-6 animate-pulse rounded-full bg-muted/60" />
        <span className="h-3 w-24 animate-pulse rounded bg-muted/40" />
      </div>
    );
  }

  // Agents alone are enough to show the bar; the human-participants block is
  // additive and may be empty. Only hide when there is genuinely nothing to
  // show (no agents AND no participants) or on a hard error.
  const hasAgents = agents.length > 0;
  const hasParticipants = participants.length > 0;
  if (status === 'error' || (!hasAgents && !hasParticipants)) {
    return null;
  }

  const namedUsers = orderForNames(participants).slice(0, 3);
  const extraUsers = participants.length - namedUsers.length;
  const nameSeparator = locale.startsWith('ar') ? '،' : ',';

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-3 py-2 sm:px-4',
        className,
      )}
      role="group"
      aria-label={t('participants.barAria', { defaultValue: 'Conversation participants' })}
    >
      {hasParticipants && (
        <div className="flex items-center gap-2">
          <ParticipantAvatarStack
            participants={participants}
            size="sm"
            max={5}
            locale={locale}
            t={t}
          />
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            {namedUsers.map((user, index) => (
              <span key={user.userId} className="inline-flex items-center">
                {index > 0 && <span className="me-1 opacity-50">{nameSeparator}</span>}
                <span className={cn('font-medium', isOwnerRole(user.role) && 'text-foreground')}>
                  {user.username}
                </span>
              </span>
            ))}
            {extraUsers > 0 && (
              <span className="opacity-70">
                {t('participants.andMore', {
                  count: extraUsers,
                  defaultValue: 'and {{count}} more',
                })}
              </span>
            )}
          </span>
        </div>
      )}

      {hasParticipants && hasAgents && (
        <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
      )}

      {hasAgents && <AgentChipRow agents={agents} max={5} t={t} />}
    </div>
  );
}
