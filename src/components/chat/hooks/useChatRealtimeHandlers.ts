import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound } from '../../../utils/notificationSound';
import type { PendingPermissionRequest, SessionNavigationOptions } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  [key: string]: any;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string, options?: SessionNavigationOptions) => void;
  onWebSocketReconnect?: () => void;
  /** Called when the server sends an error event with a recognised error code. */
  onServerError?: (message: string) => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/** Map known server error codes to i18n keys in the 'chat' namespace. */
export const SERVER_ERROR_CODE_KEYS: Record<string, string> = {
  project_dir_missing: 'serverError.project_dir_missing',
  cli_not_installed: 'serverError.cli_not_installed',
  spawn_failed: 'serverError.spawn_failed',
};

export function useChatRealtimeHandlers({
  latestMessage,
  provider,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  streamTimerRef,
  accumulatedStreamRef,
  onSessionInactive,
  onSessionActive,
  onSessionProcessing,
  onSessionNotProcessing,
  onNavigateToSession,
  onWebSocketReconnect,
  onServerError,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const paletteOps = usePaletteOps();
  const { t } = useTranslation('chat');
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);

  useEffect(() => {
    if (!latestMessage) return;
    if (lastProcessedMessageRef.current === latestMessage) return;
    lastProcessedMessageRef.current = latestMessage;

    const activeViewSessionId =
      selectedSession?.id || currentSessionId || null;

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field) — handle and return           */
    /* ---------------------------------------------------------------- */

    const msg = latestMessage as any;

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          setPendingPermissionRequests(msg.data || []);
          return;
        }

        case 'session-status': {
          const statusSessionId = msg.sessionId;
          if (!statusSessionId) return;

          const status = msg.status;
          if (status) {
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
            };
            setClaudeStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
            return;
          }

          // Legacy isProcessing format from check-session-status
          const isCurrentSession =
            statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

          if (msg.isProcessing) {
            onSessionActive?.(statusSessionId);
            onSessionProcessing?.(statusSessionId);
            if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
            return;
          }

          onSessionInactive?.(statusSessionId);
          onSessionNotProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }
          return;
        }

        default:
          // Unknown legacy message type — ignore
          return;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const sid = msg.sessionId || activeViewSessionId;
    // True only when the event belongs to the session currently on screen.
    // Mirror events for background sessions must NOT mutate the active view
    // (spinner, status text, pending permission prompts). When a payload has no
    // sessionId we fall back to the active id (sid === activeViewSessionId), so
    // such legacy/global events apply to the current view — the safe default.
    const isActiveViewSession = !sid || sid === activeViewSessionId;

    // Coordinator/origin attribution stamped by the server on every assistant
    // payload of this run (incl. stream_delta). Carried onto the streaming row so
    // attribution is correct *while* streaming, not only after finalize (B-43).
    const streamAttribution = {
      coordinatorId: (msg as NormalizedMessage).coordinatorId,
      originKind: (msg as NormalizedMessage).originKind,
    };

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text) return;
      accumulatedStreamRef.current += text;
      if (!streamTimerRef.current) {
        streamTimerRef.current = window.setTimeout(() => {
          streamTimerRef.current = null;
          if (sid) {
            sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider, streamAttribution);
          }
        }, 100);
      }
      // Also route to store for non-active sessions
      if (sid && sid !== activeViewSessionId) {
        sessionStore.appendRealtime(sid, msg as NormalizedMessage);
      }
      return;
    }

    if (msg.kind === 'stream_end') {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      if (sid) {
        if (accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider, streamAttribution);
        }
        sessionStore.finalizeStreaming(sid);
      }
      accumulatedStreamRef.current = '';
      return;
    }

    // --- All other messages: route to store ---
    const shouldPersist =
      msg.kind !== 'session_created'
      && msg.kind !== 'complete'
      && msg.kind !== 'status'
      && msg.kind !== 'permission_request'
      && msg.kind !== 'permission_cancelled';

    if (sid && shouldPersist) {
      sessionStore.appendRealtime(sid, msg as NormalizedMessage);
    }

    // --- UI side effects for specific kinds ---
    switch (msg.kind) {
      case 'session_created': {
        const newSessionId = msg.newSessionId;
        if (!newSessionId) break;

        // We no longer synthesize client-side placeholder IDs. Until the provider
        // announces `session_created`, the active id is expected to be null.
        if (!currentSessionId) {
          console.log('Session created with ID:', newSessionId);
          console.log('Existing session ID:', currentSessionId);
          setCurrentSessionId(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
          );
        } else if (newSessionId !== currentSessionId) {
          // Stale-resume fallback: the backend could not resume the active
          // session and minted a fresh one. `session_created` never fires for a
          // healthy resume, so a mismatch here means the old id is dead — migrate
          // the view (messages, pending permissions) onto the new conversation.
          console.log('Session reset: replacing', currentSessionId, 'with', newSessionId);
          sessionStore.replaceSessionId(currentSessionId, newSessionId);
          sessionStorage.setItem('pendingSessionId', newSessionId);
          if (pendingViewSessionRef.current) {
            pendingViewSessionRef.current.sessionId = newSessionId;
          }
          setCurrentSessionId(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => ({ ...r, sessionId: newSessionId })),
          );
          onNavigateToSession?.(newSessionId, { replace: true });
          break;
        }
        pendingViewSessionRef.current = null;
        onSessionActive?.(newSessionId);
        onSessionProcessing?.(newSessionId);
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({
          text: 'Processing',
          tokens: 0,
          can_interrupt: true,
        });
        onNavigateToSession?.(newSessionId);
        break;
      }

      case 'complete': {
        // Flush any remaining streaming state
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        if (sid && accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider, streamAttribution);
          sessionStore.finalizeStreaming(sid);
        }
        accumulatedStreamRef.current = '';

        // Session-list / global concerns: keyed by sid, safe for any session.
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);

        // View mutations: only when this event is for the session on screen.
        // A background session completing must not clear the active view's
        // spinner, status, or pending permission prompts.
        if (isActiveViewSession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          setPendingPermissionRequests([]);
          pendingViewSessionRef.current = null;
        }

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it
          // No special UI action needed beyond clearing loading state above
          // The backend already sent any abort-related messages
          break;
        }

        showCompletionTitleIndicator();
        void playChatCompletionSound();

        const actualSessionId =
          typeof msg.actualSessionId === 'string' && msg.actualSessionId.trim().length > 0
            ? msg.actualSessionId
            : null;
        const isVisibleSession =
          Boolean(
            sid
            && sid === activeViewSessionId,
          );

        if (actualSessionId && sid && actualSessionId !== sid) {
          sessionStore.replaceSessionId(sid, actualSessionId);

          if (isVisibleSession) {
            setCurrentSessionId(actualSessionId);
          }

          if (isVisibleSession) {
            onNavigateToSession?.(actualSessionId, { replace: true });
            setTimeout(() => { void paletteOps.refreshProjects(); }, 500);
          }
          break;
        }

        break;
      }

      case 'error': {
        // Session-list / global concerns: keyed by sid, safe for any session.
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);

        // View mutations only for the session on screen.
        if (isActiveViewSession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          pendingViewSessionRef.current = null;

          // If the server attached a recognised error code, surface a human-
          // readable, localised message via the onServerError callback.
          const errorCode = typeof msg.code === 'string' ? msg.code : null;
          if (errorCode) {
            const i18nKey = SERVER_ERROR_CODE_KEYS[errorCode] ?? 'serverError.unknown';
            const humanMessage = t(i18nKey, { defaultValue: t('serverError.unknown') });
            onServerError?.(humanMessage);
          }
        }
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        // A permission request for a background session must not pop into the
        // active view or hijack its spinner/status.
        if (!isActiveViewSession) break;
        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === msg.requestId)) return prev;
          return [...prev, {
            requestId: msg.requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            sessionId: sid || null,
            receivedAt: new Date(),
          }];
        });
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        break;
      }

      case 'permission_cancelled': {
        // Pending prompts only ever belong to the active view, but gate anyway
        // so a background cancellation can never touch the on-screen list.
        if (isActiveViewSession && msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
        }
        break;
      }

      case 'status': {
        if (msg.text === 'process_state') {
          // Frozen-session indicator: consumed globally (AppContent →
          // sessionProcessStateStore). Never treat it as a spinner status.
          break;
        }
        // Status text / token budget are active-view concerns: a background
        // session's status must not overwrite the on-screen status line.
        if (!isActiveViewSession) break;
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text) {
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
      default:
        break;
    }
  }, [
    latestMessage,
    provider,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamTimerRef,
    accumulatedStreamRef,
    onSessionInactive,
    onSessionActive,
    onSessionProcessing,
    onSessionNotProcessing,
    onNavigateToSession,
    onWebSocketReconnect,
    onServerError,
    sessionStore,
    paletteOps,
    t,
  ]);
}
