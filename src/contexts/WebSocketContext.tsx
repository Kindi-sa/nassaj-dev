import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

export type WsConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export type SendMessageResult = { ok: true } | { ok: false; reason: string };

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => SendMessageResult;
  latestMessage: any | null;
  isConnected: boolean;
  wsStatus: WsConnectionStatus;
  /**
   * Number of open sessions on the server right now (global activity counter,
   * not scoped to the current session's viewers). Updated via the
   * `open_sessions_count` WS message. `null` until the first message arrives.
   */
  openSessionsCount: number | null;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

// localStorage key holding the JWT. Kept in sync with AUTH_TOKEN_STORAGE_KEY
// (src/components/auth/constants.ts) and the writer in utils/api.js.
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

/**
 * Resolve the WS URL from the FRESHEST persisted token, exactly like
 * shell/utils/socket.ts. This is the B-131 fix: the server rotates the JWT
 * mid-session via `X-Refreshed-Token` and the client persists it to
 * localStorage, but a backoff reconnect scheduled by `onclose` does NOT re-run
 * the [token] effect — so reading React state there would keep dialing with the
 * pre-rotation token until it expired (day 7), an endless `expired` reconnect
 * loop. Reading localStorage on every (re)connect guarantees the newest token.
 *
 * Exported so the reconnect-token behaviour is unit-testable against the exact
 * code path `connect()` uses (no drift between test and production).
 */
export const resolveWebSocketUrl = (): string | null =>
  buildWebSocketUrl(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY));

// Exponential backoff constants (milliseconds).
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER_MS = 500;

/** Compute next reconnect delay with full-jitter exponential backoff. */
export function calcReconnectDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
  return exp + Math.random() * RECONNECT_JITTER_MS;
}

/** WS message type for the server-wide open-sessions counter. */
const OPEN_SESSIONS_MESSAGE_TYPE = 'open_sessions_count';

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const reconnectAttemptRef = useRef(0); // Counts consecutive failures for backoff
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const [openSessionsCount, setOpenSessionsCount] = useState<number | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();
  // `token` (React auth state) is used ONLY as the effect key below: a rotation
  // (login/logout, password change, or an `auth:token-refreshed` adoption)
  // re-runs the effect and reconnects. The socket URL itself is built from the
  // freshest localStorage value inside connect() (see resolveWebSocketUrl), so
  // even a backoff reconnect that does not re-run this effect picks up the
  // newest token.
  // Monotonic connection epoch. Each connect() bumps it; a socket captures its
  // epoch and ignores its own onopen/onclose once a newer connection exists.
  // This is what stops a token rotation's old-socket close from spawning a
  // duplicate reconnect alongside the fresh socket.
  const connEpochRef = useRef(0);

  useEffect(() => {
    // (Re)establishing the connection for a real token change: clear the
    // unmounted flag so the cleanup of the PREVIOUS run (which set it true)
    // does not permanently block this fresh connection. A genuine React unmount
    // still leaves the flag true because no effect re-run follows it.
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    // Cancel any pending reconnect: a fresh connect (e.g. token rotation closing
    // the old socket, which schedules an onclose reconnect) must not later spawn
    // a duplicate socket. Prevents reconnect storms on rapid token changes.
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    // This attempt supersedes any previous socket.
    const myEpoch = connEpochRef.current + 1;
    connEpochRef.current = myEpoch;
    try {
      // Build from the freshest localStorage token (see resolveWebSocketUrl):
      // survives a mid-session `X-Refreshed-Token` rotation even on backoff
      // reconnects that do not re-run the [token] effect.
      const wsUrl = resolveWebSocketUrl();

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        if (myEpoch !== connEpochRef.current) return; // superseded by a newer connect
        setIsConnected(true);
        setWsStatus('connected');
        reconnectAttemptRef.current = 0; // Reset backoff counter on successful connection
        wsRef.current = websocket;
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          setLatestMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (myEpoch !== connEpochRef.current) return; // ignore stale socket
        try {
          const data = JSON.parse(event.data);
          // The open_sessions_count message is a background counter update.
          // It updates its own slice of state without touching latestMessage so
          // that hooks watching latestMessage (e.g. useSessionParticipants) do
          // not trigger unnecessary re-fetches on every counter broadcast.
          if (data && data.type === OPEN_SESSIONS_MESSAGE_TYPE) {
            if (typeof data.count === 'number') {
              setOpenSessionsCount(data.count);
            }
            return;
          }
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = (event) => {
        // [WS-DIAG] (point #5) Client-side close forensics. The server-side close
        // code (1006 abnormal/no-frame, 1001 going-away/reload, 1000 normal) lets us
        // correlate the browser's view with the server log. `wasClean=false` + code
        // 1006 = network/proxy/keepalive drop (the active-stream freeze case);
        // 1001 = reload/navigation. A reconnect is scheduled below in either case,
        // but the active session's stream is only re-bound if a component re-issues
        // check-session-status AND the run is idle (active runs are vetoed server-side).
        // eslint-disable-next-line no-console
        console.log(
          `[WS-DIAG] client-onclose code=${event.code} `
          + `reason=${JSON.stringify(event.reason || '')} wasClean=${event.wasClean} `
          + `superseded=${myEpoch !== connEpochRef.current} `
          + `hadConnected=${hasConnectedRef.current}`
        );
        // A superseded socket (token rotated, newer connect already running)
        // must not touch shared state or schedule a reconnect — that newer
        // connection owns the lifecycle now.
        if (myEpoch !== connEpochRef.current) return;
        setIsConnected(false);
        wsRef.current = null;

        // Only show "reconnecting" if we've successfully connected before;
        // on the very first attempt a failure shows as "disconnected".
        if (hasConnectedRef.current) {
          setWsStatus('reconnecting');
        } else {
          setWsStatus('disconnected');
        }

        // Exponential backoff reconnect (avoids reconnect storm).
        const delay = calcReconnectDelay(reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, delay);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, []); // stable: reads the live token from localStorage on every connect, so
  //          the onclose reconnect timer never closes over a stale token/closure.

  const sendMessage = useCallback((message: any): SendMessageResult => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return { ok: true };
    }
    return { ok: false, reason: 'disconnected' };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected,
    wsStatus,
    openSessionsCount,
  }), [sendMessage, latestMessage, isConnected, wsStatus, openSessionsCount]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
