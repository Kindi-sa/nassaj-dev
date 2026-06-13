import { useTranslation } from 'react-i18next';
import { MessagesSquare } from 'lucide-react';

import { usePresence } from '../../../presence/usePresence';

/**
 * Collapsed-rail indicator for active conversations count
 * (C-MU-UX-PRESENCE).
 *
 * Simple display component: reads activeConversations from usePresence()
 * and renders an icon + total count stack inside the narrow w-12 rail.
 * Mirrors the visual style of SystemStatsCollapsed and ClaudeUsageCollapsed.
 *
 * Data source: usePresence() subscribes to the shared WebSocketContext
 * (latestMessage). Each call does NOT open a new WS connection — no
 * duplicate listener when both PresencePanel and this component are mounted.
 *
 * Count: uses activeConversations.total, matching PresencePanel's primary
 * badge value.
 *
 * Visibility: hidden while activeConversations === null (no snapshot yet),
 * shown otherwise — including when total === 0.
 *
 * RTL: no left/right properties; items-center / gap handle layout.
 */
export function PresenceCountCollapsed() {
  const { t } = useTranslation('presence');
  const { activeConversations } = usePresence();

  // Hide until the first presence snapshot arrives (null = not yet received).
  if (activeConversations === null) return null;

  const count = activeConversations.total;

  const tooltipLabel = t('collapsedRailTooltip', {
    count,
    defaultValue: '{{count}} open conversations',
  });

  return (
    <>
      <div className="nav-divider my-1 w-6" />
      <div
        className="flex flex-col items-center gap-0.5 py-1 text-muted-foreground"
        title={tooltipLabel}
        aria-label={tooltipLabel}
      >
        <MessagesSquare aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="text-[9px] tabular-nums leading-none">{count}</span>
      </div>
    </>
  );
}
