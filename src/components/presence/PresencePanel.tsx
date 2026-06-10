import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/context/AuthContext';
import { cn } from '../../lib/utils';
import ParticipantAvatar from '../participants/ParticipantAvatar';
import type { SessionParticipant } from '../participants/types';

import { usePresence, type PresenceUser } from './usePresence';

/**
 * Live presence panel (C-MU-UX-PRESENCE).
 *
 * Shows which brothers are connected right now and, for each, the session /
 * project they are actively running. Self-contained: it subscribes to the
 * realtime `presence` channel through `usePresence` and is mounted in a
 * non-invasive spot (top of the sidebar) so it never touches sidebar internals.
 *
 * - Each brother: coloured ParticipantAvatar (initial via avatarColorForUser) +
 *   username + a green "online" dot.
 * - Active brothers additionally show a short "working on: <project/session>".
 * - The current user is tagged "(you)".
 * - RTL-friendly: logical spacing only, no hard-coded left/right.
 * - Renders nothing until the first snapshot arrives.
 */

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
 * ParticipantAvatar expects (it only reads userId/username/role for rendering).
 */
function toParticipant(user: PresenceUser): SessionParticipant {
  return {
    userId: user.userId,
    username: user.username,
    role: 'user',
    first_seen: '',
    last_seen: '',
    message_count: 0,
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

  return (
    <div className="border-b border-border/60 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('title', { defaultValue: 'Online now' })}
        </span>
        <span className="text-[10px] text-muted-foreground/60">
          {presenceUsers.length}
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {presenceUsers.map((presenceUser) => {
          const isSelf = currentUserId !== null && presenceUser.userId === currentUserId;
          const working = presenceUser.active
            ? projectLabel(presenceUser.activeProjectPath, presenceUser.activeSessionId)
            : null;

          return (
            <li key={presenceUser.userId} className="flex items-start gap-2">
              <span className="relative inline-flex flex-shrink-0">
                <ParticipantAvatar
                  participant={toParticipant(presenceUser)}
                  size="sm"
                  locale={i18n.language}
                  t={t}
                  stacked={false}
                />
                {/* Green "online" dot, positioned with logical inset for RTL. */}
                <span
                  className="absolute bottom-0 end-0 h-2 w-2 rounded-full border border-background bg-emerald-500"
                  aria-label={t('online', { defaultValue: 'online' })}
                />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate text-xs font-medium text-foreground">
                    {presenceUser.username}
                  </span>
                  {isSelf && (
                    <span className="flex-shrink-0 text-[10px] text-muted-foreground/70">
                      {t('you', { defaultValue: '(you)' })}
                    </span>
                  )}
                </div>
                {working ? (
                  <p
                    className={cn(
                      'truncate text-[11px] text-muted-foreground',
                    )}
                    title={presenceUser.activeProjectPath ?? undefined}
                  >
                    {t('workingOn', { defaultValue: 'Working on: {{target}}', target: working })}
                  </p>
                ) : (
                  <p className="truncate text-[11px] text-muted-foreground/50">
                    {t('idle', { defaultValue: 'Idle' })}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
