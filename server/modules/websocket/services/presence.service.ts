/**
 * Live presence service (B-MU-UX-PRESENCE).
 *
 * The nassaj workspace is shared by intent (a small team of "brothers", 2-4
 * people, full trust, full file access). This service answers the question
 * "what is each brother doing right now?" without adding any isolation: it is a
 * pure VISIBILITY layer.
 *
 * It tracks two things, keyed by the JWT-authenticated `userId` only (never any
 * client-supplied identity):
 *
 *  1. CONNECTED — every open chat WebSocket is registered here on connect and
 *     removed on close. A user is "connected" while at least one of their
 *     sockets is open, so multiple tabs/devices dedupe to a single presence row.
 *
 *  2. ACTIVE — while a user has at least one running provider command they show
 *     as "active" on the most recently started session, with its project path
 *     and provider. Runs are registered/unregistered from the provider session
 *     lifecycle (the process monitor for claude, and the agy spawn/teardown for
 *     the Antigravity CLI — this fork's primary provider).
 *
 * Any change (connect, disconnect, run start, run stop) coalesces a debounced
 * broadcast of the FULL presence snapshot to every connected client. Snapshots
 * are tiny for a 2-4 person team, so sending the whole list is the simplest
 * correct option (no per-delta reconciliation on the client).
 *
 * Privacy: the snapshot exposes only userId, username, avatarUrl, and the
 * active session/project ids — all already shared inside this workspace.
 * Nothing sensitive (tokens, env, message content) is ever included.
 */

import { userDb } from '@/modules/database/index.js';
import {
  WS_OPEN_STATE,
  connectedClients,
} from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AuthenticatedWebSocketUser,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';

/** Normalized presence user id (string for stable map keys + client colour). */
type PresenceUserId = string;

/** One running provider command attributed to a user. */
type PresenceRun = {
  sessionId: string;
  projectPath: string | null;
  provider: LLMProvider | string | null;
  since: number;
};

/** Per-user presence state held in memory. */
type PresenceUserState = {
  userId: PresenceUserId;
  username: string;
  sockets: Set<RealtimeClientConnection>;
  /** sessionId -> run. A user is "active" while this map is non-empty. */
  runs: Map<string, PresenceRun>;
  /** When the user first connected (oldest still-open socket). */
  connectedSince: number;
};

/** Shape of one entry in the broadcast snapshot. */
type PresenceEntry = {
  userId: PresenceUserId;
  username: string;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) or null, so
  // presence avatars render the real picture instead of the coloured initial.
  avatarUrl: string | null;
  connected: true;
  active: boolean;
  activeSessionId: string | null;
  activeProjectPath: string | null;
  provider: LLMProvider | string | null;
  since: number;
};

/** WS message type other clients/agents can rely on. */
export const PRESENCE_MESSAGE_TYPE = 'presence';

const users = new Map<PresenceUserId, PresenceUserState>();

/** Coalesce rapid changes into a single broadcast. */
const BROADCAST_DEBOUNCE_MS = 100;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

/** Coerces a raw user id into the canonical string key, or null when absent. */
function toPresenceUserId(rawUserId: string | number | null | undefined): PresenceUserId | null {
  if (rawUserId === null || rawUserId === undefined || rawUserId === '') {
    return null;
  }
  return String(rawUserId);
}

/**
 * Resolves the user's current avatar URL from the users table at snapshot time
 * (always fresh — picks up a newly uploaded picture without reconnecting).
 * Snapshots are tiny (2-4 users) and the lookup is an indexed point read, so
 * resolving here is cheaper than threading the avatar through every caller.
 * Never throws: presence must keep broadcasting even if the lookup fails.
 */
function resolveAvatarUrl(userId: PresenceUserId): string | null {
  const numericId = Number(userId);
  if (!Number.isInteger(numericId)) {
    return null;
  }
  try {
    return userDb.getUserById(numericId)?.avatar_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds the full presence snapshot. The "active" run surfaced per user is the
 * most recently started one (a brother may have several runs going, but the UI
 * shows the freshest as the headline activity).
 */
function buildSnapshot(): PresenceEntry[] {
  const entries: PresenceEntry[] = [];
  for (const state of users.values()) {
    let active: PresenceRun | null = null;
    for (const run of state.runs.values()) {
      if (!active || run.since > active.since) {
        active = run;
      }
    }
    entries.push({
      userId: state.userId,
      username: state.username,
      avatarUrl: resolveAvatarUrl(state.userId),
      connected: true,
      active: Boolean(active),
      activeSessionId: active?.sessionId ?? null,
      activeProjectPath: active?.projectPath ?? null,
      provider: active?.provider ?? null,
      since: active ? active.since : state.connectedSince,
    });
  }
  // Stable order so clients don't see rows jump around between snapshots.
  entries.sort((a, b) => a.userId.localeCompare(b.userId));
  return entries;
}

/** Sends the current snapshot to every open chat client immediately. */
function broadcastNow(): void {
  broadcastTimer = null;
  const payload = JSON.stringify({
    type: PRESENCE_MESSAGE_TYPE,
    users: buildSnapshot(),
    timestamp: new Date().toISOString(),
  });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      try {
        client.send(payload);
      } catch {
        // A failing socket will be cleaned up by its own close handler.
      }
    }
  });
}

/** Coalesces a broadcast so a burst of changes emits a single snapshot. */
function scheduleBroadcast(): void {
  if (broadcastTimer) {
    return;
  }
  broadcastTimer = setTimeout(broadcastNow, BROADCAST_DEBOUNCE_MS);
  if (typeof broadcastTimer.unref === 'function') {
    broadcastTimer.unref();
  }
}

/**
 * Registers an authenticated socket as connected. Multiple sockets for the same
 * user dedupe into one presence row (multi-tab/device). Returns silently for
 * unauthenticated sockets (no userId) so single-user/anonymous runs are ignored.
 */
export function presenceConnect(
  ws: RealtimeClientConnection,
  user: AuthenticatedWebSocketUser | undefined,
  rawUserId: string | number | null | undefined,
): void {
  const userId = toPresenceUserId(rawUserId);
  if (!userId || !ws) {
    return;
  }
  const username =
    typeof user?.username === 'string' && user.username.trim().length > 0
      ? user.username
      : userId;

  let state = users.get(userId);
  if (!state) {
    state = {
      userId,
      username,
      sockets: new Set(),
      runs: new Map(),
      connectedSince: Date.now(),
    };
    users.set(userId, state);
  } else {
    // Keep the freshest known username.
    state.username = username;
  }
  state.sockets.add(ws);
  scheduleBroadcast();
}

/**
 * Removes a socket. The user stays "connected" while any other socket of theirs
 * remains open; only when the last one closes is the user (and any leftover run
 * attribution) dropped from presence.
 */
export function presenceDisconnect(ws: RealtimeClientConnection): void {
  if (!ws) {
    return;
  }
  for (const [userId, state] of users) {
    if (!state.sockets.delete(ws)) {
      continue;
    }
    if (state.sockets.size === 0) {
      users.delete(userId);
    }
    scheduleBroadcast();
    return;
  }
}

/**
 * Marks a user as actively running a session. Safe to call for unauthenticated
 * runs (no userId) — they are simply ignored. A run started for a user with no
 * open socket still creates a transient presence row so the activity is visible;
 * it is cleaned up when the run stops or the socket set empties.
 */
export function presenceRunStarted(details: {
  userId: string | number | null | undefined;
  sessionId: string | null | undefined;
  projectPath?: string | null;
  provider?: LLMProvider | string | null;
  username?: string | null;
}): void {
  const userId = toPresenceUserId(details.userId);
  const sessionId = typeof details.sessionId === 'string' ? details.sessionId : '';
  if (!userId || !sessionId) {
    return;
  }

  let state = users.get(userId);
  if (!state) {
    // A run can begin before/without a tracked socket (e.g. resumed via a
    // background path). Create a presence row so the work is still visible.
    state = {
      userId,
      username:
        typeof details.username === 'string' && details.username.trim().length > 0
          ? details.username
          : userId,
      sockets: new Set(),
      runs: new Map(),
      connectedSince: Date.now(),
    };
    users.set(userId, state);
  } else if (typeof details.username === 'string' && details.username.trim().length > 0) {
    state.username = details.username;
  }

  state.runs.set(sessionId, {
    sessionId,
    projectPath: details.projectPath ?? null,
    provider: details.provider ?? null,
    since: Date.now(),
  });
  scheduleBroadcast();
}

/**
 * Clears a user's active run. The user stays connected (and present) while any
 * socket remains open; if the run row was created without a socket and now has
 * no runs and no sockets, the row is dropped.
 */
export function presenceRunStopped(details: {
  userId: string | number | null | undefined;
  sessionId: string | null | undefined;
}): void {
  const userId = toPresenceUserId(details.userId);
  const sessionId = typeof details.sessionId === 'string' ? details.sessionId : '';
  if (!userId || !sessionId) {
    return;
  }
  const state = users.get(userId);
  if (!state) {
    return;
  }
  const had = state.runs.delete(sessionId);
  if (!had) {
    return;
  }
  if (state.runs.size === 0 && state.sockets.size === 0) {
    users.delete(userId);
  }
  scheduleBroadcast();
}
