import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/context/AuthContext';
import { cn } from '../../lib/utils';
import ParticipantAvatar from '../participants/ParticipantAvatar';
import type { SessionParticipant } from '../participants/types';
import { Tooltip } from '../../shared/view/ui';

import { usePresence, type PresenceUser } from './usePresence';

/**
 * Live presence panel (C-MU-UX-PRESENCE, compact redesign
 * C-MU-UX-PRESENCE-COMPACT).
 *
 * One dense row instead of one card per brother: a tiny "Online now" label +
 * an overlapping avatar stack. Who is connected and what they are doing moved
 * into each avatar's tooltip (username, "(you)", "Working on: <project>" or
 * "Idle"), so the sidebar loses almost no information but a lot of height.
 *
 * - Avatars: shared ParticipantAvatar with a presence-specific tooltip.
 * - Status dot: emerald = online; it pulses while the brother is actively
 *   running a provider command (the tooltip names the project/session).
 * - More than MAX_VISIBLE brothers collapse into a "+N" chip whose tooltip
 *   lists the hidden ones with the same status line.
 * - RTL-friendly: logical spacing only (`-ms-*`), no hard-coded left/right.
 * - Renders nothing until the first snapshot arrives.
 */

/** How many avatars to show before collapsing the rest behind "+N". */
const MAX_VISIBLE = 5;

/** Last path segment of a project path, for a compact "working on" label. */
function projectLabel(projectPath: string | null, sessionId: string | null): string | null {
  if (projectPath) {
    const trimmed = projectPath.replace(/[/\\]+$/, '');
    const segments = trimmed.split(/[/\\]+/).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) {
      return last;
    }
  }
  if (sessionId) {
    // Fall back to a short session id fragment so there is always a hint.
    return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
  }
  return null;
}

/**
 * Adapts a presence entry to the minimal SessionParticipant shape the shared
 * ParticipantAvatar expects (it reads userId/username/role plus the optional
 * profile picture for rendering).
 */
function toParticipant(user: PresenceUser): SessionParticipant {
  return {
    userId: user.userId,
    username: user.username,
    role: 'user',
    first_seen: '',
    last_seen: '',
    message_count: 0,
    avatarUrl: user.avatarUrl,
  };
}

export default function PresencePanel() {
  const { t, i18n } = useTranslation('presence');
  const { user: currentUser } = useAuth();
  const presenceUsers = usePresence();

  if (presenceUsers.length === 0) {
    return null;
  }

  const currentUserId = currentUser?.id !== undefined && currentUser?.id !== null
    ? String(currentUser.id)
    : null;

  /** "Working on: <target>" while active, "Idle" otherwise. */
  const statusText = (presenceUser: PresenceUser): string => {
    const working = presenceUser.active
      ? projectLabel(presenceUser.activeProjectPath, presenceUser.activeSessionId)
      : null;
    return working
      ? t('workingOn', { defaultValue: 'Working on: {{target}}', target: working })
      : t('idle', { defaultValue: 'Idle' });
  };

  /** "<username> (you)" for self, plain username otherwise. */
  const displayName = (presenceUser: PresenceUser): string => {
    const isSelf = currentUserId !== null && presenceUser.userId === currentUserId;
    return isSelf
      ? `${presenceUser.username} ${t('you', { defaultValue: '(you)' })}`
      : presenceUser.username;
  };

  const visible = presenceUsers.slice(0, MAX_VISIBLE);
  const overflow = presenceUsers.slice(MAX_VISIBLE);

  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t('title', { defaultValue: 'Online now' })}
      </span>

      <ul
        className="flex min-w-0 items-center"
        aria-label={`${t('title', { defaultValue: 'Online now' })} (${presenceUsers.length})`}
      >
        {visible.map((presenceUser) => {
          const status = statusText(presenceUser);
          const name = displayName(presenceUser);

          return (
            <li key={presenceUser.userId} className="-ms-1.5 first:ms-0">
              <span className="relative inline-flex rounded-full ring-2 ring-background">
                <ParticipantAvatar
                  participant={toParticipant(presenceUser)}
                  size="sm"
                  locale={i18n.language}
                  t={t}
                  stacked={false}
                  avatarUrl={presenceUser.avatarUrl ?? undefined}
                  ariaLabel={`${name} — ${status}`}
                  tooltipContent={
                    <span className="flex flex-col gap-0.5 text-start">
                      <span className="font-semibold">{name}</span>
                      <span className="opacity-80">{status}</span>
                    </span>
                  }
                />
                {/* Online dot (logical inset for RTL); pulses while active. */}
                <span
                  className={cn(
                    'absolute bottom-0 end-0 h-2 w-2 rounded-full border border-background bg-emerald-500',
                    presenceUser.active && 'animate-pulse',
                  )}
                  aria-hidden="true"
                />
              </span>
            </li>
          );
        })}

        {overflow.length > 0 && (
          <li className="-ms-1.5">
            <Tooltip
              content={
                <span className="flex flex-col gap-0.5 text-start">
                  {overflow.map((presenceUser) => (
                    <span key={presenceUser.userId}>
                      <span className="font-semibold">{displayName(presenceUser)}</span>
                      <span className="opacity-80"> — {statusText(presenceUser)}</span>
                    </span>
                  ))}
                </span>
              }
            >
              <span
                className="inline-flex h-6 w-6 select-none items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-background"
                role="img"
                aria-label={t('more', { defaultValue: '{{count}} more', count: overflow.length })}
              >
                +{overflow.length}
              </span>
            </Tooltip>
          </li>
        )}
      </ul>
    </div>
  );
}
