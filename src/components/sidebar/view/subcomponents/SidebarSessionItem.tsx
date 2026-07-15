import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Check, Copy, Edit2, ExternalLink, Star, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { Badge, Tooltip } from '../../../../shared/view/ui';
import SessionProcessBadge from '../../../../shared/view/SessionProcessBadge';
import WorkflowStatusBadge from '../../../../shared/view/WorkflowStatusBadge';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider, SessionOwner } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { ParticipantAvatar } from '../../../participants';
import type { SessionParticipant } from '../../../participants';

/**
 * Builds the absolute, openable session URL on the current origin, honoring any
 * router basename. Mirrors the in-app route `/session/:sessionId`, so opening it
 * in a new tab loads the same conversation directly.
 */
const buildSessionUrl = (sessionId: string): string => {
  const basename = window.__ROUTER_BASENAME__ || '';
  return `${window.location.origin}${basename}/session/${encodeURIComponent(sessionId)}`;
};

const SESSION_CONTEXT_MENU_WIDTH = 180;
const SESSION_CONTEXT_MENU_HEIGHT = 110;
const SESSION_CONTEXT_MENU_VIEWPORT_PADDING = 10;

function calcSafeContextMenuPosition(clientX: number, clientY: number) {
  const safeX =
    clientX + SESSION_CONTEXT_MENU_WIDTH > window.innerWidth
      ? window.innerWidth - SESSION_CONTEXT_MENU_WIDTH - SESSION_CONTEXT_MENU_VIEWPORT_PADDING
      : clientX;
  const safeY =
    clientY + SESSION_CONTEXT_MENU_HEIGHT > window.innerHeight
      ? window.innerHeight - SESSION_CONTEXT_MENU_HEIGHT - SESSION_CONTEXT_MENU_VIEWPORT_PADDING
      : clientY;
  return {
    x: Math.max(SESSION_CONTEXT_MENU_VIEWPORT_PADDING, safeX),
    y: Math.max(SESSION_CONTEXT_MENU_VIEWPORT_PADDING, safeY),
  };
}

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isStarred: boolean;
  onToggleStar: (session: SessionWithProvider, projectName: string) => void;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  t: TFunction;
};

/**
 * Adapts a session `owner` ({userId, username, avatarUrl}) into the
 * SessionParticipant shape ParticipantAvatar consumes. The avatar reads
 * userId/username/role (plus the optional picture), so the time fields are
 * placeholders.
 */
const ownerToParticipant = (owner: SessionOwner): SessionParticipant => ({
  userId: owner.userId,
  username: owner.username,
  role: 'owner',
  first_seen: '',
  last_seen: '',
  message_count: 0,
  avatarUrl: owner.avatarUrl ?? null,
});

/**
 * Compact relative time for sidebar rows:
 * <1m, Xm, Xhr, Xd.
 */
const formatCompactSessionAge = (dateString: string, currentTime: Date): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }

  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d`;
};

export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isStarred,
  onToggleStar,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  t,
}: SidebarSessionItemProps) {
  const { i18n } = useTranslation();
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const isEditing = editingSession === session.id;
  const compactSessionAge = formatCompactSessionAge(sessionView.sessionTime, currentTime);
  const editingContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Session owner badge (C-MU-UX-OWNER-BADGE): a single coloured avatar that
  // attributes the session to one human. `owner` is null for legacy sessions
  // (no recorded participant) — we render no badge then rather than crash.
  const owner = session.owner ?? null;
  const ownerParticipant = owner ? ownerToParticipant(owner) : null;

  // The rename panel sits inside a group-hover opacity wrapper, so leaving the row
  // would visually hide it. While editing, dismiss only when the user clicks outside
  // the panel (matches Escape / cancel-button behaviour).
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = editingContainerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  // Close context menu on outside click or ESC key.
  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleEscapeKey);
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [contextMenu]);

  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(calcSafeContextMenuPosition(event.clientX, event.clientY));
  };

  const openInNewTab = () => {
    window.open(buildSessionUrl(session.id), '_blank', 'noopener');
    setContextMenu(null);
  };

  const copySessionLink = () => {
    navigator.clipboard.writeText(buildSessionUrl(session.id)).catch(() => {});
    setContextMenu(null);
  };

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration.
  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.projectId, session.id, sessionView.sessionName, session.__provider);
  };

  // The star toggles a per-user favourite. stopPropagation/preventDefault keep
  // the click from opening the conversation (the row is a link / clickable card).
  const handleToggleStar = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleStar(session, project.projectId);
  };

  const starLabel = isStarred ? t('tooltips.unstarSession') : t('tooltips.starSession');

  // The row is a real anchor so the browser's native context menu offers
  // "Open in new tab/window". A plain left-click stays an in-app SPA
  // navigation (no full reload); modified clicks and middle-clicks are left
  // to the browser so they open the session URL in a new tab/window.
  const handleSessionLinkClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onSessionSelect(session, project.projectId);
  };

  return (
    <>
    <div className="group relative">
      {sessionView.isActive && (
        <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
          <Tooltip content={t('tooltips.activeSessionIndicator')} position="right">
            <div
              role="status"
              aria-label={t('tooltips.activeSessionIndicator')}
              className="h-2 w-2 animate-pulse rounded-full bg-green-500"
            />
          </Tooltip>
        </div>
      )}

      <div className="md:hidden">
        <div
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/5 border-primary/20' : '',
            !isSelected && sessionView.isActive
              ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
              : 'border-border/30',
          )}
          onClick={selectMobileSession}
          onContextMenu={handleContextMenu}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-xs font-medium text-foreground">{sessionView.sessionName}</div>
                {ownerParticipant && (
                  <ParticipantAvatar
                    participant={ownerParticipant}
                    size="xs"
                    locale={i18n.language}
                    t={t}
                    stacked={false}
                    avatarUrl={ownerParticipant.avatarUrl ?? undefined}
                  />
                )}
                {compactSessionAge && (
                  <span className="ms-auto flex-shrink-0 text-[11px] text-muted-foreground">{compactSessionAge}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                {sessionView.messageCount > 0 && (
                  <Badge variant="secondary" className="px-1 py-0 text-xs">
                    {sessionView.messageCount}
                  </Badge>
                )}
                <SessionProcessBadge sessionId={session.id} />
                <WorkflowStatusBadge sessionId={session.id} />
              </div>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={starLabel}
                aria-pressed={isStarred}
                title={starLabel}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md transition-transform active:scale-95',
                  isStarred
                    ? 'text-amber-500'
                    : 'text-muted-foreground/60 hover:text-amber-500',
                )}
                onClick={handleToggleStar}
              >
                <Star className={cn('h-3.5 w-3.5', isStarred && 'fill-current')} />
              </button>

              {!sessionView.isCursorSession && (
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-md bg-red-50 opacity-70 transition-transform active:scale-95 dark:bg-red-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    requestDeleteSession();
                  }}
                >
                  <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        <a
          href={buildSessionUrl(session.id)}
          onClick={handleSessionLinkClick}
          onContextMenu={handleContextMenu}
          className={cn(
            'no-underline flex w-full items-center justify-start rounded-md p-2 h-auto text-sm font-normal text-start text-foreground hover:bg-accent/50 transition-colors duration-200',
            isSelected && 'bg-accent text-accent-foreground',
          )}
        >
          <div className="flex w-full min-w-0 items-start gap-2">
            <SessionProviderLogo provider={session.__provider} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {sessionView.sessionName}
                </div>
                {ownerParticipant && (
                  <ParticipantAvatar
                    participant={ownerParticipant}
                    size="xs"
                    locale={i18n.language}
                    t={t}
                    stacked={false}
                    avatarUrl={ownerParticipant.avatarUrl ?? undefined}
                  />
                )}
                {/* Resting trailing indicator (fixed width so it never shifts
                    the title): shows the amber star when starred, else the
                    compact age. Fades out on hover, when the action cluster
                    (which carries its own star toggle) slides in. */}
                <div
                  className={cn(
                    'flex h-4 w-8 flex-shrink-0 items-center justify-end transition-opacity duration-200',
                    isEditing ? 'opacity-0' : 'group-hover:opacity-0',
                  )}
                  aria-hidden="true"
                >
                  {isStarred ? (
                    <Star className="h-3.5 w-3.5 fill-current text-amber-500" />
                  ) : (
                    compactSessionAge && (
                      <span className="text-[11px] text-muted-foreground">{compactSessionAge}</span>
                    )
                  )}
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                {sessionView.messageCount > 0 && <Badge variant="secondary" className="px-1 py-0 text-xs">{sessionView.messageCount}</Badge>}
                <SessionProcessBadge sessionId={session.id} />
                <WorkflowStatusBadge sessionId={session.id} />
              </div>
            </div>
          </div>
        </a>

        <div
          ref={editingContainerRef}
          className={cn(
            'absolute right-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 transition-all duration-200',
            isEditing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
            {isEditing ? (
              <>
                <input
                  type="text"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveEditedSession();
                    } else if (event.key === 'Escape') {
                      onCancelEditingSession();
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveEditedSession();
                  }}
                  title={t('tooltips.save')}
                >
                  <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingSession();
                  }}
                  title={t('tooltips.cancel')}
                >
                  <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={starLabel}
                  aria-pressed={isStarred}
                  title={starLabel}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    isStarred
                      ? 'bg-amber-50 text-amber-500 hover:bg-amber-100 dark:bg-amber-900/20 dark:hover:bg-amber-900/40'
                      : 'bg-gray-50 text-muted-foreground hover:bg-amber-50 hover:text-amber-500 dark:bg-gray-900/20 dark:hover:bg-amber-900/20',
                  )}
                  onClick={handleToggleStar}
                >
                  <Star className={cn('h-3 w-3', isStarred && 'fill-current')} />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEditingSession(session.id, sessionView.sessionName);
                  }}
                  title={t('tooltips.editSessionName')}
                >
                  <Edit2 className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                </button>
                {!sessionView.isCursorSession && (
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDeleteSession();
                    }}
                    title={t('tooltips.deleteSessionOptions', 'Archive or permanently delete this session')}
                  >
                    <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                  </button>
                )}
              </>
            )}
          </div>
      </div>
    </div>

    {contextMenu && (
      <div
        ref={contextMenuRef}
        role="menu"
        aria-label={t('tooltips.sessionContextMenu')}
        style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
        className="min-w-[180px] py-1 px-1 bg-popover border border-border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95"
      >
        <button
          role="menuitem"
          type="button"
          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-start rounded-md transition-colors hover:bg-accent focus:outline-none focus:bg-accent"
          onClick={openInNewTab}
        >
          <ExternalLink className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{t('tooltips.openInNewTab')}</span>
        </button>
        <button
          role="menuitem"
          type="button"
          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-start rounded-md transition-colors hover:bg-accent focus:outline-none focus:bg-accent"
          onClick={copySessionLink}
        >
          <Copy className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{t('tooltips.copyLink')}</span>
        </button>
      </div>
    )}
    </>
  );
}
