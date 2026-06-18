import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { MessagesSquare } from 'lucide-react';

import { usePresence } from '../../../presence/usePresence';
import { cn } from '../../../../lib/utils';
import type { Project } from '../../../../types/app';

/**
 * Collapsed-rail indicator for active conversations count
 * (C-MU-UX-PRESENCE) + interactive open-projects popover.
 *
 * Reads the server-authoritative `activeConversations` breakdown from
 * usePresence() and renders an icon + total count inside the narrow w-12 rail
 * (mirrors SystemStatsCollapsed / ClaudeUsageCollapsed).
 *
 * What the count represents: `activeConversations.total` — the number of
 * conversations that currently have a running provider command, grouped by
 * project in `byProject: [{ projectPath, count }]` (plus `hiddenCount` for
 * projects the user cannot see). The available *names* are therefore project
 * names, resolved from the sidebar `projects` list (or the last path segment
 * as a fallback), each carrying its own running-conversation count.
 *
 * Interaction: hovering, focusing, or clicking the trigger opens a popover
 * listing the visible projects. Each row is a button that selects the project
 * and expands the sidebar (we are in the collapsed rail). Keyboard users can
 * tab to the trigger, open with Enter/Space, and Escape closes.
 *
 * Firefox/Zen safety (cf. upstream bug 1392476): the popover is rendered
 * through createPortal into document.body with `position: fixed` coordinates
 * computed from getBoundingClientRect() — never a `position:absolute` child of
 * the trigger button. This is the same proven pattern as the shared Tooltip
 * primitive, but interactive (the shared Tooltip is pointer-events-none and so
 * cannot host clickable rows).
 *
 * RTL: logical spacing only; the popover is opened to the inline-end side
 * (`right` for the LTR rail, which mirrors correctly under RTL because it is
 * positioned relative to the trigger rect).
 */

type PresenceCountCollapsedProps = {
  /** Sidebar project list — maps running-conversation project paths to names. */
  projects?: Project[];
  /** Select a project (and surface it in the main view). */
  onProjectSelect?: (project: Project) => void;
  /** Expand the collapsed sidebar so the selected project is visible. */
  onExpand?: () => void;
};

/** Last path segment of a project path, for a compact fallback label. */
function lastSegment(projectPath: string): string {
  const trimmed = projectPath.replace(/[/\\]+$/, '');
  const segments = trimmed.split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

export function PresenceCountCollapsed({
  projects = [],
  onProjectSelect,
  onExpand,
}: PresenceCountCollapsedProps) {
  const { t } = useTranslation('presence');
  const { activeConversations } = usePresence();

  const [isOpen, setIsOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const popoverId = useId();

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const open = useCallback(() => {
    clearCloseTimer();
    setIsOpen(true);
  }, [clearCloseTimer]);

  const close = useCallback(() => {
    clearCloseTimer();
    setIsOpen(false);
  }, [clearCloseTimer]);

  // Hover-out grace so the cursor can travel from trigger to popover.
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setIsOpen(false), 120);
  }, [clearCloseTimer]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spacing = 8;
    // Open toward the inline-end of the rail (the rail sits at the inline-start
    // edge of the viewport, so the popover always has room on this side).
    setPopoverStyle({
      position: 'fixed',
      top: rect.top + rect.height / 2,
      insetInlineStart: rect.right + spacing,
      transform: 'translateY(-50%)',
      zIndex: 9999,
      maxWidth: 'min(18rem, calc(100vw - 4rem))',
    });
  }, []);

  // Recompute position while open and track viewport changes.
  useEffect(() => {
    if (!isOpen) {
      setPopoverStyle(null);
      return;
    }
    const rafId = window.requestAnimationFrame(updatePosition);
    const onViewportChange = () => updatePosition();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [isOpen, updatePosition]);

  // Close on outside pointer and on Escape.
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (triggerRef.current?.contains(target)) return;
        if (popoverRef.current?.contains(target)) return;
      }
      setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // Hide until the first presence snapshot arrives (null = not yet received).
  if (activeConversations === null) return null;

  const count = activeConversations.total;

  const tooltipLabel = t('collapsedRailTooltip', {
    count,
    defaultValue: '{{count}} open conversations',
  });
  const headingLabel = t('activeConversations', {
    defaultValue: 'Active conversations',
  });

  /** Resolve a projectPath to { name, project } using the sidebar list. */
  const resolveProject = (projectPath: string): { name: string; project: Project | null } => {
    const project =
      projects.find(
        (p) =>
          p.fullPath === projectPath ||
          p.path === projectPath,
      ) ?? null;
    return {
      name: project ? project.displayName : lastSegment(projectPath),
      project,
    };
  };

  const handleSelect = (project: Project | null) => {
    if (project && onProjectSelect) {
      onProjectSelect(project);
      onExpand?.();
    }
    close();
  };

  const hasProjects = activeConversations.byProject.length > 0;
  const interactive = hasProjects || activeConversations.hiddenCount > 0;

  return (
    <>
      <div className="nav-divider my-1 w-6" />
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'flex flex-col items-center gap-0.5 rounded-lg py-1 text-muted-foreground transition-colors',
          'hover:bg-accent/80 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        title={tooltipLabel}
        aria-label={tooltipLabel}
        aria-haspopup={interactive ? 'dialog' : undefined}
        aria-expanded={interactive ? isOpen : undefined}
        aria-controls={interactive && isOpen ? popoverId : undefined}
        onClick={() => {
          if (!interactive) return;
          setIsOpen((prev) => !prev);
        }}
        onMouseEnter={interactive ? open : undefined}
        onMouseLeave={interactive ? scheduleClose : undefined}
        onFocus={interactive ? open : undefined}
        onBlur={interactive ? scheduleClose : undefined}
      >
        <MessagesSquare aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="text-[9px] tabular-nums leading-none">{count}</span>
      </button>

      {interactive && isOpen && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="group"
            aria-label={headingLabel}
            dir="auto"
            style={
              popoverStyle ?? {
                position: 'fixed',
                top: '-9999px',
                insetInlineStart: '-9999px',
                opacity: 0,
              }
            }
            className={cn(
              'min-w-[12rem] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg',
              'animate-in fade-in-0 zoom-in-95 duration-150',
            )}
            onMouseEnter={open}
            onMouseLeave={scheduleClose}
          >
            <div className="border-b border-border/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {headingLabel}
            </div>
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {activeConversations.byProject.map(({ projectPath, count: projectCount }) => {
                const { name, project } = resolveProject(projectPath);
                const selectable = project !== null && Boolean(onProjectSelect);
                return (
                  <li key={projectPath}>
                    <button
                      type="button"
                      disabled={!selectable}
                      onClick={() => handleSelect(project)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-start text-xs',
                        'focus-visible:outline-none focus-visible:bg-accent',
                        selectable
                          ? 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
                          : 'cursor-default text-muted-foreground',
                      )}
                    >
                      <span className="truncate">{name}</span>
                      <span className="flex-shrink-0 tabular-nums opacity-60">
                        {t('activeConversationsProjectCount', {
                          count: projectCount,
                          defaultValue: '— {{count}}',
                        })}
                      </span>
                    </button>
                  </li>
                );
              })}
              {activeConversations.hiddenCount > 0 && (
                <li
                  role="presentation"
                  className="px-3 py-1.5 text-xs italic text-muted-foreground/70"
                >
                  {t('activeConversationsElsewhere', {
                    count: activeConversations.hiddenCount,
                    defaultValue: '{{count}} elsewhere',
                  })}
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
