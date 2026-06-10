import { useEffect, useState } from 'react';

import { useWebSocket } from '../../contexts/WebSocketContext';

/**
 * Live presence (C-MU-UX-PRESENCE).
 *
 * One entry per connected brother. Mirrors the backend `presence` snapshot
 * (server/modules/websocket/services/presence.service.ts):
 *
 *   { type: 'presence', users: PresenceUser[], timestamp }
 *
 * A user is `connected` while ≥1 of their sockets is open (multi-tab dedupe is
 * done server-side), and `active` while they have ≥1 running provider command —
 * in which case the session/project they are on is surfaced.
 */
export type PresenceUser = {
  userId: string;
  username: string;
  connected: true;
  active: boolean;
  activeSessionId: string | null;
  activeProjectPath: string | null;
  provider: string | null;
  since: number;
};

/** WS message name the backend broadcasts presence under. */
const PRESENCE_MESSAGE_TYPE = 'presence';

type PresenceMessage = {
  type?: string;
  users?: unknown;
};

/** Narrows one raw snapshot entry to a PresenceUser, or null when malformed. */
function parsePresenceUser(raw: unknown): PresenceUser | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.userId === undefined || entry.userId === null) {
    return null;
  }
  return {
    userId: String(entry.userId),
    username: typeof entry.username === 'string' ? entry.username : String(entry.userId),
    connected: true,
    active: Boolean(entry.active),
    activeSessionId: typeof entry.activeSessionId === 'string' ? entry.activeSessionId : null,
    activeProjectPath: typeof entry.activeProjectPath === 'string' ? entry.activeProjectPath : null,
    provider: typeof entry.provider === 'string' ? entry.provider : null,
    since: typeof entry.since === 'number' ? entry.since : 0,
  };
}

/**
 * Subscribes to the realtime `presence` channel via the shared WebSocket stream.
 * Returns the current list of connected brothers (empty until the first
 * snapshot arrives — render nothing gracefully in that case).
 */
export function usePresence(): PresenceUser[] {
  const { latestMessage } = useWebSocket();
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    const message = latestMessage as PresenceMessage | null;
    if (!message || message.type !== PRESENCE_MESSAGE_TYPE) {
      return;
    }
    const list = Array.isArray(message.users) ? message.users : [];
    const parsed = list
      .map(parsePresenceUser)
      .filter((entry): entry is PresenceUser => entry !== null);
    setUsers(parsed);
  }, [latestMessage]);

  return users;
}
