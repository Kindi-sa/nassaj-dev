import type { Server as HttpServer } from 'node:http';

import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[2];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

/** WebSocket with keepalive liveness flag. */
type AliveWebSocket = WebSocket & { isAlive: boolean };

/** Ping interval in ms — must stay below Cloudflare Tunnel's 90s idle timeout. */
const PING_INTERVAL_MS = 30_000;

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
  });

  // Keepalive: ping every 30s to prevent Cloudflare Tunnel 90s idle timeout.
  const pingInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      const ws = client as AliveWebSocket;
      if (ws.isAlive === false) {
        // [WS-DIAG] Keepalive terminate (point #3). Fires when a socket missed the
        // previous ping/pong cycle (>30s unresponsive). This is the server-initiated
        // path that drops a live socket WITHOUT a close code, surfacing on the client
        // as a 1006 abnormal close. If this line precedes a freeze, the keepalive
        // (not the browser/reload) killed the active stream's socket. `userId` is the
        // JWT stamp set by the chat handler; readyState shows the socket's state pre-terminate.
        const diagUserId = (ws as unknown as { userId?: unknown }).userId ?? null;
        console.log(
          `[WS-DIAG] keepalive-terminate userId=${JSON.stringify(diagUserId)} `
          + `readyState=${ws.readyState} reason=missed-pong-30s`
        );
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', (ws, request) => {
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.on('pong', () => {
      aliveWs.isAlive = true;
    });

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      handleShellConnection(ws, incomingRequest, dependencies.shell);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
