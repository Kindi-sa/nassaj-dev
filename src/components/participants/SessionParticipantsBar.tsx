import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../../shared/view/ui';

import AgentChipRow from './AgentChipRow';
import ParticipantAvatar from './ParticipantAvatar';
import ParticipantAvatarStack from './ParticipantAvatarStack';
import { useSessionParticipants } from './hooks';
import type { SessionParticipant } from './types';
import { isOwnerRole } from './utils';

type SessionParticipantsBarProps = {
  sessionId: string | null | undefined;
  className?: string;
  /**
   * users.id of the coordinator who launched the latest/streaming run (the
   * brother speaking *now*), derived from the most recent assistant message's
   * `coordinatorId`. `null`/undefined = no active speaker resolved yet; the bar
   * then renders the flat roster without an active-speaker highlight.
   */
  activeCoordinatorId?: number | null;
  /** Collapse the bar (inline chevron control); the host renders a matching expand chevron. */
  onHide?: () => void;
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
 *
 * When an `activeCoordinatorId` is supplied and resolves to a known
 * participant, that brother is pulled out and rendered as a prominent
 * "speaking now" chip (bright, with a pulsing live dot), while the remaining
 * participants are demoted to a dimmed secondary cluster — so viewers can tell
 * at a glance WHO is replying right now versus who merely joined earlier. The
 * viewer is never assumed to be the active coordinator.
 */
export default function SessionParticipantsBar({
  sessionId,
  className,
  activeCoordinatorId,
  onHide,
}: SessionParticipantsBarProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const { status, participants, agents, load } = useSessionParticipants(sessionId);

  useEffect(() => {
    if (sessionId) {
      load();
    }
  }, [sessionId, load]);

  // Split the roster into the active speaker (matched by coordinatorId) and the
  // rest. Memoised so the avatar stack / name list keep stable references.
  const { activeParticipant, restParticipants } = useMemo(() => {
    if (activeCoordinatorId == null) {
      return { activeParticipant: null as SessionParticipant | null, restParticipants: participants };
    }
    const active = participants.find((p) => String(p.userId) === String(activeCoordinatorId)) ?? null;
    if (!active) {
      return { activeParticipant: null as SessionParticipant | null, restParticipants: participants };
    }
    return {
      activeParticipant: active,
      restParticipants: participants.filter((p) => String(p.userId) !== String(activeCoordinatorId)),
    };
  }, [participants, activeCoordinatorId]);

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

  const namedRest = orderForNames(restParticipants).slice(0, activeParticipant ? 2 : 3);
  const extraUsers = restParticipants.length - namedRest.length;
  const nameSeparator = locale.startsWith('ar') ? '،' : ',';
  const activeLabel = activeParticipant
    ? t('participants.activeCoordinator', {
        username: activeParticipant.username,
        defaultValue: 'Active now: {{username}}',
      })
    : '';

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-3 py-2 sm:px-4',
        className,
      )}
      role="group"
      aria-label={t('participants.barAria', { defaultValue: 'Conversation participants' })}
    >
      {/* Active speaker: the brother replying right now — bright chip with a
        * pulsing live dot, visually dominant over the demoted roster. */}
      {activeParticipant && (
        <div
          className="flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 ps-1 pe-2.5 py-0.5"
          aria-label={activeLabel}
        >
          <span className="relative flex h-2 w-2 flex-shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <ParticipantAvatar
            participant={activeParticipant}
            size="sm"
            locale={locale}
            t={t}
            stacked={false}
            avatarUrl={activeParticipant.avatarUrl ?? undefined}
            ariaLabel={activeLabel}
          />
          <span className="flex flex-col leading-tight">
            <span className="text-[10px] font-medium uppercase tracking-wide text-primary/80">
              {t('participants.activeNow', { defaultValue: 'Active now' })}
            </span>
            <span className="text-xs font-semibold text-foreground" dir="auto">
              {activeParticipant.username}
            </span>
          </span>
        </div>
      )}

      {/* Demoted roster: everyone who joined earlier but is not speaking now —
        * dimmed so it reads as secondary to the active speaker. */}
      {restParticipants.length > 0 && (
        <div className={cn('flex items-center gap-2', activeParticipant && 'opacity-60')}>
          <ParticipantAvatarStack
            participants={restParticipants}
            size="sm"
            max={5}
            locale={locale}
            t={t}
          />
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            {namedRest.map((user, index) => (
              <span key={user.userId} className="inline-flex items-center">
                {index > 0 && <span className="me-1 opacity-50">{nameSeparator}</span>}
                <span className={cn('font-medium', isOwnerRole(user.role) && 'text-foreground/90')}>
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

      {onHide && (
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
          onClick={onHide}
          aria-label={t('participants.hide', { defaultValue: 'Hide participants bar' })}
          title={t('participants.hide', { defaultValue: 'Hide participants bar' })}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
