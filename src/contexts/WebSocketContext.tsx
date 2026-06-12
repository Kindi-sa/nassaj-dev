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

// Exponential backoff constants (milliseconds).
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER_MS = 500;

/** Compute next reconnect delay with full-jitter exponential backoff. */
function calcReconnectDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
  return exp + Math.random() * RECONNECT_JITTER_MS;
}

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const reconnectAttemptRef = useRef(0); // Counts consecutive failures for backoff
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();
  // Always read the freshest token in the reconnect path so a token rotation
  // (logout→login, password change) dials with the NEW token, never a stale
  // closure captured by an earlier `connect` invocation.
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;
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
      // Construct WebSocket URL — always from the current token.
      const wsUrl = buildWebSocketUrl(tokenRef.current);

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
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
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
  }, []); // stable: reads the live token from tokenRef, so the onclose
  //          reconnect timer never closes over a stale token/closure.

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
  }), [sendMessage, latestMessage, isConnected, wsStatus]);

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
