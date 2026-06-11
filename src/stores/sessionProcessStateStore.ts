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
