/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { recordBrokenModel } from './modules/providers/list/claude/claude-broken-models.store.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createNormalizedMessage, stampCoordinatorId, stampHumanUserId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { assertAnthropicBaseUrlAllowed, assertSettingsEnvAllowed } from './services/isolation/anthropic-base-url-guard.js';
import { buildCagedSdkSpawn } from './services/isolation/provider-cage-wiring.js';
import { applyClaudeEngineProviderEnv } from './services/isolation/apply-claude-engine-provider-env.js';
import { collectSettingsBaseUrls } from './services/isolation/collect-settings-base-urls.js';
import { buildVendorDelegateMcp } from './modules/providers/shared/vendor/vendor-delegate-mcp.js';
// T-822 (§ج-4): the per-conversation chat-turn lock. BOTH imports are
// side-effect-free (pure function/flag modules — no top-level I/O/timers). The
// lock is engaged ONLY when isChatTurnLockEnabled() (master + the dedicated
// WORKFLOW_SUPERVISOR_CHAT_LOCK sub-flag) is true AND this is a resume; otherwise
// the seam below is a synchronous no-op (byte-identical critical path).
import { isChatTurnLockEnabled } from './modules/workflow-supervisor/config.js';
import { acquireChatTurnLockForLiveTurn } from './modules/workflow-supervisor/chat-turn-lock.js';
import { buildGitAuthorEnv } from './utils/gitIdentity.js';
import {
  PROCESS_TAG_ENV_VAR,
  registerSessionProcess,
  unregisterSessionProcess
} from './services/session-process-monitor.js';
import { messageAuthorsDb, participantsDb } from './modules/database/index.js';
import { SessionRegistry } from './session-registry.js';
// ADR-042 (B-80c) ghost-detach: read-only listener-detection seam. Imported one
// way only (writer service NEVER imports claude-sdk — verified, no circularity).
import { countLiveMirrors } from './modules/websocket/services/websocket-writer.service.js';

// ADR-041 (B-80): per-session read-only replay registry for claude, isolated in
// its OWN SessionRegistry instance gated behind SESSION_REGISTRY_claude. When the
// flag is OFF every call here is a cheap no-op and the live stream path is
// byte-for-byte the pre-slice behaviour (coexistence contract). This is a SECOND
// instance of the same engine agy uses — session-registry.js itself is reused
// unchanged. Exported so the websocket layer (check-session-status / attach)
// reads the SAME instance: one source of truth for both the replay buffer and
// the active flag. It NEVER swaps the active writer and NEVER aborts the run —
// it only re-emits buffered payloads (seq > lastSeq) to a reconnecting socket,
// honouring the ADR-021 `if(!isActive)` no-swap veto.
const claudeSessionRegistry = new SessionRegistry('SESSION_REGISTRY_claude', { capacity: 500 });

// B-N-DROP (mirrors agy-cli.js): how long a session's replay buffer is retained
// AFTER the run reaches a terminal state (complete/error) before it is dropped —
// the post-close replay window. A socket that reconnects within this grace
// period can still receive the final payloads via differential attach. After it
// elapses the entry is dropped so the registry never grows unbounded across
// uptime. The timer is cancelled if the same key is reopened/reused first.
const CLAUDE_BUFFER_RETENTION_MS = 120000;

// Pending post-close drop timers keyed by sessionId, so a reopen/reuse of the key
// (resume) can cancel the scheduled drop and keep the buffer alive for the run.
const claudePendingDropTimers = new Map();

// Cancel any scheduled post-close drop for `key`. Called whenever the key is
// reopened or reused before its retention window elapses.
function cancelClaudePendingDrop(key) {
  if (!key) return;
  const timer = claudePendingDropTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    claudePendingDropTimers.delete(key);
  }
}

// B-N-DROP: schedule a deferred drop of `key` after CLAUDE_BUFFER_RETENTION_MS.
// Replaces any previously scheduled drop for the same key. `.unref()` so a
// pending drop never holds the event loop open at shutdown.
function scheduleClaudeBufferDrop(key) {
  if (!key) return;
  cancelClaudePendingDrop(key);
  const timer = setTimeout(() => {
    claudePendingDropTimers.delete(key);
    claudeSessionRegistry.drop(key);
  }, CLAUDE_BUFFER_RETENTION_MS);
  timer.unref?.();
  claudePendingDropTimers.set(key, timer);
}

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Per-connection active-session index (abort robustness, B-ABORT-FALLBACK).
// Maps a raw WebSocket → an insertion-ordered Set of the claude sessionIds that
// are currently active on THAT socket. Lets abortClaudeSDKSession fall back to
// the connection's own newest active run when the client-supplied sessionId is
// missing or stale (the brand-new-session race: the user hits STOP before the
// SDK has reported its real session_id, so the front end has no concrete id to
// send yet). A WeakMap so a closed socket's entry is GC'd with the socket; we
// still prune explicitly in removeSession to keep getNewestSessionForSocket
// accurate while the socket lives.
const sessionsByConnection = new WeakMap(); // rawWs → Set<sessionId> (ordered)

/** Returns the raw underlying socket for a session's writer, or null. */
function rawSocketForSession(session) {
  const ws = session?.writer?.ws ?? session?.writer ?? null;
  return ws && typeof ws === 'object' ? ws : null;
}

/**
 * Resolves the newest still-active claude sessionId bound to a given raw socket.
 * Used as the abort fallback when the supplied id does not resolve. Returns null
 * when the socket has no live session.
 */
function getNewestSessionForSocket(rawWs) {
  if (!rawWs) return null;
  const ids = sessionsByConnection.get(rawWs);
  if (!ids || ids.size === 0) return null;
  let newest = null;
  // Insertion order is preserved by Set; the last live id is the newest run.
  for (const id of ids) {
    if (activeSessions.has(id)) newest = id;
  }
  return newest;
}
// Guards the race window between removeSession() and the next addSession() for
// the same sessionId — a writer swap during this gap would mismatch the new ws.
const recentlyEndedSessions = new Map(); // sessionId → expiry timestamp
const RECENTLY_ENDED_GRACE_MS = 2000;

// ─── ADR-042 (B-80c): ghost-session DETACH (not abort) ──────────────────────
// A claude run keeps its for-await loop consuming the SDK child's stdout even
// after every listener (primary socket + read-only mirrors) is gone — the loop
// is a stdout CONSUMER, not the CLI turn driver. The child owns the session and
// writes its <sessionId>.jsonl incrementally regardless of the socket, so the
// work is on disk independent of the stream. The remaining problem is purely
// the DRAIN COUNT: such a "ghost" stays counted active in `activeSessions`, so
// every `pm2 restart` enters the unbounded graceful drain and hangs until PM2's
// kill_timeout (5min). Fix = DETACH: after a grace period with no listener, flag
// the session `detached` so the drain stops counting it — WITHOUT aborting. We
// never call child.kill()/interrupt/close and never stop the generator; the
// child finishes the turn and writes complete jsonl (zero work lost, matching
// the B-N-DRAIN philosophy that children complete). detach only changes whether
// the session BLOCKS the drain; it never touches the no-swap veto or the stream
// (the writer still fans out to any returning mirror normally).
const GHOST_DETACH_SWEEP_MS = parseInt(process.env.CLAUDE_GHOST_DETACH_SWEEP_MS, 10) || 30000;
const GHOST_DETACH_GRACE_MS = parseInt(process.env.CLAUDE_GHOST_DETACH_GRACE_MS, 10) || 180000;
let ghostSweepTimer = null;

// Separate flag from SESSION_REGISTRY_claude (which gates B-80a replay/buffer —
// an orthogonal concern). OFF by default: the sweep never starts, no session is
// ever flagged detached, and index.js keeps using getActiveClaudeSDKSessions()
// for the drain count byte-for-byte. Coexistence: zero behaviour change until
// explicitly enabled.
function ghostDetachEnabled() {
  const raw = process.env.CLAUDE_GHOST_DETACH;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// One pass over activeSessions: any session whose primary socket is dead AND has
// zero live mirrors for longer than the grace period gets flagged `detached`.
// A session that still has any listener resets its grace counter. NO abort: the
// generator is left to complete and clean itself up via the normal removeSession
// path when the turn ends. Exported for unit tests (ADR-042 test plan).
function sweepGhostSessions(now = Date.now()) {
  if (activeSessions.size === 0) {
    stopGhostSweep();
    return;
  }
  for (const [sid, session] of activeSessions) {
    if (session.detached) continue; // already excluded from the drain count
    const writerAlive = session.writer?.isPrimarySocketAlive?.() === true;
    const liveMirrors = countLiveMirrors(sid);
    if (writerAlive || liveMirrors > 0) {
      // Still has a listener — reset the no-listener clock.
      session.lastListenerSeenAt = now;
      session.noListenerSince = null;
      continue;
    }
    // No listener. Start/continue the grace countdown.
    if (!session.noListenerSince) session.noListenerSince = now;
    if (now - session.noListenerSince >= GHOST_DETACH_GRACE_MS) {
      session.detached = true; // ← excluded from getDrainBlockingClaudeSessions()
      console.log(
        `[GHOST-DETACH] session=${sid} detached after no-listener grace; `
          + 'generator left to complete and write jsonl (no abort)'
      );
    }
  }
}

// Lazy periodic sweep, mirroring session-process-monitor.js: started on first
// addSession (only when the flag is ON), stopped when activeSessions empties.
// .unref() so it never keeps the event loop alive at shutdown/drain.
function startGhostSweep() {
  if (ghostSweepTimer || !ghostDetachEnabled()) return;
  ghostSweepTimer = setInterval(() => sweepGhostSessions(), GHOST_DETACH_SWEEP_MS);
  ghostSweepTimer.unref?.();
}

function stopGhostSweep() {
  if (!ghostSweepTimer) return;
  clearInterval(ghostSweepTimer);
  ghostSweepTimer = null;
}
// ────────────────────────────────────────────────────────────────────────────

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// [B117-SIGNATURE] Monitoring only (T-250, docs/plans/B117-DIAGNOSIS.md §1.1 + §5).
// The literal "Tool permission request failed: Stream closed" is emitted INSIDE
// the bundled CLI binary (CLI→SDK direction) when it cannot send the can_use_tool
// control_request over a closed stdin — it is returned to the model as a deny and
// therefore surfaces in the message STREAM (result text / tool_result content),
// NOT through the nassaj canUseTool callback. So the callback-level [B117-DENY]
// probe alone cannot catch this string; this scanner over the read loop is the
// only nassaj-side point that can. Pure read: it inspects likely carriers and
// returns the matched text (or null); it never mutates the message or the stream.
const B117_FAILURE_SIGNATURE = 'Tool permission request failed';
function scanB117Signature(message) {
  try {
    if (typeof message?.result === 'string' && message.result.includes(B117_FAILURE_SIGNATURE)) {
      return message.result;
    }
    const content = message?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        // tool_result blocks: `content` is a string or an array of {type,text}
        const inner = block.content;
        if (typeof inner === 'string' && inner.includes(B117_FAILURE_SIGNATURE)) return inner;
        if (Array.isArray(inner)) {
          for (const part of inner) {
            const t = part && typeof part.text === 'string' ? part.text : '';
            if (t.includes(B117_FAILURE_SIGNATURE)) return t;
          }
        }
        // assistant text narrating the failure
        if (typeof block.text === 'string' && block.text.includes(B117_FAILURE_SIGNATURE)) {
          return block.text;
        }
      }
    }
  } catch { /* monitoring must never break the read loop */ }
  return null;
}

/**
 * Detects the Claude Code "stale resume" failure: a `--resume <id>` (SDK
 * `resume` option) request whose conversation no longer exists on disk. The
 * CLI/SDK surfaces this as a thrown error or an error result whose text reads
 * e.g. "No conversation found with session ID: <uuid>". We match defensively on
 * the stable substring so we can transparently restart as a fresh session
 * instead of dead-ending the user's message. Narrowly scoped on purpose: any
 * other resume failure keeps the original error behaviour.
 */
function isResumeSessionMissingError(value) {
  if (!value) {
    return false;
  }
  const text = typeof value === 'string' ? value : (value.message || String(value));
  return /no conversation found with session id/i.test(text);
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Builds the set of model values the send path will accept.
 *
 * Union of the LIVE/cached dynamic Claude catalog (same source the picker reads)
 * and the static {@link CLAUDE_FALLBACK_MODELS} OPTIONS as a safety net. The
 * static list alone does NOT contain dynamically-discovered models (e.g.
 * `claude-opus-4-9`), so validating against it rejected real picker selections
 * and coerced them to default. Including the dynamic catalog fixes that while
 * keeping the static list as a floor for when the catalog is unavailable.
 *
 * Pure/synchronous: it accepts an already-resolved catalog definition (the
 * caller pulls it from the cached, non-blocking SWR layer) so the hot send path
 * never awaits a live probe here.
 *
 * @param {ProviderModelsDefinition|null|undefined} catalog - Dynamic catalog
 *   (e.g. from providerModelsService.getProviderModels('claude')). May be null
 *   when the catalog is unavailable; only the static list is used then.
 * @returns {Set<string>} Valid model values.
 */
function buildValidClaudeModelValues(catalog) {
  const values = new Set();
  // Static safety net first — always valid even if the catalog is empty/broken.
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    if (option && typeof option.value === 'string') {
      values.add(option.value);
    }
  }
  // Dynamic catalog (the live/stored source the picker uses), if available.
  const dynamicOptions = Array.isArray(catalog?.OPTIONS) ? catalog.OPTIONS : [];
  for (const option of dynamicOptions) {
    if (option && typeof option.value === 'string') {
      values.add(option.value);
    }
  }
  return values;
}

/**
 * Lazy model-discovery backstop (B-MODEL-DISCOVERY): detects, from a streamed SDK
 * message, that the model this run launched with is not actually usable for the
 * account — i.e. it was advertised by the authenticated catalog but Anthropic has
 * not enabled it. The SDK surfaces this two ways:
 *   - an `assistant` message whose `error` is 'model_not_found'
 *     (SDKAssistantMessageError union), or
 *   - a `result` message carrying `api_error_status === 404`
 *     (HTTP 404 from the models endpoint; present on SDKResultSuccess).
 * Pure read — it inspects the message only and returns a boolean. It never
 * mutates the message, the stream, the registry, or any session state, so it is
 * safe to call inside the B-80 send loop alongside the existing result/token
 * inspection. When true, the caller records the offending model in the per-user
 * broken-models store so the catalog hides it next time.
 *
 * @param {Object} message - One streamed SDK message.
 * @returns {boolean} True when the message signals the run's model is unreleased.
 */
function isUnreleasedModelFailure(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  if (message.type === 'assistant' && message.error === 'model_not_found') {
    return true;
  }
  if (message.type === 'result' && message.api_error_status === 404) {
    return true;
  }
  return false;
}

/**
 * Effort levels natively accepted by the Agent SDK `Options.effort` field
 * (EffortLevel in @anthropic-ai/claude-agent-sdk sdk.d.ts). The SDK forwards
 * the value verbatim to the CLI as `--effort <level>`.
 */
const SDK_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * UI-contract values that are NOT SDK effort levels but are part of the
 * terminal `/effort` vocabulary:
 *  - 'auto'      → "use the model's default effort" → omit the SDK option.
 *  - 'ultracode' → the UI's maximum-intensity mode (intensity 4). It is NOT a
 *    value the SDK `Options.effort` type accepts, and the underlying CLI does
 *    not recognize 'ultracode' as an effort level either (its effort vocabulary
 *    is low|medium|high|xhigh|max). 'ultracode' is two things at once:
 *      1. Maximum reasoning effort — mapped here to the SDK level 'max' (the
 *         true ceiling, intensity 4; previously this was downgraded to 'xhigh',
 *         which made ultracode indistinguishable from the xhigh mode).
 *      2. The CLI's prompt-keyword super-modes ("deeper reasoning" + "multi-agent
 *         workflow orchestration"), which the SDK `effort` field cannot express.
 *         The CLI activates these from magic keywords in the prompt text (it
 *         scans for /\bultrathink\b/i and /\bultrawork\b/i). That half is applied
 *         in runClaudeSDKQuery via maybeApplyUltracodeKeywords(), keyed off
 *         resolveEffortLevel(...).alias === 'ultracode'.
 */
const EFFORT_ALIASES = new Map([
  ['auto', null],
  ['ultracode', 'max'],
]);

/**
 * Magic keywords the Claude Code CLI scans for in the prompt text to activate
 * its highest-tier session behaviors — the half of "ultracode" that the SDK
 * `Options.effort` field cannot carry:
 *   - 'ultrathink' → "Deeper reasoning requested for this turn" (max extended thinking).
 *   - 'ultrawork'  → "Multi-agent workflow requested for this turn" (the CLI is
 *     instructed to use the Workflow tool / dynamic-workflow orchestration).
 * Verified against the bundled CLI binary's keyword detectors (`/\bultrathink\b/i`,
 * `/\bultrawork\b/i`). Both are appended on their own line, separated from the
 * user's prompt, so the words are detected without colliding with prompt text.
 */
const ULTRACODE_PROMPT_KEYWORDS = 'ultrathink ultrawork';

/**
 * Appends the ultracode CLI keywords to the prompt when the UI requested the
 * 'ultracode' effort mode. Mirrors how the terminal `/effort ultracode` flow
 * surfaces those keywords to the CLI. No-op (returns the command unchanged) for
 * every other effort value, so normal prompts are never mutated.
 *
 * @param {string} command - The (possibly image-annotated) prompt text.
 * @param {unknown} effortValue - Raw `effort` field from the chat options.
 * @returns {string} The prompt, with the ultracode keywords appended when applicable.
 */
function maybeApplyUltracodeKeywords(command, effortValue) {
  const { alias } = resolveEffortLevel(effortValue);
  if (alias !== 'ultracode') {
    return command;
  }
  const base = typeof command === 'string' ? command : '';
  // Separate the keywords onto their own line so word-boundary detection in the
  // CLI fires cleanly regardless of how the user's prompt ends.
  return base ? `${base}\n\n${ULTRACODE_PROMPT_KEYWORDS}` : ULTRACODE_PROMPT_KEYWORDS;
}

/**
 * Validates a UI-supplied effort value against the allowlist and resolves it
 * to an SDK-compatible level.
 *
 * @param {unknown} value - Raw `effort` field from the chat message options.
 * @returns {{ level: string|null, alias: string|null, rejected: string|null }}
 *   level    - SDK effort level to apply, or null to omit the option.
 *   alias    - The original alias when a mapping occurred (e.g. 'ultracode').
 *   rejected - The original value when it was not in the allowlist (safe-ignore).
 */
function resolveEffortLevel(value) {
  if (typeof value !== 'string') {
    return { level: null, alias: null, rejected: null };
  }
  const requested = value.trim().toLowerCase();
  if (requested === '') {
    return { level: null, alias: null, rejected: null };
  }
  if (SDK_EFFORT_LEVELS.has(requested)) {
    return { level: requested, alias: null, rejected: null };
  }
  if (EFFORT_ALIASES.has(requested)) {
    return { level: EFFORT_ALIASES.get(requested), alias: requested, rejected: null };
  }
  return { level: null, alias: null, rejected: requested };
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @param {Set<string>} [validModelValues] - Set of accepted model values. When
 *   provided (by queryClaudeSDK), it is the union of the dynamic Claude catalog
 *   and the static fallback list. When omitted, validation falls back to the
 *   static CLAUDE_FALLBACK_MODELS.OPTIONS only (preserves prior behavior and
 *   keeps the function usable standalone, e.g. in unit tests).
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}, validModelValues) {
  const { sessionId, cwd, toolsSettings, permissionMode } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  //
  // Vendor-resilience iron rule (fail-closed): before forwarding, refuse to spawn
  // if ANTHROPIC_BASE_URL points the Claude/Anthropic path at a non-approved host.
  // No-op when unset (default Anthropic). See anthropic-base-url-guard.js. The
  // final env is re-validated at the spawn site below after per-user isolation,
  // since that step also carries the host env through.
  assertAnthropicBaseUrlAllowed(process.env);
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // Map model with validation against the accepted-model set.
  // The set is the union of the LIVE/cached dynamic Claude catalog (same source
  // the picker reads, e.g. claude-opus-4-9) and the static CLAUDE_FALLBACK_MODELS
  // safety net. queryClaudeSDK passes it in from the cached SWR layer; when it is
  // omitted (e.g. standalone/unit callers) we fall back to the static list only.
  // Any value not in the set (the UI's "auto" sentinel, empty, whitespace, a
  // truly unknown string) is rejected by the SDK, so we coerce it to the provider
  // default here and emit a non-silent warning (no silent substitution).
  const acceptedModels = validModelValues instanceof Set && validModelValues.size > 0
    ? validModelValues
    : buildValidClaudeModelValues(null);
  const requested = typeof options.model === 'string' ? options.model.trim() : '';
  const isKnownModel = requested !== '' && acceptedModels.has(requested);
  if (isKnownModel) {
    sdkOptions.model = requested;
  } else {
    sdkOptions.model = CLAUDE_FALLBACK_MODELS.DEFAULT;
    if (requested) {
      const sessionTag = sessionId ? ` [session=${sessionId}]` : '';
      const userTag = options.userId ? ` [user=${options.userId}]` : '';
      console.warn(
        `model "${requested}" not in CLAUDE OPTIONS; falling back to "${CLAUDE_FALLBACK_MODELS.DEFAULT}"${sessionTag}${userTag}`
      );
    }
  }
  // Model logged at query start below

  // Map effort (B: structured effort field from the UI, same path as model).
  // Allowlist: low|medium|high|xhigh|max (SDK EffortLevel) plus the UI aliases
  // 'auto' (omit → model default) and 'ultracode' (mapped to 'max' — the SDK
  // ceiling, intensity 4). The "deeper reasoning + multi-agent workflow" half of
  // ultracode is applied separately in runClaudeSDKQuery via prompt keywords,
  // because the SDK Options.effort field cannot express it. Anything else is
  // ignored safely with a non-silent warning — never forwarded to the SDK.
  const { level: effortLevel, alias: effortAlias, rejected: rejectedEffort } =
    resolveEffortLevel(options.effort);
  if (effortLevel) {
    sdkOptions.effort = effortLevel;
    if (effortAlias) {
      console.warn(
        `effort "${effortAlias}" mapped to SDK level "${effortLevel}" (alias outside SDK EffortLevel)`
      );
    }
  } else if (rejectedEffort) {
    const sessionTag = sessionId ? ` [session=${sessionId}]` : '';
    console.warn(
      `effort "${rejectedEffort}" not in allowlist (low|medium|high|xhigh|max|ultracode|auto); ignoring${sessionTag}`
    );
  }

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Probes the Claude Agent SDK for its built-in slash commands.
 *
 * Uses a streaming-input (async generator) `query` that NEVER yields a turn:
 * `supportedCommands()` is a control request that the SDK answers from the
 * init handshake alone — no model call, no token cost, no user input. We then
 * `interrupt()` and let the never-resolving generator be GC'd so the SDK child
 * process tears down immediately.
 *
 * Guarantees:
 *  - No turn/prompt is ever sent (the generator awaits a release promise and
 *    only ends after cleanup — it yields nothing before then).
 *  - Hard timeout (default 4s): on overrun we interrupt and resolve `null`.
 *  - Every error path swallows and returns `null` (never throws upward).
 *  - The SDK process is always interrupted/released, even on error/timeout, so
 *    no child process leaks.
 *
 * @param {Object} [context] - Optional context. `userId` selects the per-user
 *   Claude config dir via resolveProviderEnv; `cwd` sets the working directory.
 * @returns {Promise<Array<{name:string,description?:string,aliases?:string[],argumentHint?:string}>|null>}
 *   Normalized command list, or `null` on any failure/timeout/old SDK.
 */
async function getClaudeBuiltInCommands(context = {}) {
  const { userId = null, cwd = null } = context;
  const PROBE_TIMEOUT_MS = 4000;

  // Controls the async generator's lifetime. The generator awaits this promise
  // and yields nothing, so no turn is ever produced. Resolving it ends the
  // generator (after we've already pulled supportedCommands()).
  let releaseGenerator;
  const releasePromise = new Promise((resolve) => {
    releaseGenerator = resolve;
  });

  // A streaming-input prompt: an async generator that emits zero turns.
  async function* emptyPromptStream() {
    await releasePromise;
    // Intentionally yields nothing — keeps the session in streaming-input mode
    // without sending any user message to the model.
  }

  let queryInstance = null;
  let timeoutHandle = null;

  // Resolve env the same way the live chat path does so the probe runs under
  // the correct Claude config dir / credentials (no elevated privileges).
  let probeEnv = { ...process.env };
  try {
    probeEnv = resolveProviderEnv(userId, 'claude', probeEnv);
  } catch {
    // Fall back to the base env; never let env resolution break the probe.
    probeEnv = { ...process.env };
  }

  const cleanup = async () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    // Release the generator so it completes and the SDK can shut down.
    if (releaseGenerator) {
      releaseGenerator();
      releaseGenerator = null;
    }
    if (queryInstance && typeof queryInstance.interrupt === 'function') {
      try {
        await queryInstance.interrupt();
      } catch {
        // Interrupt failures are non-fatal — the released generator + GC still
        // tears the process down.
      }
    }
  };

  try {
    const sdkOptions = {
      env: probeEnv,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      // No tools/prompt/model work happens; keep options minimal & deterministic.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };
    if (cwd) {
      sdkOptions.cwd = cwd;
    }

    // Iron-rule guard: this probe also spawns the Claude/Anthropic subprocess,
    // so fail-closed if ANTHROPIC_BASE_URL targets a non-approved host. No-op
    // when unset (default Anthropic). Also validate the per-user settings.json
    // env block the CLI applies from CLAUDE_CONFIG_DIR (same bypass surface).
    assertAnthropicBaseUrlAllowed(sdkOptions.env);
    assertSettingsEnvAllowed(sdkOptions.env.CLAUDE_CONFIG_DIR, sdkOptions.env);

    // T-897: cage this probe's Claude spawn too (flag OFF ⇒ undefined ⇒ unset).
    const cagedProbeSpawn = buildCagedSdkSpawn({ userId, cwd: cwd ?? null });
    if (cagedProbeSpawn) {
      sdkOptions.spawnClaudeCodeProcess = cagedProbeSpawn;
    }

    queryInstance = query({
      prompt: emptyPromptStream(),
      options: sdkOptions,
    });

    const commandsPromise = queryInstance.supportedCommands();

    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve('__probe_timeout__'), PROBE_TIMEOUT_MS);
    });

    const result = await Promise.race([commandsPromise, timeoutPromise]);

    if (result === '__probe_timeout__' || !Array.isArray(result)) {
      return null;
    }

    // Normalize to the shape the route merges. Drop entries without a name.
    return result
      .filter((cmd) => cmd && typeof cmd.name === 'string' && cmd.name.length > 0)
      .map((cmd) => ({
        name: cmd.name,
        description: typeof cmd.description === 'string' ? cmd.description : '',
        ...(Array.isArray(cmd.aliases) && cmd.aliases.length > 0 ? { aliases: cmd.aliases } : {}),
        ...(typeof cmd.argumentHint === 'string' && cmd.argumentHint
          ? { argumentHint: cmd.argumentHint }
          : {}),
      }));
  } catch {
    // Any failure (old SDK without supportedCommands, spawn error, etc.) → null.
    return null;
  } finally {
    await cleanup();
  }
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 * @param {Object|null} writer - WebSocketWriter for this session
 * @param {string|null} runTag - PROCESS_TAG_ENV_VAR value injected into the
 *   spawned CLI env; lets the process monitor resolve the child pid from
 *   /proc and surface frozen (kill -STOP) state to the UI.
 * @param {string|null} projectPath - Working dir of the run, forwarded to the
 *   process monitor so the live presence panel can show what the user is on.
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, runTag = null, projectPath = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer,
    // ADR-042 (B-80c) ghost-detach bookkeeping. `detached` excludes the session
    // from the drain count ONLY (never aborts). The clocks are managed by the
    // lazy sweep; harmless dead fields when CLAUDE_GHOST_DETACH is OFF.
    detached: false,
    noListenerSince: null,
    lastListenerSeenAt: Date.now()
  });
  // ADR-041: mark the session live in the replay registry (single source of
  // truth for the active flag + replay buffer). Cancel any pending post-close
  // drop first so a quick resume reuses the entry instead of losing it. No-op
  // when SESSION_REGISTRY_claude is off. addSession is called twice on a fresh
  // run (once eagerly with the resume id when present, once with the real
  // captured session_id); open() is idempotent so the double call is safe.
  if (sessionId) {
    cancelClaudePendingDrop(sessionId);
    claudeSessionRegistry.open(sessionId);
  }
  if (writer && runTag) {
    registerSessionProcess(sessionId, { provider: 'claude', writer, runTag, projectPath });
  }
  // B-ABORT-FALLBACK: index this session under its originating socket so an
  // abort can be resolved by connection even before/without a matching id.
  const rawWs = rawSocketForSession({ writer });
  if (sessionId && rawWs) {
    let ids = sessionsByConnection.get(rawWs);
    if (!ids) {
      ids = new Set();
      sessionsByConnection.set(rawWs, ids);
    }
    // Re-insert to keep newest-last ordering for getNewestSessionForSocket.
    ids.delete(sessionId);
    ids.add(sessionId);
  }
  // ADR-042 (B-80c): start the lazy ghost sweep (no-op unless the flag is ON or
  // the timer already runs). Stopped again in removeSession when the map empties.
  startGhostSweep();
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  // B-ABORT-FALLBACK: drop the per-connection index entry before deleting the
  // session, so getNewestSessionForSocket never returns a torn-down id.
  const ending = activeSessions.get(sessionId);
  const rawWs = rawSocketForSession(ending);
  if (rawWs) {
    const ids = sessionsByConnection.get(rawWs);
    if (ids) {
      ids.delete(sessionId);
      if (ids.size === 0) sessionsByConnection.delete(rawWs);
    }
  }
  activeSessions.delete(sessionId);
  // ADR-042 (B-80c): tear down the lazy ghost sweep once no session remains.
  if (activeSessions.size === 0) stopGhostSweep();
  // Stop process-state monitoring and tell every viewer the session is idle.
  // ADR-053 (T-53-B1): this ends the PRESENCE/idle lifecycle at turn-end (which
  // is correct — the user's turn is done), but it deliberately does NOT cancel
  // WORKFLOW PID tracking. That lives in the independent workflow-liveness
  // registry (server/services/workflow-liveness.js), which is populated from the
  // resolved child pid while the run was live and is NOT torn down here, so a
  // background workflow whose coordinator turn already ended (B-103) stays
  // probeable by /proc until the child process actually exits. Keeping the pid
  // survival OUT of this call is the minimal critical-path touch: no line is
  // added to the query()/for-await hot path that caused the 502 incidents.
  unregisterSessionProcess(sessionId);
  // Mark as recently ended to block writer swaps during the race window
  recentlyEndedSessions.set(sessionId, Date.now() + RECENTLY_ENDED_GRACE_MS);
  setTimeout(() => recentlyEndedSessions.delete(sessionId), RECENTLY_ENDED_GRACE_MS);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolves the real context window (in tokens) for a given model.
 *
 * Priority:
 *  1. `CONTEXT_WINDOW` env var when explicitly set (respects user override).
 *  2. Inferred from the model name: Opus, Fable, and Sonnet 4.6+ ship a 1M
 *     window; other known models default to 200000.
 *  3. When the model name is unavailable, defaults to 1000000 (the modern
 *     Opus/Sonnet long-context default) instead of the stale 160000 value.
 *
 * Returns the model's true window — the frontend applies its own effective
 * factor on top of this number.
 * @param {string} [modelName] - Model identifier (e.g. "claude-opus-4-8")
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(modelName) {
  const override = parseInt(process.env.CONTEXT_WINDOW, 10);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }

  const name = typeof modelName === 'string' ? modelName.toLowerCase() : '';

  // Opus (all current generations) ships a 1M context window.
  if (name.includes('opus')) {
    return 1000000;
  }

  // Fable (5 and later) ships a 1M context window with 128K max output.
  if (name.includes('fable')) {
    return 1000000;
  }

  // Sonnet 4.6 and later ship a 1M context window.
  if (name.includes('sonnet')) {
    const versionMatch = name.match(/sonnet[^0-9]*(\d+)(?:[.-](\d+))?/);
    if (versionMatch) {
      const major = Number(versionMatch[1]);
      const minor = Number(versionMatch[2] || 0);
      if (major > 4 || (major === 4 && minor >= 6)) {
        return 1000000;
      }
    }
    return 200000;
  }

  // Known model name but not long-context → conservative default.
  if (name) {
    return 200000;
  }

  // Model name unavailable → modern long-context default (was 160000).
  return 1000000;
}

/**
 * Sums the full input token count, including cached tokens.
 * Anthropic's `input_tokens` excludes both `cache_read_input_tokens` and
 * `cache_creation_input_tokens`; with prompt caching enabled (the default)
 * counting `input_tokens` alone wildly underreports real context usage.
 * @param {Object} usage - Usage object (snake_case or camelCase fields)
 * @returns {{ input: number, cacheRead: number, cacheCreation: number, full: number }}
 */
function readInputTokens(usage) {
  const input = readNumber(usage.input_tokens ?? usage.inputTokens);
  const cacheRead = readNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheCreation = readNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  return { input, cacheRead, cacheCreation, full: input + cacheRead + cacheCreation };
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 *
 * `inputTokens` reflects the FULL input (raw input + cache read + cache
 * creation) so the budget counter is accurate under prompt caching.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Model name (when present) lets us pick the correct context window.
  const modelName = sdkMessage.message?.model
    || sdkMessage.model
    || (sdkMessage.modelUsage && Object.keys(sdkMessage.modelUsage)[0]);

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const { full: fullInput, cacheRead, cacheCreation } = readInputTokens(messageUsage);
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = fullInput + outputTokens;
    const contextWindow = resolveContextWindow(modelName);

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens: fullInput,
      outputTokens,
      breakdown: {
        input: fullInput,
        output: outputTokens,
        cacheRead,
        cacheCreation,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const rawInput = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const cacheRead = readNumber(
    modelData.cumulativeCacheReadInputTokens
    ?? modelData.cacheReadInputTokens
    ?? modelData.cache_read_input_tokens
  );
  const cacheCreation = readNumber(
    modelData.cumulativeCacheCreationInputTokens
    ?? modelData.cacheCreationInputTokens
    ?? modelData.cache_creation_input_tokens
  );
  const fullInput = rawInput + cacheRead + cacheCreation;
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = fullInput + outputTokens;
  const contextWindow = resolveContextWindow(modelKey);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens: fullInput,
    outputTokens,
    breakdown: {
      input: fullInput,
      output: outputTokens,
      cacheRead,
      cacheCreation,
    },
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // B-40f: use os.tmpdir() instead of a hard-coded project path so temp
    // images never land inside the project tree (avoids accidental git tracking
    // and works regardless of the project cwd).
    tempDir = path.join(os.tmpdir(), 'nassaj-claude-images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    // Images processed
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Appends agent attachment paths to the prompt so the model can read them. The
 * files already live on disk (the upload endpoint copied them into the project's
 * .nassaj-uploads/inbox); here we only annotate the prompt with their paths.
 *
 * Mirrors handleImages: the note is appended AFTER the command text, and an
 * empty/absent file list is a total no-op (returns the command unchanged) so the
 * authorship hash of fileless messages is identical to before this feature.
 *
 * @param {string} command - Prompt text (already image-annotated)
 * @param {Array<{path: string, name?: string}>} files - paths are cwd-relative
 * @returns {{ modifiedCommand: string }}
 */
function handleFiles(command, files) {
  if (!files || files.length === 0) {
    return { modifiedCommand: command };
  }

  const fileNote = `\n\n[Files provided at the following paths:]\n${files.map((f, i) => `${i + 1}. ${f.path}`).join('\n')}`;
  return { modifiedCommand: command + fileNote };
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) {
    return;
  }

  try {
    // Delete individual temp files
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(err =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }

    // Delete temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }

    // Temp files cleaned
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function runClaudeSDKQuery(command, options = {}, ws, internalOptions = {}) {
  const { suppressResumeMissError = false } = internalOptions;
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let participantRecorded = false;
  // Exact prompt text handed to the SDK (and therefore written verbatim into
  // the transcript). Updated to the image-annotated form after handleImages so
  // the authorship hash recorded below matches the transcript line.
  let promptTextForAuthorship = command;

  // B-31: verify the project directory exists before attempting spawn.
  // A missing cwd causes a confusing ENOENT after SDK init; surface it early
  // with a classified error the frontend can translate via the error code.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      // B-31/B-33: surface the cwd-missing error once, with the isNewSessionError
      // flag set when there is no sessionId yet so the frontend can correlate the
      // failure with the originating request. A second identical message is NOT
      // sent — one classified error is sufficient.
      ws.send(createNormalizedMessage(
        buildCwdMissingPayload(cwdCheck.error, {
          sessionId: sessionId || null,
          provider: 'claude',
          isNewSessionError: !sessionId,
        })
      ));
      return { ok: false };
    }
  }

  // Record the authenticated human who spawned this run as a session
  // participant. Once per spawn (idempotent at the DB layer too) and only when
  // the WS is authenticated — anonymous/single-user runs carry no userId.
  const recordParticipant = (sid) => {
    if (participantRecorded || !sid || !ws?.userId) {
      return;
    }
    participantRecorded = true;
    participantsDb.recordSpawn(sid, ws.userId, {
      provider: 'claude',
      projectPath: options.cwd || options.projectPath || process.cwd(),
    });
    // Sender attribution (B-MU-UX-FIX-MSG-AUTHOR): remember WHO authored this
    // prompt so history loads can stamp userId onto the transcript's user
    // message (the transcript itself carries no identity). Never throws.
    messageAuthorsDb.recordUserMessage(sid, ws.userId, promptTextForAuthorship);
  };

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // T-822 (§ج-4): held across query()+for-await, released in the finally on EVERY
  // exit path. Declared here (not in the try) so the finally can see it. Stays
  // null unless the seam below engages the lock.
  let chatTurnLock = null;

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );

    // Build the accepted-model set from the dynamic Claude catalog so any model
    // the picker offers (e.g. claude-fable-5) passes validation. This reads the
    // existing cached SWR layer (fast, in-memory; refresh runs in the background),
    // so it never blocks or slows the send hot path. On any failure we leave the
    // set undefined, and mapCliOptionsToSDK falls back to the static list — the
    // send path is never broken by catalog issues.
    let validModelValues;
    try {
      const { models: catalog } = await providerModelsService.getProviderModels('claude');
      validModelValues = buildValidClaudeModelValues(catalog);
    } catch {
      validModelValues = undefined;
    }

    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
    }, validModelValues);

    // Lazy model-discovery: the exact model value the SDK will run with (after
    // validation/coercion in mapCliOptionsToSDK). If this run later fails with a
    // model_not_found / 404 the model is recorded as broken for this user. Skip
    // the provider default sentinel — 'default' is never an unreleased model and
    // must never be hidden.
    const runModelForDiscovery =
      typeof sdkOptions.model === 'string' && sdkOptions.model !== CLAUDE_FALLBACK_MODELS.DEFAULT
        ? sdkOptions.model
        : null;
    let unreleasedModelRecorded = false;

    // Per-user credential isolation (B-ISO-CLAUDE): rebuild the spawn env via the
    // central resolver so each authenticated user gets their own CLAUDE_CONFIG_DIR
    // while conversations/instructions stay shared via symlinks. Falls back to the
    // base env unchanged when no userId is present (single-user / platform mode).
    sdkOptions.env = resolveProviderEnv(ws?.userId ?? null, 'claude', sdkOptions.env);

    // Iron-rule re-check on the FINAL env actually handed to the subprocess.
    // resolveProviderEnv spreads the base env (ANTHROPIC_BASE_URL included) and
    // never strips it, so validate again here — fail-closed before query().
    assertAnthropicBaseUrlAllowed(sdkOptions.env);
    // The CLI also applies env.ANTHROPIC_BASE_URL (and Bedrock/Vertex siblings)
    // from settings.json INSIDE the per-user CLAUDE_CONFIG_DIR, downstream of the
    // spawn env. Validate that file under the same allowlist so a competitor base
    // URL placed there cannot bypass the OS-env guard above.
    assertSettingsEnvAllowed(sdkOptions.env.CLAUDE_CONFIG_DIR, sdkOptions.env);

    // T-897: unified provider cage (behind NASSAJ_PROVIDER_CAGE, default OFF).
    // When on, route the SDK's Claude Code spawn through bwrap so it cannot read
    // other users' ~/.nassaj-users trees or reach host runtime sockets. Returns
    // undefined when the flag is off ⇒ the option is never set and the SDK keeps
    // its stock local spawn (byte-identical off path).
    const cagedClaudeSpawn = buildCagedSdkSpawn({
      userId: ws?.userId ?? null,
      cwd: sdkOptions.cwd ?? null,
    });
    if (cagedClaudeSpawn) {
      sdkOptions.spawnClaudeCodeProcess = cagedClaudeSpawn;
    }

    // Per-user commit authorship (B-MU-UX-GIT-ID): inject GIT_AUTHOR_*/
    // GIT_COMMITTER_* for the authenticated user so any commit the agent makes
    // during this run is attributed to the brother who spawned it — independent
    // of the credential-isolation policy above (attribution, not isolation).
    // Empty when the user has no stored identity -> the agent's commits fall
    // back to the system git config (current behavior). No global config write.
    Object.assign(sdkOptions.env, buildGitAuthorEnv(ws?.userId ?? null));

    // Frozen-session indicator: the SDK never exposes the spawned CLI's pid,
    // so tag the child env with a unique value the process monitor can match
    // against /proc/<pid>/environ to find the pid and watch for kill -STOP.
    const processRunTag = crypto.randomUUID();
    sdkOptions.env[PROCESS_TAG_ENV_VAR] = processRunTag;

    // B-86: when the control flag is enabled, pass CLAUDE_CODE_WORKFLOWS=1 to the
    // CLI to activate the Workflow/multi-agent orchestration (ultrawork) tier of
    // ultracode. Applied here, AFTER resolveProviderEnv rebuilds sdkOptions.env,
    // so it survives onto the final env handed to query(). Disabled by default
    // (flag '0'/'false'/unset) — no behaviour change for any existing run. This
    // only adds one env var to the spawn; it never touches the SDK tool
    // definitions, allowedTools/disallowedTools, or the prompt-keyword path.
    Object.assign(sdkOptions.env, (process.env.ENABLE_ULTRACODE_WORKFLOWS === 'true' || process.env.ENABLE_ULTRACODE_WORKFLOWS === '1'
      ? { CLAUDE_CODE_WORKFLOWS: '1' }
      : {}));

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // SEAM-ONLY WIRING (tracked on the board): both options.allowVendorDelegation
    // (below) and options.engineProvider (B-ENG, further down) are read here and the
    // transport already forwards them — chat-websocket.service forwards data.options
    // verbatim to queryClaudeSDK with no allow-list/strip — so they are wired end to
    // end on the server. They are intentionally NOT surfaced by the default chat UI
    // yet: no route/WS handler sets them, so in normal operation engineProvider is
    // undefined (injectedHosts stays null, the base-URL guard is a no-op, the Claude
    // model is untouched) and allowVendorDelegation is falsy (no vendor-delegate MCP
    // is registered). Do not treat these as user-reachable features until the UI
    // surface lands; this is the seam, the activation is later work on the board.
    //
    // B-DEL-6: when the agent is permitted to delegate subtasks to hosted vendor
    // models, register the per-spawn vendor-delegate MCP server. Built fresh here
    // with the spawning user's id captured in its closure — no global instance —
    // so each user's delegation uses only their own stored vendor key.
    if (options.allowVendorDelegation) {
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers || {}),
        'vendor-delegate': buildVendorDelegateMcp(ws?.userId ?? null),
      };
    }

    // B-ENG-4: "Claude engine on a vendor endpoint" (ADR-037).
    // 1) Optionally point the SDK's ANTHROPIC_BASE_URL/AUTH_TOKEN at the selected
    //    per-user engine provider (returns the authorized host set, or null when
    //    no engine provider is engaged / no key is stored — never half-injects).
    // 2) Collect any *_BASE_URL declared in the resolved settings.json (the same
    //    channel Claude Code reads at spawn) so the guard vets them too.
    // 3) Fail-closed guard: throw unless every base URL the SDK will see points at
    //    the official Anthropic host, this spawn's engine host, or an operator
    //    escape hatch (Bedrock/Vertex flags or NASSAJ_ALLOWED_ANTHROPIC_HOSTS).
    // This runs before BOTH query() calls below (the no-hooks retry reuses the
    // same sdkOptions.env), so it covers every spawn path.
    const injectedHosts = applyClaudeEngineProviderEnv(
      sdkOptions.env,
      ws?.userId ?? null,
      options.engineProvider,
    ) ?? null;
    const settingsBaseUrls = await collectSettingsBaseUrls(sdkOptions.env);
    assertAnthropicBaseUrlAllowed(sdkOptions.env, {
      engineProviderHosts: injectedHosts ?? undefined,
      extraValues: settingsBaseUrls,
    });

    // When (and only when) an engine provider was actually engaged, re-assert the
    // caller's model id verbatim. mapCliOptionsToSDK already passes options.model
    // through without coercion (claude-sdk.js: `options.model || DEFAULT`), so for
    // the current code path this is a behavioural no-op — it does NOT undo any
    // existing coercion because none exists here. It is kept as an explicit,
    // narrowly-gated guard (injectedHosts !== null) documenting that a vendor model
    // id must survive untouched, so that if a Claude-model normalizer is ever added
    // to the mapping step it cannot silently rewrite an engaged vendor model. With
    // no engine engaged we leave sdkOptions.model exactly as mapped.
    if (injectedHosts !== null && options.model) {
      sdkOptions.model = options.model;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    // Handle attachment files - append their paths after the image annotation.
    // No-op (returns the same string) when options.files is empty, so the
    // authorship hash for fileless messages is unchanged.
    const fileResult = handleFiles(imageResult.modifiedCommand, options.files);
    // Ultracode (UI intensity 4): besides the SDK effort='max' set above, the
    // CLI's "deeper reasoning + multi-agent workflow" super-modes are activated
    // by magic keywords in the prompt text. Append them here so ultracode takes
    // real effect (no-op for every other effort value). Applied after the image
    // annotation so the keywords ride along on the exact text the CLI receives.
    const finalCommand = maybeApplyUltracodeKeywords(fileResult.modifiedCommand, options.effort);
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;
    // The transcript stores the prompt exactly as handed to the SDK, so
    // authorship must hash the same text (recordParticipant runs only after
    // this point).
    promptTextForAuthorship = finalCommand;

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      // [B117-DENY] Monitoring only — zero behaviour change (T-250,
      // docs/plans/B117-DIAGNOSIS.md §5.2). Every deny this callback returns for
      // the interactive tools is logged with the session/request id and the raw
      // socket state so a live B-117 occurrence can be correlated to an
      // endInput/abort sequence. The returned object is byte-identical to the
      // former inline literal; logging never mutates the permission decision and
      // is wrapped so it can never throw into the permission path.
      const denyWithLog = (denyMessage, reason, requestId = null) => {
        try {
          const rawState = ws && ws.ws ? ws.ws.readyState : 'no-ws';
          console.log(
            `[B117-DENY] tool=${toolName} requiresInteraction=${requiresInteraction} `
            + `reason=${reason} session=${capturedSessionId || sessionId || 'NEW'} `
            + `requestId=${requestId || 'none'} `
            + `permissionMode=${sdkOptions.permissionMode || 'default'} `
            + `rawSocketReadyState=${rawState} message=${JSON.stringify(denyMessage)}`
          );
        } catch { /* logging must never break the permission path */ }
        return { behavior: 'deny', message: denyMessage };
      };

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return denyWithLog('Tool disallowed by settings', 'disallowed-by-settings');
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return denyWithLog('Permission request timed out', 'timeout', requestId);
      }

      if (decision.cancelled) {
        // decision.cancelled originates from a runtime/transport abort (e.g. a
        // transient SDK/transport disconnect), NOT from the user denying the
        // request. We keep the { behavior: 'deny', message } contract but return
        // an honest, retryable message instead of implying the user cancelled.
        return denyWithLog('Tool use was cancelled by the runtime (not by the user). This is likely a transient SDK/transport abort — the request can be retried.', 'runtime-cancelled', requestId);
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return denyWithLog(decision.message ?? 'User denied tool use', 'user-denied', requestId);
    };

    // T-822 (§ج-4) — the ONLY critical-path touch, GATED at the line start. When
    // the sub-flag is off (default) OR this is a NEW session (no resume target,
    // so nothing an injector can collide with), the whole expression short-
    // circuits to null WITHOUT evaluating the await — no fs, no spawn, no async
    // suspension, no env-var-timing shift ⇒ byte-identical path. When on AND
    // resuming, take the per-conversation lock so this live turn's `<sid>.jsonl`
    // appends never interleave with a Tier-B injection. Bounded wait; fail-OPEN
    // for the human on timeout (§ح-3); released in the finally below.
    chatTurnLock = (isChatTurnLockEnabled() && sessionId)
      ? await acquireChatTurnLockForLiveTurn(sessionId, ws?.userId ?? null)
      : null;

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    try {
      queryInstance = query({
        prompt: finalCommand,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: finalCommand,
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, processRunTag, options.cwd || options.projectPath || null);
      recordParticipant(capturedSessionId);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    // [WS-DIAG] Active-stream lifecycle (point #2). Records the writer's bound raw
    // socket readyState at stream start, and arms a one-time orphan probe: if the
    // socket closes mid-stream, ws.send() below becomes a silent no-op (readyState
    // guard in WebSocketWriter.send) while THIS generator keeps consuming SDK output.
    // The SDK query is NOT aborted on socket close. We log the first iteration where
    // the socket is no longer OPEN so the freeze is provable: stream alive, socket
    // dead, payloads dropped, and (point #4) no re-subscribe re-binds the writer
    // because the run is still 'active' so reconnectSessionWriter is vetoed.
    // readyState codes: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED.
    const wsDiagRawAtStart = ws && ws.ws ? ws.ws.readyState : 'no-raw-ws';
    console.log(
      `[WS-DIAG] stream-start session=${capturedSessionId || 'NEW'} `
      + `rawSocketReadyState=${wsDiagRawAtStart} isWebSocketWriter=${Boolean(ws && ws.isWebSocketWriter)}`
    );

    // ADR-041 (B-80): RingBuffer injection point. Buffer each LIVE payload under
    // the current session key, stamp it with the assigned monotonic `sequence`,
    // THEN forward it to the socket. A socket that reconnects mid-stream is then
    // brought up to date by differential replay (attach re-emits seq > lastSeq)
    // — read-only, no writer swap, no abort. record() returns null when the flag
    // is OFF (then we forward the payload untouched, no `sequence` field, exactly
    // as before). Buffering is keyed off `capturedSessionId` resolved at call
    // time (it may be null for the very first payloads of a brand-new run, before
    // the SDK reports session_id; those are not buffered — identical to agy,
    // where the pre-id window is covered by a connectionId we do not have here).
    // Only the live-stream payloads inside the for-await loop route through this;
    // the terminal `error` payload keeps a direct ws.send so a failure is never
    // gated on the registry.
    const sendAndBuffer = (payload) => {
      const sid = capturedSessionId || sessionId || null;
      const seq = sid ? claudeSessionRegistry.record(sid, payload) : null;
      if (seq !== null && seq !== undefined) {
        payload.sequence = seq;
      }
      ws.send(payload);
    };

    let wsDiagOrphanLogged = false;
    let wsDiagMessageCount = 0;
    // Count Workflow tool_use calls so the complete event can signal
    // that background work is still in flight after the assistant turn ends.
    let pendingWorkflows = 0;
    for await (const message of queryInstance) {
      // [WS-DIAG] One-time orphan detection: socket went away but the stream lives on.
      wsDiagMessageCount += 1;
      // OPEN readyState is the literal 1 (WebSocket.OPEN); avoid importing the
      // websocket-state constant here to keep the diagnostic footprint local.
      if (
        !wsDiagOrphanLogged
        && ws && ws.ws
        && ws.ws.readyState !== 1
      ) {
        wsDiagOrphanLogged = true;
        console.log(
          `[WS-DIAG] stream-orphaned session=${capturedSessionId || sessionId || 'NEW'} `
          + `rawSocketReadyState=${ws.ws.readyState} messagesSoFar=${wsDiagMessageCount} `
          + `note=socket-closed-but-generator-still-running-sends-now-dropped`
        );
      }

      // [B117-SIGNATURE] Live capture of the CLI-internal B-117 deny surfacing in
      // the stream (see scanB117Signature). Logs the matched text + raw socket
      // state so the emission can be tied to a session/message; monitoring only.
      const b117Match = scanB117Signature(message);
      if (b117Match) {
        const rawState = ws && ws.ws ? ws.ws.readyState : 'no-ws';
        console.log(
          `[B117-SIGNATURE] session=${capturedSessionId || sessionId || 'NEW'} `
          + `messageType=${message.type} messagesSoFar=${wsDiagMessageCount} `
          + `rawSocketReadyState=${rawState} matched=${JSON.stringify(b117Match.slice(0, 300))}`
        );
      }

      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        // ADR-041 / B-N-RESUME clean buffer (mirrors agy-cli.js): the SDK reports
        // its real session_id only now. A resumed run for a sessionId that carries
        // a prior, already-terminated registry entry must NOT inherit the previous
        // run's buffered payloads. Drop the stale INACTIVE entry (and cancel its
        // pending post-close drop) BEFORE addSession re-opens a fresh one, so the
        // new run's seq line starts at 0 and a client reconnecting with lastSeq
        // absent/0 replays only THIS run. A still-active entry under the same id is
        // a live run we must never disturb, so it is left untouched. No-op when the
        // flag is off.
        if (
          claudeSessionRegistry.enabled
          && claudeSessionRegistry.entries.has(capturedSessionId)
          && !claudeSessionRegistry.isActive(capturedSessionId)
        ) {
          claudeSessionRegistry.drop(capturedSessionId);
        }
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, processRunTag, options.cwd || options.projectPath || null);
        recordParticipant(capturedSessionId);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          sendAndBuffer(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Detect Workflow tool invocations so the complete event can signal
      // that background work continues after the assistant turn ends.
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block && block.type === 'tool_use' && block.name === 'Workflow') {
            pendingWorkflows += 1;
          }
        }
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        // Sender attribution (B-MU-UX-FIX-MSG-AUTHOR): user-authored text
        // echoed by this run is stamped with the JWT-sourced socket userId so
        // mirrors (other viewers) can render the true author — but ONLY for
        // human-origin text. SDK user messages whose origin is non-human
        // (origin.kind 'coordinator' = coordinator → subagent prompt via the
        // Task tool, also 'peer'/'channel'/'task-notification') carry
        // `originKind` from the adapter and are never attributed to the
        // human, otherwise agent directives render as user bubbles.
        stampHumanUserId(msg, ws?.userId);
        // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR): every
        // assistant-driven payload this run emits was spawned by the human on
        // this socket. Stamp the JWT-sourced coordinatorId so live viewers (and
        // the spawner's mirrors) attribute the reply to the real participant
        // instead of the session owner. No-op for the user echo handled above.
        stampCoordinatorId(msg, ws?.userId);
        sendAndBuffer(msg);
      }

      // Fork: stale `resume` surfaces as an error result whose text names the
      // missing conversation. Throw a tagged error so the shared catch path
      // can trigger the fresh-session fallback instead of streaming a
      // dead-end error to the user. (result-only guard — keep inside this block.)
      if (message.type === 'result') {
        if (message.is_error || message.subtype === 'error_during_execution') {
          const resultText = typeof message.result === 'string' ? message.result : '';
          if (isResumeSessionMissingError(resultText)) {
            const resumeError = new Error(resultText);
            resumeError.resumeSessionMissing = true;
            throw resumeError;
          }
        }
      }

      // Lazy model-discovery backstop (B-MODEL-DISCOVERY): if THIS run's model
      // failed because Anthropic has not released it for the account
      // (model_not_found / api_error_status 404), record it as broken for this
      // user so the catalog hides it next time. Once per run (the flag stops a
      // multi-message result from recording twice). Pure observation: this does
      // NOT swap the writer, touch the replay registry / detach, abort the run,
      // or alter the stream — the message still flows through sendAndBuffer
      // above exactly as before, so the user still sees the native error. The
      // store write is fire-and-forget and never throws into this loop.
      if (
        runModelForDiscovery
        && !unreleasedModelRecorded
        && isUnreleasedModelFailure(message)
      ) {
        unreleasedModelRecorded = true;
        const brokenUserId = ws?.userId ?? null;
        void recordBrokenModel(brokenUserId, runModelForDiscovery)
          .then((added) => {
            if (added) {
              console.warn(
                `[claude-discovery] model "${runModelForDiscovery}" reported `
                + `unreleased (model_not_found/404); hiding from catalog`
                + `${brokenUserId ? ` [user=${brokenUserId}]` : ''}`
              );
            }
          })
          .catch(() => {
            // Store failure is non-fatal; the live catalog still works.
          });
      }

      // Extract and send token budget updates from assistant/result usage payloads (#807)
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        sendAndBuffer(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send completion event. ADR-041: routed through sendAndBuffer so the
    // terminal `complete` is buffered too — a socket reconnecting inside the
    // post-close retention window then replays it (re-emitting `complete` is
    // read-only and idempotent on the client, so it is safe unlike the live
    // critical path). The active flag is flipped to inactive immediately AFTER,
    // so the buffer survives for the retention window but the session is no
    // longer reported processing.
    sendAndBuffer(createNormalizedMessage({ kind: 'complete', exitCode: 0, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude', pendingWorkflows }));
    // ADR-041: terminal state — flip the single source of truth to inactive and
    // schedule a deferred buffer drop (post-close replay window, not an immediate
    // drop). No-op when SESSION_REGISTRY_claude is off.
    if (capturedSessionId || sessionId) {
      claudeSessionRegistry.setActive(capturedSessionId || sessionId, false);
      scheduleClaudeBufferDrop(capturedSessionId || sessionId);
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: 'completed'
    });
    // Complete
    return { ok: true };

  } catch (error) {
    console.error('SDK query error:', error);

    // B-40a: cancel dangling tool approvals so approval promises resolve
    // immediately rather than leaking until TOOL_APPROVAL_TIMEOUT_MS.
    if (capturedSessionId) {
      cancelPendingApprovalsForSession(capturedSessionId);
    }

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }
    // ADR-041: terminal (error) state — flip the registry's active flag to
    // inactive and schedule the deferred buffer drop (post-close replay window),
    // mirroring the success path. The structured `error` payload below keeps its
    // direct ws.send so a failure is never gated on the registry; we only manage
    // the lifecycle here. No-op when SESSION_REGISTRY_claude is off.
    if (capturedSessionId || sessionId) {
      claudeSessionRegistry.setActive(capturedSessionId || sessionId, false);
      scheduleClaudeBufferDrop(capturedSessionId || sessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Stale-resume fallback: when the caller is allowed to retry, swallow the
    // missing-conversation error here (no UI error, no failure notification) and
    // hand control back so the wrapper can restart as a fresh session.
    if (suppressResumeMissError && (error?.resumeSessionMissing || isResumeSessionMissingError(error))) {
      return { ok: false, resumeSessionMissing: true };
    }

    // Check if Claude CLI is installed for a clearer error message
    // B-32: map spawn/runtime errors to structured codes.
    const installed = await providerAuthService.isProviderInstalled('claude');
    let errorCode;
    let errorContent;
    if (!installed) {
      errorCode = 'cli_not_installed';
      errorContent = 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code';
    } else {
      const mapped = mapSpawnError(error);
      errorCode = mapped.code;
      errorContent = mapped.fallbackMessage;
    }

    // B-33: for a new session (no prior sessionId), include a requestId so the
    // frontend can correlate the error with the originating spawn request.
    const errorSessionId = capturedSessionId || sessionId || null;
    ws.send(createNormalizedMessage({
      kind: 'error',
      code: errorCode,
      content: errorContent,
      sessionId: errorSessionId,
      provider: 'claude',
      ...(!errorSessionId ? { isNewSessionError: true } : {}),
    }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
    return { ok: false };
  } finally {
    // T-822 (§ج-4): release the per-conversation chat-turn lock on EVERY exit
    // (success, error, any return in the loop). No-op when the seam left it null
    // (flag off / new session / fail-open) so it is inert on the default path.
    if (chatTurnLock) {
      chatTurnLock.release();
    }
  }
}

/**
 * Public entry point. Wraps {@link runClaudeSDKQuery} and, when a `--resume`
 * (SDK `resume`) target no longer exists, surfaces an explicit
 * `conversation_not_found` signal to the client instead of silently starting a
 * fresh conversation.
 *
 * Rationale: a silent auto-restart loses the user's expectation that they are
 * continuing a specific conversation. Instead, the client renders a clear error
 * with a "start new session" button so the restart is a deliberate user action.
 * Every other error keeps the original behaviour, and runs that never asked to
 * resume skip the detection path entirely.
 *
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId } = options;

  // No resume requested → nothing to detect. Run once, plain.
  if (!sessionId) {
    await runClaudeSDKQuery(command, options, ws);
    return;
  }

  const result = await runClaudeSDKQuery(command, options, ws, {
    suppressResumeMissError: true,
  });

  if (!result?.resumeSessionMissing) {
    return;
  }

  // The previous conversation is gone. Do NOT auto-restart: emit an explicit
  // signal carrying the stale session id and the original command so the client
  // can offer a "start new session" action that re-sends this same prompt.
  ws.send(createNormalizedMessage({
    kind: 'error',
    code: 'conversation_not_found',
    content: 'The previous session could not be resumed — it has expired or been removed.',
    staleSessionId: sessionId,
    command,
    sessionId,
    provider: 'claude',
  }));
}

/**
 * Aborts an active SDK session.
 *
 * Resolution order (B-ABORT-FALLBACK):
 *   1. Exact match on the supplied sessionId.
 *   2. If that misses AND a raw socket is supplied, fall back to the newest
 *      active session bound to that same connection. This covers the brand-new
 *      session race where the user hits STOP before the SDK has reported its
 *      real session_id, so the client had no concrete id (or a stale one) to
 *      send. Aborting "the run this socket just started" is always the user's
 *      intent on STOP, so the fallback is safe and connection-scoped.
 *
 * @param {string} sessionId - Session identifier supplied by the client.
 * @param {object|null} [rawWs] - The raw WebSocket the abort arrived on, used
 *   only for the connection fallback above.
 * @returns {Promise<{ aborted: boolean, reason: string, sessionId: string|null }>}
 *   Structured result; `aborted` is the boolean the WS layer maps to success.
 */
async function abortClaudeSDKSession(sessionId, rawWs = null) {
  let resolvedId = sessionId;
  let session = getSession(resolvedId);

  if (!session && rawWs) {
    const fallbackId = getNewestSessionForSocket(rawWs);
    if (fallbackId) {
      resolvedId = fallbackId;
      session = getSession(resolvedId);
      console.log(
        `[WS-DIAG] sdk-abort fallback: requested=${sessionId || 'none'} `
        + `resolved-by-connection=${resolvedId}`
      );
    }
  }

  if (!session) {
    const reason = sessionId
      ? `no active claude session matched id=${sessionId} (and none active on this connection)`
      : 'abort carried no sessionId and the connection has no active claude session';
    console.log(`[WS-DIAG] sdk-abort no-op: ${reason}`);
    return { aborted: false, reason, sessionId: null };
  }

  sessionId = resolvedId;

  try {
    console.log(`Aborting SDK session: ${sessionId}`);
    // [WS-DIAG] Abort path (point #2). Distinguishes an explicit user/abort-driven
    // teardown of the SDK query from the silent orphaning that happens on socket
    // close (where NO abort is issued and the run keeps streaming into a dead
    // socket). If a freeze occurs WITHOUT this line, the run was orphaned, not aborted.
    const wsDiagAbortRaw = session?.writer?.ws ? session.writer.ws.readyState : 'no-raw-ws';
    console.log(
      `[WS-DIAG] sdk-abort session=${sessionId} status=${session?.status ?? 'unknown'} `
      + `writerRawReadyState=${wsDiagAbortRaw}`
    );

    // B-40a: cancel any tool approval that is waiting for user interaction
    // so the approval promise resolves immediately instead of blocking for
    // TOOL_APPROVAL_TIMEOUT_MS after the session is already aborted.
    cancelPendingApprovalsForSession(sessionId);

    // Call interrupt() on the query instance
    if (!session.instance || typeof session.instance.interrupt !== 'function') {
      const reason = `session ${sessionId} has no interruptable SDK instance`;
      console.error(`[WS-DIAG] sdk-abort failed: ${reason}`);
      return { aborted: false, reason, sessionId };
    }
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return { aborted: true, reason: 'interrupted', sessionId };
  } catch (error) {
    const detail = error?.message || String(error);
    console.error(`[WS-DIAG] sdk-abort interrupt() threw for session ${sessionId}:`, error);
    return { aborted: false, reason: `interrupt() failed: ${detail}`, sessionId };
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * ADR-042 (B-80c): the claude sessions the DRAIN must still wait for — active
 * sessions that are NOT detached. A detached ghost (lost every listener past the
 * grace period) keeps running in the background and writes complete jsonl, so it
 * must not hold `pm2 restart` hostage until kill_timeout. Consumed EXCLUSIVELY
 * by the drain count in index.js (behind the CLAUDE_GHOST_DETACH flag).
 *
 * `getActiveClaudeSDKSessions()` stays unchanged — a detached session is still
 * "active" for display (UI / get-active-sessions / WS-DIAG); it is just no
 * longer "drain-blocking". Clean split between the two concepts.
 * @returns {Array<string>} Active, non-detached session IDs.
 */
function getDrainBlockingClaudeSessions() {
  const out = [];
  for (const [sid, session] of activeSessions) {
    if (!session.detached) out.push(sid);
  }
  return out;
}

/**
 * B-40a: Cancel all pending tool-approval callbacks for a session and signal
 * each one as cancelled. Called on abort and on session error so dangling
 * approval promises are resolved instead of waiting for TOOL_APPROVAL_TIMEOUT_MS.
 *
 * @param {string} sessionId - The session ID whose approvals should be cancelled
 */
function cancelPendingApprovalsForSession(sessionId) {
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      // Resolve with a cancelled decision so the permission_request flow
      // returns a deny rather than blocking until the timeout fires.
      resolver({ allow: false, cancelled: true });
      // Note: resolver itself removes itself from pendingToolApprovals via the
      // cleanup() registered in waitForToolApproval, so no manual delete here.
    }
  }
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  // Block swap during the grace window after session end — prevents race
  // between removeSession() and the next addSession() for the same sessionId.
  if (recentlyEndedSessions.has(sessionId)) {
    console.log(`[RECONNECT] Skipped writer swap for ${sessionId} — in grace period`);
    // [WS-DIAG] (point #4) Re-bind refused because the session just ended (grace
    // window). The new socket will not receive the stream; expected for completed runs.
    console.log(`[WS-DIAG] writer-swap-skipped session=${sessionId} reason=grace-period`);
    return false;
  }
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) {
    // [WS-DIAG] (point #4) No writer to swap (session unknown or no writer). A
    // reconnecting socket finds nothing to re-bind — stream cannot be resumed here.
    console.log(
      `[WS-DIAG] writer-swap-skipped session=${sessionId} `
      + `reason=no-writer hasSession=${Boolean(session)}`
    );
    return false;
  }
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  // [WS-DIAG] (point #4) Writer successfully re-bound to the new socket. This only
  // happens when the run is IDLE (isActive===false at the caller); an ACTIVE run is
  // vetoed by the `if(!isActive)` guard in chat-websocket.service and never reaches here.
  console.log(`[WS-DIAG] writer-swap-applied session=${sessionId}`);
  return true;
}

/**
 * ADR-041 (B-80): read-only differential replay for a reconnecting socket on a
 * claude session. Re-emits ONLY the buffered payloads with `seq > lastSeq` to
 * `send`, oldest-first. Performs NO writer swap and NO abort of the running SDK
 * query — it strictly reads the per-session RingBuffer (the active writer of the
 * live session is left untouched, honouring the ADR-021 `if(!isActive)` no-swap
 * veto). Returns the highest seq replayed, or the supplied `lastSeq` when nothing
 * newer exists / the flag is off / the session is unknown. Mirrors
 * attachAntigravitySession in agy-cli.js exactly.
 *
 * @param {string} sessionId - The session ID whose buffer to replay.
 * @param {number} lastSeq - The highest seq the client already received.
 * @param {(payload: unknown) => void} send - Sink for each replayed payload.
 * @returns {number} Highest seq replayed (or lastSeq when nothing newer).
 */
function attachClaudeSDKSession(sessionId, lastSeq, send) {
  const result = claudeSessionRegistry.attach(sessionId, lastSeq, send);
  return result === null ? (Number.isFinite(lastSeq) ? lastSeq : 0) : result;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  cancelPendingApprovalsForSession,
  reconnectSessionWriter,
  attachClaudeSDKSession,
  claudeSessionRegistry,
  resolveContextWindow,
  getClaudeBuiltInCommands,
  mapCliOptionsToSDK,
  buildValidClaudeModelValues,
  // Lazy model-discovery (B-MODEL-DISCOVERY): pure detector for the
  // model_not_found/404 signal. Exported for unit testing only.
  isUnreleasedModelFailure,
  resolveEffortLevel,
  maybeApplyUltracodeKeywords,
  // ADR-042 (B-80c) ghost-detach.
  getDrainBlockingClaudeSessions,
  ghostDetachEnabled,
  // Test seam for the ghost sweep (ADR-042 test plan). addSession/removeSession
  // are the real production paths — using them keeps the unit tests faithful.
  sweepGhostSessions,
  addSession,
  removeSession,
  getSession,
  // Pure helpers — exported for unit testing only (no side effects, no I/O).
  handleFiles
};
