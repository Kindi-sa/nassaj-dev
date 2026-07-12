/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { Codex } from '@openai/codex-sdk';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createNormalizedMessage, stampCoordinatorId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { participantsDb } from './modules/database/index.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { classifyCodexFailure } from './modules/providers/list/codex/codex-failure.js';

// Track active sessions
const activeCodexSessions = new Map();
const activeCodexTurnLocks = new Set();

async function prepareCodexInput(command, images) {
  const imageList = Array.isArray(images) ? images : [];
  if (imageList.length === 0) {
    return { input: command, tempDir: null };
  }

  // Create the scratch dir first, then guard everything after it with a
  // try/finally. A mid-loop failure (e.g. fs.writeFile throwing before the
  // caller captures `tempDir` into `imagesTempDir`) would otherwise orphan the
  // directory, because the caller's deterministic cleanup only fires once it
  // holds the handle. The dir is handed to the caller — and cleanup skipped
  // here — solely on the committed success path.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nassaj-codex-images-'));
  let committed = false;
  try {
    const input = [{ type: 'text', text: command }];
    for (const [index, image] of imageList.entries()) {
      const match = typeof image?.data === 'string'
        ? image.data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/)
        : null;
      if (!match) {
        continue;
      }
      const extension = match[1].split('/')[1].replace(/[^a-zA-Z0-9]/g, '') || 'png';
      const imagePath = path.join(tempDir, `image-${index}.${extension}`);
      await fs.writeFile(imagePath, Buffer.from(match[2], 'base64'), { mode: 0o600 });
      input.push({ type: 'local_image', path: imagePath });
    }

    if (input.length === 1) {
      // No decodable image survived — hand back the plain command; the finally
      // block below removes the now-empty scratch dir.
      return { input: command, tempDir: null };
    }
    committed = true;
    return { input, tempDir };
  } finally {
    if (!committed) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch((error) => {
        console.warn('[Codex] Failed to clean temporary images:', error?.message || error);
      });
    }
  }
}

function readUsageNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCodexTokenBudget(event) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info?.model_context_window || event?.usage?.model_context_window) || 200000,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const lockKey = typeof options.sessionId === 'string' && options.sessionId
    ? options.sessionId
    : null;
  if (lockKey && activeCodexTurnLocks.has(lockKey)) {
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      code: 'session_busy',
      content: 'This Codex conversation is already processing another message.',
      sessionId: lockKey,
      provider: 'codex',
    }));
    return;
  }
  if (lockKey) {
    activeCodexTurnLocks.add(lockKey);
  }

  try {
    await queryCodexUnlocked(command, options, ws);
  } finally {
    if (lockKey) {
      activeCodexTurnLocks.delete(lockKey);
    }
  }
}

async function queryCodexUnlocked(command, options = {}, ws) {
  // B-31: verify the project directory exists before spawning Codex.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      if (ws) {
        ws.send(createNormalizedMessage(
          buildCwdMissingPayload(cwdCheck.error, { sessionId: options.sessionId || null, provider: 'codex' })
        ));
      }
      return;
    }
  }

  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    images,
    permissionMode = 'default'
  } = options;

  const resolvedModel = await providerModelsService.resolveResumeModel(
    'codex',
    sessionId,
    model,
  );

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);

  let codex;
  let thread;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let terminalFailure = null;
  let participantRecorded = false;
  let imagesTempDir = null;
  const abortController = new AbortController();

  // Record the authenticated human who spawned this run once a session id is
  // known. Idempotent; skipped for unauthenticated runs (no ws.userId).
  const recordParticipant = (sid) => {
    if (participantRecorded || !sid || !ws?.userId) {
      return;
    }
    participantRecorded = true;
    participantsDb.recordSpawn(sid, ws.userId, {
      provider: 'codex',
      projectPath: workingDirectory,
    });
  };

  try {
    // Per-user credential isolation (B-136 / B-ISO-CODEX): build the child env via
    // the central resolver so each authenticated user spawns Codex against their own
    // CODEX_HOME (~/.nassaj-users/<userId>/.codex) instead of inheriting the shared
    // operator ~/.codex — where auth.json is the owner's OpenAI subscription (ToS
    // violation) and sessions/ hold other users' transcripts (resumeThread leak).
    // codex-sdk does NOT inherit process.env once `env` is supplied, so hand it the
    // FULL resolved env (resolveProviderEnv spreads process.env). Anonymous/single-
    // user (null userId) returns the base env unchanged — no non-isolated regression.
    codex = new Codex({ env: resolveProviderEnv(ws?.userId ?? null, 'codex', process.env) });

    // Thread options with sandbox and approval settings
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel
    };

    // Start or resume thread
    if (sessionId) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    const registerSession = (id) => {
      if (!id) {
        return;
      }
      activeCodexSessions.set(id, {
        thread,
        codex,
        status: 'running',
        abortController,
        startedAt: new Date().toISOString()
      });
    };

    // Existing sessions can be tracked immediately; new sessions are tracked after thread.started.
    if (capturedSessionId) {
      registerSession(capturedSessionId);
      recordParticipant(capturedSessionId);
    }

    const preparedInput = await prepareCodexInput(command, images);
    imagesTempDir = preparedInput.tempDir;

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(preparedInput.input, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || event.id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession(capturedSessionId);
          recordParticipant(capturedSessionId);

          // T-874(2): codex has no per-session model memory of its own, so pin this
          // new session to its creation-time model in nassaj's per-session store —
          // a later model pick in ANOTHER conversation must not make this session
          // resume on the catalog default. Idempotent + best-effort.
          // .catch() guards against an unhandled rejection escaping this
          // fire-and-forget seed and crashing the spawn (B-136 regression).
          void providerModelsService
            .seedSessionModel('codex', capturedSessionId, resolvedModel)
            .catch(() => {});

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if (!sessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      // Check if session was aborted
      if (abortController.signal.aborted) {
        break;
      }
      if (capturedSessionId) {
        const session = activeCodexSessions.get(capturedSessionId);
        if (session?.status === 'aborted') {
          break;
        }
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      if ((event.type === 'turn.failed' || event.type === 'error') && !terminalFailure) {
        terminalFailure = event.error || event.message || new Error('Turn failed');
        const failure = classifyCodexFailure(
          terminalFailure,
          capturedSessionId || sessionId || null,
          command,
        );
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          ...failure,
        }));
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
        continue;
      }

      if (event.type === 'turn.completed') {
        const tokenBudget = extractCodexTokenBudget(event);
        if (tokenBudget) {
          sendMessage(ws, createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'codex',
          }));
        }
        // The single terminal `complete` is emitted after the stream closes.
        continue;
      }

      const transformed = transformCodexEvent(event);

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = sessionsService.normalizeMessage('codex', transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR): tag assistant
        // output with the JWT-sourced spawner so viewers attribute it correctly.
        stampCoordinatorId(msg, ws?.userId);
        sendMessage(ws, msg);
      }

    }

    // Send completion event
    if (!terminalFailure) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'complete',
        actualSessionId: capturedSessionId || thread.id || sessionId || null,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex'
      }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        stopReason: 'completed'
      });
    }

  } catch (error) {
    const session = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // B-32: map spawn/runtime errors to structured codes.
      const installed = await providerAuthService.isProviderInstalled('codex');
      // Classify once and reuse: both the mapped code/content below and the
      // conversation_not_found metadata attached to the error message derive
      // from the same classification result.
      const classified = classifyCodexFailure(error, capturedSessionId || sessionId || null, command);
      let errorCode;
      let errorContent;
      if (!installed) {
        errorCode = 'cli_not_installed';
        errorContent = 'Codex CLI is not configured. Please set up authentication first.';
      } else {
        const mapped = mapSpawnError(error);
        errorCode = classified.code === 'codex_turn_failed' ? mapped.code : classified.code;
        errorContent = classified.code === 'codex_turn_failed' ? mapped.fallbackMessage : classified.content;
      }

      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        code: errorCode,
        content: errorContent,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
        ...(errorCode === 'conversation_not_found'
          ? { staleSessionId: classified.staleSessionId, command: classified.command }
          : {}),
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    if (imagesTempDir) {
      await fs.rm(imagesTempDir, { recursive: true, force: true }).catch((error) => {
        console.warn('[Codex] Failed to clean temporary images:', error?.message || error);
      });
    }
    // Update session status
    if (capturedSessionId) {
      activeCodexSessions.delete(capturedSessionId);
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
