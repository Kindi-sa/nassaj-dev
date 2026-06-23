import type { WebSocket } from 'ws';

import { projectsDb } from '@/modules/database/index.js';
import { sendOpenSessionsCount } from '@/modules/websocket/services/open-sessions.service.js';
import {
  presenceConnect,
  presenceDisconnect,
} from '@/modules/websocket/services/presence.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { addSessionMirror, WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

type ChatIncomingMessage = AnyRecord & {
  type?: string;
  command?: string;
  options?: AnyRecord;
  provider?: string;
  sessionId?: string;
  requestId?: string;
  allow?: unknown;
  updatedInput?: unknown;
  message?: unknown;
  rememberEntry?: unknown;
  lastSeq?: unknown;
};

const DEFAULT_PROVIDER: LLMProvider = 'claude';

type ChatWebSocketDependencies = {
  queryClaudeSDK: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnCursor: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  queryCodex: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGemini: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnAntigravity: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnOpenCode: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  /**
   * Resolves the authoritative provider for an existing session from the
   * database. Returns null when the session is unknown (e.g. a brand-new
   * conversation that has not been persisted yet).
   */
  getSessionProvider: (sessionId: string) => LLMProvider | null;
  abortClaudeSDKSession: (sessionId: string) => Promise<boolean>;
  abortCursorSession: (sessionId: string) => boolean;
  abortCodexSession: (sessionId: string) => boolean;
  abortGeminiSession: (sessionId: string) => boolean;
  abortAntigravitySession: (sessionId: string) => boolean;
  abortOpenCodeSession: (sessionId: string) => boolean;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
  isCursorSessionActive: (sessionId: string) => boolean;
  isCodexSessionActive: (sessionId: string) => boolean;
  isGeminiSessionActive: (sessionId: string) => boolean;
  isAntigravitySessionActive: (sessionId: string) => boolean;
  isOpenCodeSessionActive: (sessionId: string) => boolean;
  reconnectSessionWriter: (sessionId: string, ws: WebSocket) => boolean;
  /**
   * B-N-ATTACH (PHASE-SR-0): read-only differential replay for agy. Re-emits the
   * buffered payloads with `seq > lastSeq` via `send`, oldest-first, and returns
   * the highest seq replayed. It performs NO writer swap and NO session abort —
   * it strictly reads the per-session RingBuffer. No-op (returns lastSeq) when the
   * SESSION_REGISTRY_agy flag is off.
   */
  attachAntigravitySession: (
    sessionId: string,
    lastSeq: number,
    send: (payload: unknown) => void
  ) => number;
  /**
   * ADR-041 (B-80): read-only differential replay for claude — same contract as
   * attachAntigravitySession, on a separate SESSION_REGISTRY_claude-gated
   * registry instance. Re-emits buffered payloads with `seq > lastSeq` via
   * `send`, oldest-first, and returns the highest seq replayed. It performs NO
   * writer swap and NO session abort (the `if(!isActive)` no-swap veto stays
   * intact); it strictly reads the per-session RingBuffer. No-op (returns
   * lastSeq) when the SESSION_REGISTRY_claude flag is off.
   */
  attachClaudeSDKSession: (
    sessionId: string,
    lastSeq: number,
    send: (payload: unknown) => void
  ) => number;
  getPendingApprovalsForSession: (sessionId: string) => unknown[];
  getActiveClaudeSDKSessions: () => unknown;
  getActiveCursorSessions: () => unknown;
  getActiveCodexSessions: () => unknown;
  getActiveGeminiSessions: () => unknown;
  getActiveAntigravitySessions: () => unknown;
  getActiveOpenCodeSessions: () => unknown;
};

/**
 * Normalizes potentially invalid provider names coming from websocket payloads.
 */
function readProvider(value: unknown): LLMProvider {
  if (
    value === 'claude'
    || value === 'cursor'
    || value === 'codex'
    || value === 'gemini'
    || value === 'antigravity'
    || value === 'opencode'
  ) {
    return value;
  }

  return DEFAULT_PROVIDER;
}

/**
 * Maps each chat command message type to the provider its payload was authored
 * for by the client. Used as the *default* routing target before the database
 * provider (the source of truth for resumed sessions) is consulted.
 */
const COMMAND_TYPE_TO_PROVIDER: Record<string, LLMProvider> = {
  'claude-command': 'claude',
  'cursor-command': 'cursor',
  'codex-command': 'codex',
  'gemini-command': 'gemini',
  'antigravity-command': 'antigravity',
};

/**
 * Reads the resume session id carried by a chat command payload. The client
 * places it on `options.sessionId` for every provider and additionally on the
 * top-level `sessionId` for the CLI providers, so we accept either form.
 */
function readResumeSessionId(data: ChatIncomingMessage): string | null {
  const options = (data.options ?? {}) as { sessionId?: unknown };
  const fromOptions = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (fromOptions) {
    return fromOptions;
  }

  const fromTop = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return fromTop || null;
}

/**
 * B-PRIV spawn guard. A run is started against `options.cwd` (a project path).
 * If that path maps to a KNOWN private project the user is not a member of, the
 * run is refused so a non-member cannot start a session inside a private
 * project's directory (which would also leak its content through the stream).
 *
 * Unregistered paths (no projects row yet) are allowed — that is the creation
 * flow, which records the spawner as the project's participant/creator. Returns
 * true when the spawn may proceed.
 */
function isSpawnProjectVisible(
  data: ChatIncomingMessage,
  userId: string | number | null
): boolean {
  const options = (data.options ?? {}) as { cwd?: unknown };
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  return isProjectPathVisibleToUser(cwd, userId);
}

/**
 * Path-based form of the B-PRIV spawn guard, shared with the `/shell` PTY
 * handler (B-36): given a raw project path and the JWT-authenticated user id,
 * returns true when a run/terminal may be started inside that path. Empty and
 * unregistered paths are allowed (creation/first-run flow); a KNOWN private
 * project is only visible to its members.
 */
export function isProjectPathVisibleToUser(
  projectPath: string,
  userId: string | number | null
): boolean {
  const trimmedPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!trimmedPath) {
    return true;
  }

  const projectRow = projectsDb.getProjectPath(trimmedPath);
  if (!projectRow) {
    // Path not yet registered as a project — creation/first-run flow.
    return true;
  }

  const numericUserId =
    typeof userId === 'number'
      ? userId
      : typeof userId === 'string' && userId.trim() !== ''
        ? Number.parseInt(userId, 10)
        : null;

  return projectsDb.isProjectVisibleToUser(
    projectRow.project_id,
    Number.isInteger(numericUserId) ? numericUserId : null
  );
}

/**
 * Dispatches a chat command to the handler that owns the resolved provider.
 *
 * Routing is provider-driven, not message-type-driven: when a command carries a
 * resume session id, the persisted provider for that session (looked up in the
 * database) overrides the message type chosen by the client. This prevents a
 * stale client provider selection from resuming, say, an antigravity session
 * through the Claude SDK — which would fail with "No conversation found".
 */
async function dispatchProviderCommand(
  messageType: string,
  data: ChatIncomingMessage,
  writer: WebSocketWriter,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const command = data.command ?? '';
  const requestedProvider = COMMAND_TYPE_TO_PROVIDER[messageType] ?? DEFAULT_PROVIDER;

  // Only existing (resumed) sessions can be re-routed; a fresh conversation has
  // no persisted provider yet, so we honour the client's chosen handler.
  const resumeSessionId = readResumeSessionId(data);
  const persistedProvider = resumeSessionId
    ? dependencies.getSessionProvider(resumeSessionId)
    : null;
  const targetProvider = persistedProvider ?? requestedProvider;

  if (persistedProvider && persistedProvider !== requestedProvider) {
    console.log(
      `[INFO] Re-routing resumed session ${resumeSessionId} from `
      + `${requestedProvider} to persisted provider ${persistedProvider}`
      + (data.options?.effort ? ` (effort=${data.options.effort} will be dropped)` : '')
    );
  }

  if (targetProvider === 'cursor') {
    await dependencies.spawnCursor(command, data.options, writer);
    return;
  }
  if (targetProvider === 'codex') {
    await dependencies.queryCodex(command, data.options, writer);
    return;
  }
  if (targetProvider === 'gemini') {
    await dependencies.spawnGemini(command, data.options, writer);
    return;
  }
  if (targetProvider === 'antigravity') {
    await dependencies.spawnAntigravity(command, data.options, writer);
    return;
  }

  await dependencies.queryClaudeSDK(command, data.options, writer);
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 *
 * Exported so the shell (PTY) path resolves the JWT-authenticated user id with
 * the exact same precedence as chat (B-MU-PTY-AUTH), keeping a single source of
 * truth for `request.user → userId` across both websocket routes.
 */
export function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  // [WS-DIAG] Socket birth marker — used to compute socket lifetime at close and
  // to correlate a reconnecting socket with a prior active stream. Diagnostic only.
  const wsDiagOpenedAt = Date.now();
  const wsDiagSocketId = `s${wsDiagOpenedAt.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  console.log(
    `[WS-DIAG] open socket=${wsDiagSocketId} activeClaudeSessions=`
    + `${JSON.stringify(dependencies.getActiveClaudeSDKSessions())}`
  );
  connectedClients.add(ws);

  // Live presence (B-MU-UX-PRESENCE): register this authenticated socket as
  // "connected". The userId is read strictly from the JWT-authenticated request
  // (same precedence as the chat writer), never from client input.
  const presenceUserId = readRequestUserId(request);
  presenceConnect(ws, request.user, presenceUserId);

  // Stamp the JWT-derived identity on the shared socket so broadcasters (e.g.
  // the sessions watcher's `projects_updated`) can compute per-user fields like
  // `isMember` for each client (B-MU-UX-FIX-WSMEMBER).
  (ws as RealtimeClientConnection).userId = presenceUserId;

  // Open-sessions counter: push the initial server-wide count to this client
  // immediately; afterwards it only receives change broadcasts.
  sendOpenSessionsCount(ws as RealtimeClientConnection);

  const writer = new WebSocketWriter(ws, presenceUserId);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as ChatIncomingMessage;
      const messageType = data.type;
      if (!messageType) {
        throw new Error('Message type is required');
      }

      // B-PRIV: refuse to start/resume a run inside a private project the
      // authenticated user is not a member of (404-equivalent over WS).
      const isSpawnMessage =
        messageType in COMMAND_TYPE_TO_PROVIDER ||
        messageType === 'opencode-command' ||
        messageType === 'cursor-resume';
      if (isSpawnMessage && !isSpawnProjectVisible(data, presenceUserId)) {
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            provider: COMMAND_TYPE_TO_PROVIDER[messageType] ?? DEFAULT_PROVIDER,
            exitCode: 1,
            success: false,
            error: 'Project not found',
          })
        );
        return;
      }

      if (messageType in COMMAND_TYPE_TO_PROVIDER) {
        await dispatchProviderCommand(messageType, data, writer, dependencies);
        return;
      }

      if (messageType === 'opencode-command') {
        await dependencies.spawnOpenCode(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-resume') {
        await dependencies.spawnCursor(
          '',
          {
            sessionId: data.sessionId,
            resume: true,
            cwd: data.options?.cwd,
          },
          writer
        );
        return;
      }

      if (messageType === 'abort-session') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let success = false;

        if (provider === 'cursor') {
          success = dependencies.abortCursorSession(sessionId);
        } else if (provider === 'codex') {
          success = dependencies.abortCodexSession(sessionId);
        } else if (provider === 'gemini') {
          success = dependencies.abortGeminiSession(sessionId);
        } else if (provider === 'antigravity') {
          success = dependencies.abortAntigravitySession(sessionId);
        } else if (provider === 'opencode') {
          success = dependencies.abortOpenCodeSession(sessionId);
        } else {
          success = await dependencies.abortClaudeSDKSession(sessionId);
        }

        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider,
          })
        );
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          dependencies.resolveToolApproval(data.requestId, {
            allow: Boolean(data.allow),
            updatedInput: data.updatedInput,
            message: typeof data.message === 'string' ? data.message : undefined,
            rememberEntry: data.rememberEntry,
          });
        }
        return;
      }

      if (messageType === 'cursor-abort') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const success = dependencies.abortCursorSession(sessionId);
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider: 'cursor',
          })
        );
        return;
      }

      if (messageType === 'check-session-status') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let isActive = false;

        // Realtime mirror (all providers): register this socket as a READ-ONLY
        // copy-receiver of the session's live stream (WebSocketWriter fan-out).
        // A refreshed tab or a second user viewing the same session gets the
        // stream — including permission prompts — without ever touching the
        // active writer, honouring the documented no-swap veto below.
        // NOTE for SESSION_REGISTRY_agy: when that flag is enabled, the
        // attach-replay below may overlap with the first mirrored live
        // payloads; dedup by seq on the client before enabling.
        if (sessionId) {
          addSessionMirror(sessionId, ws);
        }

        if (provider === 'cursor') {
          isActive = dependencies.isCursorSessionActive(sessionId);
        } else if (provider === 'codex') {
          isActive = dependencies.isCodexSessionActive(sessionId);
        } else if (provider === 'gemini') {
          isActive = dependencies.isGeminiSessionActive(sessionId);
        } else if (provider === 'antigravity') {
          isActive = dependencies.isAntigravitySessionActive(sessionId);
          // B-N-ATTACH: read-only differential replay. A reconnecting socket gets
          // only the buffered payloads it has not seen (seq > lastSeq) re-emitted
          // to ITS writer. This deliberately does NOT call reconnectSessionWriter
          // and never aborts the run — the active writer of the live session is
          // left untouched, honouring the documented `if(!isActive)` veto. No-op
          // when SESSION_REGISTRY_agy is off.
          const rawLastSeq = typeof data.lastSeq === 'number' ? data.lastSeq : Number(data.lastSeq);
          const lastSeq = Number.isFinite(rawLastSeq) ? rawLastSeq : 0;
          dependencies.attachAntigravitySession(sessionId, lastSeq, (payload) => {
            writer.send(payload);
          });
        } else if (provider === 'opencode') {
          isActive = dependencies.isOpenCodeSessionActive(sessionId);
        } else {
          isActive = dependencies.isClaudeSDKSessionActive(sessionId);
          // [WS-DIAG] Re-subscribe decision for a reconnecting socket (point #4).
          // This is THE branch that decides whether an active Claude stream is
          // re-bound to the new socket or left orphaned. `isActive===true` means
          // the run is still streaming, so the writer swap is VETOED below and the
          // new socket only gets future payloads via the mirror fan-out (it does
          // NOT take over the primary writer, whose this.ws still points at the
          // dead socket). `isActive===false` → writer swap is attempted.
          console.log(
            `[WS-DIAG] check-session-status claude socket=${wsDiagSocketId} `
            + `session=${sessionId} isActive=${isActive} mirrorRegistered=${Boolean(sessionId)} `
            + `writerSwapAttempted=${!isActive}`
          );
          // ADR-041 (B-80): read-only differential replay for claude, mirroring the
          // antigravity branch above. A reconnecting socket gets ONLY the buffered
          // payloads it has not seen (seq > lastSeq) re-emitted to ITS writer,
          // running BEFORE the isActive veto so an ACTIVE stream (the freeze case)
          // is caught up without ever swapping the primary writer or aborting the
          // run. This deliberately does NOT call reconnectSessionWriter and never
          // touches the `if(!isActive)` veto below. No-op when SESSION_REGISTRY_claude
          // is off (returns lastSeq, sends nothing). The mirror registration above
          // (addSessionMirror) still delivers FUTURE payloads; this replay closes
          // the gap between socket death and mirror registration.
          const rawLastSeq = typeof data.lastSeq === 'number' ? data.lastSeq : Number(data.lastSeq);
          const lastSeq = Number.isFinite(rawLastSeq) ? rawLastSeq : 0;
          dependencies.attachClaudeSDKSession(sessionId, lastSeq, (payload) => {
            writer.send(payload);
          });
          // Writer swap must NOT happen while a query is active (tool_use in progress).
          // Swapping the writer mid-query desynchronises the SDK from the WebSocket
          // and causes "The user doesn't want to proceed with this tool use." aborts.
          // Only reconnect when the session exists but is idle (not processing).
          if (!isActive) {
            const swapped = dependencies.reconnectSessionWriter(sessionId, ws);
            console.log(
              `[WS-DIAG] reconnectSessionWriter claude socket=${wsDiagSocketId} `
              + `session=${sessionId} swapped=${swapped}`
            );
          }
        }

        writer.send({
          type: 'session-status',
          sessionId,
          provider,
          isProcessing: isActive,
        });
        return;
      }

      if (messageType === 'get-pending-permissions') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (sessionId && dependencies.isClaudeSDKSessionActive(sessionId)) {
          const pending = dependencies.getPendingApprovalsForSession(sessionId);
          writer.send({
            type: 'pending-permissions-response',
            sessionId,
            data: pending,
          });
        }
        return;
      }

      if (messageType === 'get-active-sessions') {
        writer.send({
          type: 'active-sessions',
          sessions: {
            claude: dependencies.getActiveClaudeSDKSessions(),
            cursor: dependencies.getActiveCursorSessions(),
            codex: dependencies.getActiveCodexSessions(),
            gemini: dependencies.getActiveGeminiSessions(),
            antigravity: dependencies.getActiveAntigravitySessions(),
            opencode: dependencies.getActiveOpenCodeSessions(),
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      writer.send({
        type: 'error',
        error: message,
      });
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log('[INFO] Chat client disconnected');
    // [WS-DIAG] Socket close forensics (point #1). The current production code
    // ignores (code, reason); capture them to distinguish:
    //   1006 = abnormal/no-close-frame (proxy/network drop, Cloudflare idle, keepalive terminate)
    //   1001 = going away (page reload / nav) — server graceful drain also uses 1001
    //   1000 = normal closure
    // `activeClaudeSessions` at close is the key signal: if it is non-empty, a run
    // was streaming when this socket died — the writer is now detached (its this.ws
    // points at this dead socket) and the run keeps consuming SDK output into a
    // no-op send until it completes or aborts. `writerSessionId` is the session this
    // socket's writer was bound to (the spawner of the run), null for a viewer/mirror.
    const wsDiagActiveClaude = dependencies.getActiveClaudeSDKSessions();
    console.log(
      `[WS-DIAG] close socket=${wsDiagSocketId} code=${code} `
      + `reason=${JSON.stringify(reason?.toString() ?? '')} `
      + `lifetimeMs=${Date.now() - wsDiagOpenedAt} `
      + `writerSessionId=${JSON.stringify(writer.getSessionId())} `
      + `activeClaudeSessions=${JSON.stringify(wsDiagActiveClaude)} `
      + `hadActiveStreamAtClose=${Array.isArray(wsDiagActiveClaude) && wsDiagActiveClaude.length > 0}`
    );
    connectedClients.delete(ws);
    // Drop this socket from presence; the user stays "connected" while any of
    // their other tabs/devices keep a socket open (multi-tab dedupe).
    presenceDisconnect(ws);
  });
}
