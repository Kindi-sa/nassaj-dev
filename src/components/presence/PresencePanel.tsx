import { useTranslation } from 'react-i18next';
import { MessagesSquare } from 'lucide-react';

import { useAuth } from '../auth/context/AuthContext';
import { cn } from '../../lib/utils';
import ParticipantAvatar from '../participants/ParticipantAvatar';
import type { SessionParticipant } from '../participants/types';
import { Tooltip } from '../../shared/view/ui';
import type { Project } from '../../types/app';

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

type PresencePanelProps = {
  /** Project list from the sidebar — used to map running sessions to project names. */
  projects?: Project[];
};

export default function PresencePanel({ projects = [] }: PresencePanelProps) {
  const { t, i18n } = useTranslation('presence');
  const { user: currentUser } = useAuth();
  const { users: presenceUsers, activeConversations } = usePresence();

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

  // Sort: current user first, then active users, then idle — for a stable,
  // meaningful stack order (leftmost = most relevant).
  const sorted = [...presenceUsers].sort((a, b) => {
    const aSelf = currentUserId !== null && a.userId === currentUserId ? 1 : 0;
    const bSelf = currentUserId !== null && b.userId === currentUserId ? 1 : 0;
    if (aSelf !== bSelf) return bSelf - aSelf; // self first
    if (a.active !== b.active) return (b.active ? 1 : 0) - (a.active ? 1 : 0); // active before idle
    return a.since - b.since; // earlier join first
  });

  const visible = sorted.slice(0, MAX_VISIBLE);
  const overflow = sorted.slice(MAX_VISIBLE);

  // Badge: derive counts from the same presenceUsers list shown by the avatars.
  // All entries in the list are human users (the server sends one entry per
  // connected brother, not per agent/session).
  const totalConnected = presenceUsers.length;
  const activeCount = presenceUsers.filter((u) => u.active).length;

  const badgeLabel = t('connectedCount', {
    count: totalConnected,
    defaultValue: '{{count}} online',
  });
  const badgeTooltip = activeCount > 0
    ? t('connectedUsersAndAgents', {
        users: totalConnected,
        agents: activeCount,
        defaultValue: '{{users}} users · {{agents}} agents',
      })
    : t('connectedUsers', { count: totalConnected, defaultValue: '{{count}} users' });

  const activeConversationsLabel = t('activeConversations', {
    defaultValue: 'Active conversations',
  });
  const activeConversationsCount = t('activeConversationsCount', {
    count: activeConversations?.total ?? 0,
    defaultValue: '{{count}} active',
  });

  /**
   * Resolve a projectPath from byProject to a display name.
   * Tries to match against the projects prop via fullPath or path; falls back
   * to the last path segment (mirrors projectLabel logic above).
   */
  function resolveProjectDisplayName(projectPath: string): string {
    const match = projects.find(
      (p) =>
        p.fullPath === projectPath ||
        (p as unknown as Record<string, unknown>).path === projectPath,
    );
    if (match) {
      return match.displayName;
    }
    const trimmed = projectPath.replace(/[/\\]+$/, '');
    const segments = trimmed.split(/[/\\]+/).filter(Boolean);
    return segments[segments.length - 1] ?? projectPath;
  }

  if (presenceUsers.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full items-center justify-between border-b border-border/60 px-3 py-1.5">
      {/* Left group: label + avatar stack */}
      <div className="flex min-w-0 items-center gap-2">
        {/* "Online now" label only — the avatar stack conveys who is connected. */}
        <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('title', { defaultValue: 'Online now' })}
        </span>

        <ul
          className="flex items-center"
          aria-label={`${t('title', { defaultValue: 'Online now' })} (${totalConnected})`}
        >
          {visible.map((presenceUser) => {
            const status = statusText(presenceUser);
            const name = displayName(presenceUser);

            return (
              <li key={presenceUser.userId} className="-ms-1.5 first:ms-0 flex items-center">
                {/* Wrapper: explicit h-6 w-6 so both image and initial variants
                  * occupy an identical bounding box. inline-flex + items-center
                  * prevents the img replaced-element baseline from shifting the
                  * circle relative to initial-letter circles. */}
                <span className="relative inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ring-2 ring-background">
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
            <li className="-ms-1.5 flex items-center">
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
                  className="inline-flex h-6 w-6 flex-shrink-0 select-none items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-background"
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

      {/* Active conversations counter — pinned to inline-end of the full row.
        * Hidden until the first presence snapshot arrives (activeConversations != null).
        * The tooltip lists each visible project from byProject, then a «N elsewhere»
        * line when hiddenCount > 0 — so total always equals the badge count. */}
      {activeConversations != null && (
        <Tooltip
          content={
            activeConversations.byProject.length > 0 ? (
              <span className="flex flex-col gap-0.5 text-start">
                <span className="mb-0.5 font-semibold opacity-90">
                  {t('activeConversations', { defaultValue: 'Active conversations' })}
                </span>
                {activeConversations.byProject.map(({ projectPath, count }) => (
                  <span key={projectPath} className="flex items-center gap-1">
                    <span className="truncate max-w-[160px]">
                      {resolveProjectDisplayName(projectPath)}
                    </span>
                    <span className="opacity-70">
                      {t('activeConversationsProjectCount', {
                        count,
                        defaultValue: '— {{count}}',
                      })}
                    </span>
                  </span>
                ))}
                {activeConversations.hiddenCount > 0 && (
                  <span className="opacity-60 italic">
                    {t('activeConversationsElsewhere', {
                      count: activeConversations.hiddenCount,
                      defaultValue: '{{count}} elsewhere',
                    })}
                  </span>
                )}
              </span>
            ) : (
              activeConversationsLabel
            )
          }
        >
          <span
            className="inline-flex flex-shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground/70"
            aria-label={
              activeConversations.byProject.length > 0
                ? t('activeConversationsAriaLabel', {
                    count: activeConversations.total,
                    projects: [
                      ...activeConversations.byProject.map(
                        ({ projectPath, count }) =>
                          `${resolveProjectDisplayName(projectPath)} ${count}`,
                      ),
                      ...(activeConversations.hiddenCount > 0
                        ? [
                            t('activeConversationsElsewhere', {
                              count: activeConversations.hiddenCount,
                              defaultValue: '{{count}} elsewhere',
                            }),
                          ]
                        : []),
                    ].join(', '),
                    defaultValue: 'Active conversations: {{count}} across {{projects}}',
                  })
                : `${activeConversationsLabel}: ${activeConversations.total}`
            }
          >
            <MessagesSquare className="h-2.5 w-2.5 flex-shrink-0 opacity-60" aria-hidden="true" />
            <span>{activeConversationsCount}</span>
          </span>
        </Tooltip>
      )}
    </div>
  );
}
