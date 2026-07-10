/**
 * T-822 GATE (tester) — MINIMAL REAL WS-SEAT SERVER. Closes the acceptance gap
 * "the live seat was proven with a mirror, not driven through the server's real
 * WS path". This stands up the SHIPPED websocket gateway (createWebSocketServer →
 * verifyWebSocketClient token auth → handleChatConnection → dispatchProviderCommand
 * → queryClaudeSDK → runClaudeSDKQuery), so a real `claude-command` over a real
 * authenticated socket exercises the EXACT critical-path seam in claude-sdk.js
 * (isChatTurnLockEnabled() && sessionId ? await acquireChatTurnLockForLiveTurn(...)
 * : null; … finally release). Every non-claude provider is a no-op stub — only the
 * Claude path is real. Nothing here touches the live process/port/DB: temp DB,
 * temp HOME, temp state dir, loopback-only high port, all from env.
 *
 * JWT_SECRET is supplied via env so auth.js resolves it at import and /mint issues
 * a token the same verifier accepts. DB init logs are redirected to stderr so the
 * only stdout is the READY line and (optionally) a minted token.
 */

import http from 'node:http';

import { createWebSocketServer } from '@/modules/websocket/index.js';
import { authenticateWebSocket, JWT_SECRET, generateToken } from '@/middleware/auth.js';
import { recordAuthRejection } from '@/middleware/auth-rejection-audit.js';
import { clientIp } from '@/utils/client-ip.js';
import { initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  attachClaudeSDKSession,
} from '@/claude-sdk.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const noop = async (): Promise<void> => {};
const noFalse = (): boolean => false;
const noArr = (): unknown[] => [];

async function main(): Promise<void> {
  const realLog = console.log;
  console.log = (...a: unknown[]): void => process.stderr.write(a.map(String).join(' ') + '\n');
  await initializeDatabase();
  console.log = realLog;

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.pathname === '/mint') {
        const id = Number(u.searchParams.get('u'));
        const user = (userDb as any).getUserById(id);
        if (!user) {
          res.statusCode = 404;
          res.end('no-user');
          return;
        }
        res.statusCode = 200;
        res.end(generateToken(user));
        return;
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });

  createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false,
      authenticateWebSocket,
      jwtSecret: JWT_SECRET,
      recordRejection: recordAuthRejection,
      clientIp,
    } as any,
    chat: {
      queryClaudeSDK,
      // real claude wiring
      getSessionProvider: (sessionId: string) => {
        try {
          return (sessionsDb as any).getSessionById(sessionId)?.provider ?? null;
        } catch {
          return null;
        }
      },
      abortClaudeSDKSession,
      resolveToolApproval,
      isClaudeSDKSessionActive,
      reconnectSessionWriter,
      attachClaudeSDKSession,
      getPendingApprovalsForSession,
      getActiveClaudeSDKSessions,
      // every OTHER provider is an inert stub (never invoked by a claude-command)
      spawnCursor: noop,
      queryCodex: noop,
      spawnGemini: noop,
      spawnAntigravity: noop,
      spawnOpenCode: noop,
      spawnHermes: noop,
      spawnKimi: noop,
      spawnDeepSeek: noop,
      spawnGlm: noop,
      abortCursorSession: noFalse,
      abortCodexSession: noFalse,
      abortGeminiSession: noFalse,
      abortAntigravitySession: noFalse,
      abortOpenCodeSession: noFalse,
      abortHermesSession: noFalse,
      abortKimiSession: noFalse,
      abortDeepSeekSession: noFalse,
      abortGlmSession: noFalse,
      isCursorSessionActive: noFalse,
      isCodexSessionActive: noFalse,
      isGeminiSessionActive: noFalse,
      isAntigravitySessionActive: noFalse,
      isOpenCodeSessionActive: noFalse,
      isHermesSessionActive: noFalse,
      isKimiSessionActive: noFalse,
      isDeepSeekSessionActive: noFalse,
      isGlmSessionActive: noFalse,
      attachAntigravitySession: noop,
      getActiveCursorSessions: noArr,
      getActiveCodexSessions: noArr,
      getActiveGeminiSessions: noArr,
      getActiveAntigravitySessions: noArr,
      getActiveOpenCodeSessions: noArr,
      getActiveHermesSessions: noArr,
      getActiveKimiSessions: noArr,
      getActiveDeepSeekSessions: noArr,
      getActiveGlmSessions: noArr,
    } as any,
    shell: {} as any,
    getPluginPort: (() => null) as any,
  });

  const port = Number(process.env.SEAT_PORT || 39004);
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`SEAT_READY port=${port} pid=${process.pid}\n`);
  });
}

main().catch((e) => {
  process.stderr.write('seat-server fatal: ' + (e instanceof Error ? e.stack : String(e)) + '\n');
  process.exit(1);
});
