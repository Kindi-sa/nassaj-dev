/**
 * Global session process-state store (frozen-session indicator).
 *
 * The server monitors each in-flight provider run's child process via /proc
 * and broadcasts `kind: 'status', text: 'process_state'` messages over the
 * session WebSocket (primary socket + read-only mirrors). A single listener
 * (AppContent) feeds those messages into this module-level map so any
 * component — sidebar rows, the chat header, the status spinner — can
 * subscribe per sessionId without prop drilling.
 *
 * States:
 *  - 'running': the child process is alive and schedulable.
 *  - 'frozen':  the child process was stopped externally (kill -STOP → 'T').
 *  - 'idle':    no live process for the session (turn finished) — stored as
 *               absence so the map only holds genuinely active sessions.
 */

import { useSyncExternalStore } from 'react';

export type SessionProcessState = 'running' | 'frozen' | 'idle';

const VALID_STATES: ReadonlySet<string> = new Set(['running', 'frozen', 'idle']);

const states = new Map<string, SessionProcessState>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Updates a session's process state; 'idle' clears the entry. */
export function setSessionProcessState(sessionId: string, state: string): void {
  if (!sessionId || !VALID_STATES.has(state)) {
    return;
  }
  if (state === 'idle') {
    if (!states.delete(sessionId)) {
      return;
    }
  } else {
    if (states.get(sessionId) === state) {
      return;
    }
    states.set(sessionId, state as SessionProcessState);
  }
  emitChange();
}

/**
 * Non-reactive read of a session's current process state (null when idle or
 * unknown). Used by transition detectors that need the previous state before
 * applying an update, without subscribing.
 */
export function getSessionProcessState(sessionId?: string | null): SessionProcessState | null {
  return sessionId ? (states.get(sessionId) ?? null) : null;
}

/**
 * Reactive process state for one session. Returns null when the session has
 * no live process (idle/unknown) so callers can simply hide the badge.
 */
export function useSessionProcessState(sessionId?: string | null): SessionProcessState | null {
  return useSyncExternalStore(subscribe, () =>
    sessionId ? (states.get(sessionId) ?? null) : null,
  );
}

/**
 * Project-level rollup: true while ANY of the given session ids has a live
 * 'running' process. Drives the busy dot next to a project's name in the
 * sidebar; clears automatically when the last run goes idle ('idle' deletes
 * the entry, see setSessionProcessState). 'frozen' deliberately does not
 * count — a paused process is not "working".
 */
export function useAnySessionProcessing(
  sessionIds: ReadonlyArray<string | null | undefined>,
): boolean {
  return useSyncExternalStore(subscribe, () =>
    sessionIds.some((id) => Boolean(id) && states.get(id as string) === 'running'),
  );
}

/**
 * Stable snapshot of running session ids — rebuilt only when the store
 * changes. We cache one Set instance and reuse it between getSnapshot calls
 * so that useSyncExternalStore's referential equality check (`Object.is`)
 * doesn't trigger spurious re-renders every render cycle.
 */
let cachedRunningSet: ReadonlySet<string> = new Set<string>();

function buildRunningSet(): ReadonlySet<string> {
  const next = new Set<string>();
  for (const [id, state] of states) {
    if (state === 'running') {
      next.add(id);
    }
  }
  // Reuse the previous instance when the content is identical to avoid
  // breaking referential equality inside useSyncExternalStore.
  if (next.size === cachedRunningSet.size) {
    let same = true;
    for (const id of next) {
      if (!cachedRunningSet.has(id)) {
        same = false;
        break;
      }
    }
    if (same) {
      return cachedRunningSet;
    }
  }
  cachedRunningSet = next;
  return cachedRunningSet;
}

/**
 * Returns the current snapshot of all session ids whose process state is
 * 'running'. The returned Set reference is stable across renders as long as
 * the running set does not change — safe to use as a useMemo dependency.
 *
 * Used by PresencePanel to map running sessions → projects for the
 * active-conversations tooltip.
 */
export function useRunningSessionIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, buildRunningSet);
}
