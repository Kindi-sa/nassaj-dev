import type { WebSocket } from 'ws';

// Namespace import (not `import { projectsDb, sessionsDb }`): the realtime
// visibility gate below reads `sessionsDb`, but some unit tests module-mock this
// barrel with only the subset they exercise. A namespace binding tolerates a
// member a mock omits (it is only dereferenced on the gate's own code path),
// whereas a static named import would fail ESM linking against such a mock.
import * as databaseModule from '@/modules/database/index.js';
import { sendOpenSessionsCount } from '@/modules/websocket/services/open-sessions.service.js';
import {
  presenceConnect,
  presenceDisconnect,
} from '@/modules/websocket/services/presence.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { addSessionMirror, WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

// Top-level shared/ (compiled into dist-server/shared/) — the single source of
// truth for globally disabled providers (T-864). Relative on purpose: the `@/`
// alias maps to server/* only.
import { isProviderGloballyDisabled } from '../../../../shared/disabledProviders.js';

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

// T-881 (A-4): a per-USER concurrent /btw cap, shared across ALL of a user's
// sockets/tabs and layered ABOVE the per-socket single-flight guard. It stops one
// user from opening many tabs to spawn many simultaneous read-only forks (each a
// real Claude child process). The counter is incremented only once all gates pass
// and the fork is about to spawn, and released in every terminal path (success,
// error, timeout, interrupt, socket close) — see releaseBtw below.
const BTW_MAX_INFLIGHT_PER_USER = 2;
const btwInFlightByUser = new Map<string, number>();

function btwUserKey(userId: string | number | null): string {
  return userId === null || userId === undefined ? '__anon__' : String(userId);
}
function btwUserInFlight(userId: string | number | null): number {
  return btwInFlightByUser.get(btwUserKey(userId)) ?? 0;
}
function acquireBtwUserSlot(userId: string | number | null): void {
  const key = btwUserKey(userId);
  btwInFlightByUser.set(key, (btwInFlightByUser.get(key) ?? 0) + 1);
}
function releaseBtwUserSlot(userId: string | number | null): void {
  const key = btwUserKey(userId);
  const next = (btwInFlightByUser.get(key) ?? 0) - 1;
  if (next <= 0) {
    btwInFlightByUser.delete(key);
  } else {
    btwInFlightByUser.set(key, next);
  }
}

/**
 * Test-only: clears the module-level per-user /btw in-flight counters between
 * unit tests. A unit test that leaves a fork "in flight" (a never-resolving spy)
 * would otherwise leak a per-user slot into the next test. Never used in prod.
 */
export function __resetBtwFloodStateForTests(): void {
  btwInFlightByUser.clear();
}

type ChatWebSocketDependencies = {
  queryClaudeSDK: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnCursor: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  queryCodex: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGemini: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnAntigravity: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnOpenCode: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnHermes: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnKimi: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnDeepSeek: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGlm: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  /**
   * Resolves the authoritative provider for an existing session from the
   * database. Returns null when the session is unknown (e.g. a brand-new
   * conversation that has not been persisted yet).
   */
  getSessionProvider: (sessionId: string) => LLMProvider | null;
  /**
   * T-881: runs a read-only /btw side query by FORKING the resumed live session
   * (resume + forkSession) — never registered in activeSessions, never fanned out
   * to mirrors. Streams the answer through the callbacks; the WS layer forwards
   * them to the requesting socket ALONE. Never rejects; invokes exactly one of
   * onError | onComplete.
   */
  spawnClaudeSideQuery: (
    params: {
      sessionId: string;
      question: string;
      upToMessageId: string | null;
      userId: string | number | null;
      cwd: string | null;
    },
    callbacks: {
      // A-1: fired once with an interrupt handle when the fork is constructed, so
      // the socket-close handler can tear the fork down mid-flight.
      onStarted?: (handle: { interrupt: () => void }) => void;
      onChunk: (text: string) => void;
      onError: (code: string, message: string) => void;
      onComplete: () => void;
    }
  ) => Promise<void>;
  abortClaudeSDKSession: (
    sessionId: string,
    rawWs?: unknown,
  ) => Promise<boolean | { aborted: boolean; reason: string; sessionId: string | null }>;
  abortCursorSession: (sessionId: string) => boolean;
  abortCodexSession: (sessionId: string) => boolean;
  abortGeminiSession: (sessionId: string) => boolean;
  abortAntigravitySession: (sessionId: string) => boolean;
  abortOpenCodeSession: (sessionId: string) => boolean;
  abortHermesSession: (sessionId: string) => boolean;
  abortKimiSession: (sessionId: string) => boolean;
  abortDeepSeekSession: (sessionId: string) => boolean;
  abortGlmSession: (sessionId: string) => boolean;
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
  isHermesSessionActive: (sessionId: string) => boolean;
  isKimiSessionActive: (sessionId: string) => boolean;
  isDeepSeekSessionActive: (sessionId: string) => boolean;
  isGlmSessionActive: (sessionId: string) => boolean;
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
  getActiveHermesSessions: () => unknown;
  getActiveKimiSessions: () => unknown;
  getActiveDeepSeekSessions: () => unknown;
  getActiveGlmSessions: () => unknown;
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
    || value === 'hermes'
    || value === 'kimi'
    || value === 'deepseek'
    || value === 'glm'
  ) {
    return value;
  }

  return DEFAULT_PROVIDER;
}

/**
 * Resolves the authoritative provider for a session-scoped CONTROL message
 * (currently `abort-session`). Mirrors {@link dispatchProviderCommand}'s resume
 * routing: an existing session's persisted provider (the database source of
 * truth) wins over the client-declared provider, which on a control message may
 * carry the user's CURRENT global picker selection rather than THIS session's
 * provider (T-874(3)). Aborting through the wrong provider's handler silently
 * no-ops, leaving the run alive.
 *
 * Falls back to the client-declared provider for a brand-new or unpersisted
 * session — an empty or unknown id — which preserves the Claude empty-sessionId
 * abort-race handling (route to Claude and let it resolve the newest active run
 * on the connection).
 *
 * Exported for unit tests.
 */
export function resolveSessionControlProvider(
  sessionId: string,
  requestedProvider: LLMProvider,
  getSessionProvider: (sessionId: string) => LLMProvider | null
): LLMProvider {
  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!trimmed) {
    return requestedProvider;
  }
  return getSessionProvider(trimmed) ?? requestedProvider;
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
  'hermes-command': 'hermes',
  'kimi-command': 'kimi',
  'deepseek-command': 'deepseek',
  'glm-command': 'glm',
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

  const projectRow = databaseModule.projectsDb.getProjectPath(trimmedPath);
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

  return databaseModule.projectsDb.isProjectVisibleToUser(
    projectRow.project_id,
    Number.isInteger(numericUserId) ? numericUserId : null
  );
}

/**
 * B-137 content-visibility gate for the realtime session paths that take a
 * client-supplied sessionId and expose a session's LIVE stream to the requesting
 * socket — the `check-session-status` mirror/attach/reconnect handler and the
 * `get-active-sessions` listing. Unlike the spawn guard there is no cwd on these
 * paths, so the session is resolved to its project_path (the sessions table) and
 * the SAME project-visibility predicate the spawn guard uses
 * (`isProjectPathVisibleToUser`) is applied: a public project's live session
 * stays visible to the team (the legitimate refreshed-tab / second-viewer case
 * the mirror exists for), while a private project's session is only
 * mirrored/attached/listed for a member (ADR-052).
 *
 * Fail-OPEN only when the session resolves to no known project_path — an
 * unpersisted brand-new session (the run path can outrace the synchronizer) or a
 * null-path session carries no private-project association to protect, matching
 * the spawn guard's unregistered-path allowance and the presence layer's
 * treatment of null-path runs. The lookup is wrapped so a database hiccup never
 * throws on the realtime path (same discipline as participation tracking): an
 * unresolved lookup falls through to that unregistered-path allowance. The actual
 * exploit path — a KNOWN private session whose row resolves — never errors, so
 * the guarantee against a non-member is not weakened by the fail-open.
 */
export function isSessionVisibleToUser(
  sessionId: string,
  userId: string | number | null
): boolean {
  if (!sessionId) {
    return true;
  }

  let projectPath = '';
  try {
    projectPath = databaseModule.sessionsDb.getSessionById(sessionId)?.project_path ?? '';
  } catch {
    return true;
  }

  // Empty / unregistered project_path defers to the unregistered-path allowance
  // inside isProjectPathVisibleToUser (returns true); a KNOWN private project is
  // only visible to its members there.
  return isProjectPathVisibleToUser(projectPath, userId);
}

/**
 * Dispatches a chat command to the handler that owns the resolved provider.
 *
 * Routing is provider-driven, not message-type-driven: when a command carries a
 * resume session id, the persisted provider for that session (looked up in the
 * database) overrides the message type chosen by the client. This prevents a
 * stale client provider selection from resuming, say, an antigravity session
 * through the Claude SDK — which would fail with "No conversation found".
 *
 * Globally disabled providers (T-864, shared/disabledProviders.ts) are refused
 * here — defence in depth behind the UI filtering. The check runs on the
 * RESOLVED target provider so it also covers a resume of a historical session
 * that belongs to a now-disabled provider (its transcript stays readable over
 * the REST history path; only new runs are blocked).
 *
 * Exported for unit tests.
 */
export async function dispatchProviderCommand(
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

  if (isProviderGloballyDisabled(targetProvider)) {
    console.log(`[INFO] Refusing dispatch for globally disabled provider "${targetProvider}"`);
    writer.send(
      createNormalizedMessage({
        kind: 'complete',
        provider: targetProvider,
        exitCode: 1,
        success: false,
        error:
          `Provider "${targetProvider}" is disabled on this deployment. `
          + 'Existing sessions remain readable, but new runs are rejected.',
      })
    );
    return;
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
  if (targetProvider === 'hermes') {
    await dependencies.spawnHermes(command, data.options, writer);
    return;
  }
  if (targetProvider === 'kimi') {
    await dependencies.spawnKimi(command, data.options, writer);
    return;
  }
  if (targetProvider === 'deepseek') {
    await dependencies.spawnDeepSeek(command, data.options, writer);
    return;
  }
  if (targetProvider === 'glm') {
    await dependencies.spawnGlm(command, data.options, writer);
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

  // T-881 flood guard: at most ONE in-flight /btw side query per socket. The
  // second is refused with `busy` until the first reaches a terminal state.
  let btwInFlight = false;
  // A-1 teardown state for the socket's current in-flight /btw fork. `interrupt`
  // tears the fork down; `release` frees both flood slots (per-socket + per-user).
  // Both are null between queries. `btwSocketClosed` guards the race where the
  // socket closes before the fork's onStarted handle has arrived.
  let btwSocketClosed = false;
  let btwActiveInterrupt: (() => void) | null = null;
  let btwActiveRelease: (() => void) | null = null;
  // /btw replies go to THIS requesting socket ALONE (contract C2): a raw send
  // that bypasses WebSocketWriter entirely, so there is no sessionId-keyed
  // fan-out to mirrors. btw payloads carry `btwId`, never `sessionId`.
  const sendBtwRaw = (payload: Record<string, unknown>): void => {
    if ((ws as { readyState?: number }).readyState === WS_OPEN_STATE) {
      ws.send(JSON.stringify(payload));
    }
  };

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
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        // T-874(3): abort the session's OWN persisted provider, not the
        // client-declared one (which may be the current global picker selection).
        // Empty/unknown id falls back to the client provider, preserving Claude's
        // empty-sessionId abort-race fallback below.
        const provider = resolveSessionControlProvider(
          sessionId,
          readProvider(data.provider),
          dependencies.getSessionProvider
        );
        let success = false;
        // The session the abort actually resolved to (claude may fall back to the
        // newest active run on this connection when the id is missing/stale).
        let resolvedSessionId: string | null = sessionId || null;
        let abortReason: string | null = null;

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
        } else if (provider === 'hermes') {
          success = dependencies.abortHermesSession(sessionId);
        } else if (provider === 'kimi') {
          success = dependencies.abortKimiSession(sessionId);
        } else if (provider === 'deepseek') {
          success = dependencies.abortDeepSeekSession(sessionId);
        } else if (provider === 'glm') {
          success = dependencies.abortGlmSession(sessionId);
        } else {
          // Claude: pass the raw socket so the SDK can fall back to this
          // connection's newest active run when `sessionId` is empty/stale
          // (the brand-new-session abort race). Result is structured.
          const result = await dependencies.abortClaudeSDKSession(sessionId, ws);
          if (typeof result === 'boolean') {
            success = result;
          } else {
            success = result.aborted;
            abortReason = result.reason;
            if (result.sessionId) {
              resolvedSessionId = result.sessionId;
            }
          }
        }

        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            // Echo the session the abort resolved to so the client clears the
            // right run's spinner even when it sent an empty/stale id.
            sessionId: resolvedSessionId ?? sessionId,
            provider,
            ...(success ? {} : { abortFailed: true, error: abortReason ?? 'abort failed' }),
          })
        );
        return;
      }

      // T-881: /btw side query — a read-only "by the way" question answered
      // against a LIVE session by forking it, WITHOUT touching the live stream.
      // The design gate approved "البديل 2" (SDK fork); every gate is enforced
      // here (visibility, provider, flood) and in spawnClaudeSideQuery (fork
      // isolation, read-only tools, per-user env). Replies go to THIS socket ONLY.
      if (messageType === 'btw-query') {
        const btwId = typeof data.btwId === 'string' ? data.btwId : '';
        // Without a correlation id the client cannot match the reply — drop it.
        if (!btwId) {
          return;
        }
        const btwSessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
        const question = typeof data.question === 'string' ? data.question : '';
        const upToMessageId =
          typeof data.upToMessageId === 'string' && data.upToMessageId.trim() !== ''
            ? data.upToMessageId.trim()
            : null;

        const emitBtwError = (code: string, message: string): void =>
          sendBtwRaw({ type: 'btw-error', btwId, code, message });

        // Flood guard (C: busy): one in-flight /btw per socket.
        if (btwInFlight) {
          emitBtwError('busy', 'Another /btw query is already running on this connection.');
          return;
        }
        if (!btwSessionId) {
          emitBtwError('session_not_found', 'No session was specified for the /btw query.');
          return;
        }
        // C3 content-visibility gate: a non-member never forks a private-project
        // session (same 404-equivalent the mirror/attach path returns). Checked
        // BEFORE any fork is spawned.
        if (!isSessionVisibleToUser(btwSessionId, presenceUserId)) {
          emitBtwError('not_visible', 'Session not found.');
          return;
        }
        // Restricted to the claude provider (engineProvider sealed with the
        // session). An unknown session (no persisted row) is session_not_found;
        // a non-claude session is unsupported_provider. Neither spawns a fork.
        const sessionProvider = dependencies.getSessionProvider(btwSessionId);
        if (sessionProvider === null) {
          emitBtwError('session_not_found', 'Session not found.');
          return;
        }
        if (sessionProvider !== 'claude') {
          emitBtwError(
            'unsupported_provider',
            `/btw supports Claude sessions only (this session runs on "${sessionProvider}").`
          );
          return;
        }
        // Fork cwd = the session's project path so CLAUDE.md / project settings
        // load in the session's own context. Best-effort lookup (null on any miss).
        let btwProjectPath: string | null = null;
        try {
          btwProjectPath = databaseModule.sessionsDb.getSessionById(btwSessionId)?.project_path ?? null;
        } catch {
          btwProjectPath = null;
        }
        // A-2.3 / A-3 gate: a /btw fork MUST run inside the session's project. If
        // the path is unknown we refuse (sdk_error) rather than let the fork
        // inherit the server cwd — the fork layer enforces the same, this is the
        // gate that must pass BEFORE the accept frame below.
        if (!btwProjectPath || btwProjectPath.trim() === '') {
          emitBtwError('sdk_error', 'The project path for this session could not be determined.');
          return;
        }
        // A-4 per-user flood cap (busy): across ALL of this user's sockets.
        if (btwUserInFlight(presenceUserId) >= BTW_MAX_INFLIGHT_PER_USER) {
          emitBtwError('busy', 'You have too many /btw queries running. Try again shortly.');
          return;
        }

        // A-3: every gate has passed — ACK acceptance to the requester BEFORE the
        // fork spawns, so the client can cancel its fallback timeout. Then reserve
        // both flood slots (per-socket + per-user).
        sendBtwRaw({ type: 'btw-accepted', btwId });
        btwInFlight = true;
        acquireBtwUserSlot(presenceUserId);
        let btwReleased = false;
        const releaseBtw = (): void => {
          if (btwReleased) {
            return;
          }
          btwReleased = true;
          btwInFlight = false;
          releaseBtwUserSlot(presenceUserId);
          btwActiveInterrupt = null;
          btwActiveRelease = null;
        };
        btwActiveRelease = releaseBtw;

        void dependencies
          .spawnClaudeSideQuery(
            {
              sessionId: btwSessionId,
              question,
              upToMessageId,
              userId: presenceUserId, // C3: the REQUESTER's creds, not the owner's
              cwd: btwProjectPath,
            },
            {
              // A-1: remember the fork's interrupt handle so the close handler can
              // tear it down. If the socket already closed in the (tiny) window
              // before the fork materialised, interrupt it at once.
              onStarted: (handle: { interrupt: () => void }) => {
                if (btwSocketClosed) {
                  try {
                    handle.interrupt();
                  } catch {
                    /* best-effort teardown */
                  }
                  return;
                }
                btwActiveInterrupt = handle.interrupt;
              },
              onChunk: (text: string) => sendBtwRaw({ type: 'btw-chunk', btwId, text }),
              onError: (code: string, message: string) => {
                releaseBtw();
                emitBtwError(code, message);
              },
              onComplete: () => {
                releaseBtw();
                sendBtwRaw({ type: 'btw-complete', btwId });
              },
            }
          )
          // spawnClaudeSideQuery is contracted never to reject; this is a pure
          // safety net that only frees the slots (no double error emission).
          .catch(() => releaseBtw());
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

        // B-137: the mirror + attach-replay + writer-reconnect below all expose
        // this session's live stream (transcript, permission prompts, tool
        // output) to the requesting socket. Refuse them when the session's
        // project is not visible to this user — a private project they are not a
        // member of — returning the same 404-equivalent an unknown/inactive
        // session would: NO mirror registered, NO buffered payloads replayed, NO
        // writer swapped, and the activity is never even probed.
        if (sessionId && !isSessionVisibleToUser(sessionId, presenceUserId)) {
          writer.send({
            type: 'session-status',
            sessionId,
            provider,
            isProcessing: false,
          });
          return;
        }

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
        } else if (provider === 'hermes') {
          isActive = dependencies.isHermesSessionActive(sessionId);
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
        // B-144: (a) never leak the ids of runs this user cannot see — filter
        // every provider's active-id list through the SAME visibility predicate
        // as check-session-status (a private-project run is dropped for a
        // non-member, an unknown/null-path run stays visible like presence);
        // (b) surface the kimi/deepseek/glm providers that were silently omitted
        // from this listing.
        const visibleIds = (ids: unknown): string[] =>
          (Array.isArray(ids) ? ids : []).filter(
            (id): id is string =>
              typeof id === 'string' && isSessionVisibleToUser(id, presenceUserId)
          );

        writer.send({
          type: 'active-sessions',
          sessions: {
            claude: visibleIds(dependencies.getActiveClaudeSDKSessions()),
            cursor: visibleIds(dependencies.getActiveCursorSessions()),
            codex: visibleIds(dependencies.getActiveCodexSessions()),
            gemini: visibleIds(dependencies.getActiveGeminiSessions()),
            antigravity: visibleIds(dependencies.getActiveAntigravitySessions()),
            opencode: visibleIds(dependencies.getActiveOpenCodeSessions()),
            hermes: visibleIds(dependencies.getActiveHermesSessions()),
            kimi: visibleIds(dependencies.getActiveKimiSessions()),
            deepseek: visibleIds(dependencies.getActiveDeepSeekSessions()),
            glm: visibleIds(dependencies.getActiveGlmSessions()),
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
    // T-881 (A-1): the requester is gone, so any in-flight /btw fork bound to this
    // socket is moot — interrupt it and free its flood slots (per-socket +
    // per-user). `btwSocketClosed` also covers the race where onStarted arrives
    // after close (it interrupts immediately then). Capture the handles before
    // calling: releaseBtw() nulls them, and the fork's own terminal callback will
    // call releaseBtw() again — the idempotency guard makes that a no-op.
    btwSocketClosed = true;
    const btwInterruptOnClose = btwActiveInterrupt;
    const btwReleaseOnClose = btwActiveRelease;
    if (btwInterruptOnClose) {
      try {
        btwInterruptOnClose();
      } catch {
        /* best-effort teardown */
      }
    }
    if (btwReleaseOnClose) {
      btwReleaseOnClose();
    }
    connectedClients.delete(ws);
    // Drop this socket from presence; the user stays "connected" while any of
    // their other tabs/devices keep a socket open (multi-tab dedupe).
    presenceDisconnect(ws);
  });
}
