import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';

import type {
  AsyncResourceStatus,
  SessionAgent,
  SessionParticipant,
} from './types';

type SessionParticipantsState = {
  status: AsyncResourceStatus;
  participants: SessionParticipant[];
  agents: SessionAgent[];
};

const EMPTY_SESSION_STATE: SessionParticipantsState = {
  status: 'idle',
  participants: [],
  agents: [],
};

// The backend wraps payloads in `{ success: true, data: {...} }`. This unwraps
// the envelope (tolerating a bare body) and surfaces failures consistently.
async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body && typeof body === 'object' && 'data' in body) {
    if (body.success === false) {
      throw new Error('Request returned success=false');
    }
    return (body.data as Record<string, unknown>) ?? {};
  }
  return body ?? {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Lazily loads humans + agents for a single session. Nothing is fetched until
 * `load()` is called (e.g. on hover or when the session opens). Calling `load`
 * repeatedly is cheap: it no-ops once a request is in flight or has succeeded.
 */
export function useSessionParticipants(sessionId: string | null | undefined) {
  const [state, setState] = useState<SessionParticipantsState>(EMPTY_SESSION_STATE);
  // Guards against duplicate fetches and post-unmount state updates.
  const requestedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Reset when the session identity changes.
    requestedRef.current = false;
    setState(EMPTY_SESSION_STATE);
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (!sessionId || requestedRef.current) {
      return;
    }
    requestedRef.current = true;
    setState((previous) => ({ ...previous, status: 'loading' }));

    Promise.all([
      api.sessionParticipants(sessionId).then(readEnvelope),
      api.sessionAgents(sessionId).then(readEnvelope),
    ])
      .then(([participantsData, agentsData]) => {
        if (!mountedRef.current) return;
        setState({
          status: 'success',
          participants: asArray<SessionParticipant>(participantsData.participants),
          agents: asArray<SessionAgent>(agentsData.agents),
        });
      })
      .catch(() => {
        if (!mountedRef.current) return;
        // Allow a retry on a later trigger.
        requestedRef.current = false;
        setState((previous) => ({ ...previous, status: 'error' }));
      });
  }, [sessionId]);

  return { ...state, load };
}

type ProjectParticipantsState = {
  status: AsyncResourceStatus;
  users: SessionParticipant[];
  agents: SessionAgent[];
};

const EMPTY_PROJECT_STATE: ProjectParticipantsState = {
  status: 'idle',
  users: [],
  agents: [],
};

/**
 * Lazily loads aggregated participants for a project. Same lazy contract as
 * {@link useSessionParticipants}.
 */
export function useProjectParticipants(projectId: string | null | undefined) {
  const [state, setState] = useState<ProjectParticipantsState>(EMPTY_PROJECT_STATE);
  const requestedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    requestedRef.current = false;
    setState(EMPTY_PROJECT_STATE);
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (!projectId || requestedRef.current) {
      return;
    }
    requestedRef.current = true;
    setState((previous) => ({ ...previous, status: 'loading' }));

    api
      .projectParticipants(projectId)
      .then(readEnvelope)
      .then((data) => {
        if (!mountedRef.current) return;
        setState({
          status: 'success',
          users: asArray<SessionParticipant>(data.users),
          agents: asArray<SessionAgent>(data.agents),
        });
      })
      .catch(() => {
        if (!mountedRef.current) return;
        requestedRef.current = false;
        setState((previous) => ({ ...previous, status: 'error' }));
      });
  }, [projectId]);

  return { ...state, load };
}
