import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';
import { useWebSocket } from '../../contexts/WebSocketContext';

/**
 * Live runner status for one project, kept fresh by the same mechanism as
 * useProjectBoard: the bridge watches the runner's on-disk files with chokidar
 * and broadcasts `runner-updated`; this hook re-fetches GET /api/runner/:id.
 *
 * Architectural contract: ADR-RUNNER-BRIDGE-001. The hook only ever READS
 * status and POSTs control verbs — it never touches the runner's files.
 */

export type RunnerCycleState = {
  stage?: string;
  cycle?: number;
  status?: string;
  pid?: number;
  started_at?: string;
  fix_loops?: number;
  exit2_count?: number;
  interrupted_count?: number;
  last_error?: string;
};

export type RunnerActivity = {
  active_task_id?: string | null;
  active_phase_id?: string | null;
  stage?: string;
  started_at?: string;
  heartbeat_at?: string;
  last_verdict?: 'clean' | 'unclean' | null;
};

export type RunnerStatus = {
  registered: boolean;
  name: string | null;
  dir: string | null;
  enabled: boolean | null;
  priority: number | null;
  paused: boolean;
  cycle: RunnerCycleState | null;
  activity: RunnerActivity | null;
  verdict: { clean?: boolean; notes?: string } | null;
  config: { model: string | null; models: Record<string, string> | null; threshold: number | null } | null;
  stateError: boolean;
};

type RunnerWebSocketMessage = { type?: string; projectId?: string };

export type RunnerAction = 'start' | 'stop' | 'pause' | 'resume' | 'approve';

export function useRunner(projectId: string | null | undefined) {
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionPending, setActionPending] = useState<RunnerAction | null>(null);
  const { latestMessage } = useWebSocket();
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const refresh = useCallback(async (targetProjectId: string) => {
    try {
      const response = await api.runnerStatus(targetProjectId);
      if (projectIdRef.current !== targetProjectId) {
        return; // stale response for a previously selected project
      }
      if (!response.ok) {
        setRunner(null);
        return;
      }
      const data = (await response.json()) as RunnerStatus;
      if (projectIdRef.current !== targetProjectId) {
        return;
      }
      setRunner(data);
    } catch {
      if (projectIdRef.current === targetProjectId) {
        setRunner(null);
      }
    } finally {
      if (projectIdRef.current === targetProjectId) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setRunner(null);
    if (!projectId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void refresh(projectId);
  }, [projectId, refresh]);

  // Live: re-fetch when the bridge broadcasts a runner change for this project.
  useEffect(() => {
    const message = latestMessage as RunnerWebSocketMessage | null;
    if (message?.type === 'runner-updated' && projectId && message.projectId === projectId) {
      void refresh(projectId);
    }
  }, [latestMessage, projectId, refresh]);

  const runAction = useCallback(
    async (action: RunnerAction): Promise<{ ok: boolean; status?: number }> => {
      if (!projectId) {
        return { ok: false };
      }
      setActionPending(action);
      try {
        const response = await api.runnerControl(projectId, action);
        if (response.ok) {
          // The endpoint returns the fresh merged state; adopt it optimistically.
          try {
            const data = (await response.json()) as RunnerStatus;
            if (projectIdRef.current === projectId) {
              setRunner(data);
            }
          } catch {
            void refresh(projectId);
          }
        }
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false };
      } finally {
        if (projectIdRef.current === projectId) {
          setActionPending(null);
        }
      }
    },
    [projectId, refresh],
  );

  const start = useCallback(() => runAction('start'), [runAction]);
  const stop = useCallback(() => runAction('stop'), [runAction]);
  const pause = useCallback(() => runAction('pause'), [runAction]);
  const resume = useCallback(() => runAction('resume'), [runAction]);
  const approve = useCallback(() => runAction('approve'), [runAction]);

  return {
    runner,
    isLoading,
    registered: Boolean(runner?.registered),
    actionPending,
    refresh: () => projectId && refresh(projectId),
    start,
    stop,
    pause,
    resume,
    approve,
  };
}
