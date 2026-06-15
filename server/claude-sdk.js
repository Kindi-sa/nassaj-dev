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
import { assertSubscriptionOAuthOwnerOnly } from './services/isolation/subscription-oauth-guard.js';
import { buildGitAuthorEnv } from './utils/gitIdentity.js';
import {
  PROCESS_TAG_ENV_VAR,
  registerSessionProcess,
  unregisterSessionProcess
} from './services/session-process-monitor.js';
import { messageAuthorsDb, participantsDb, userDb } from './modules/database/index.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Guards the race window between removeSession() and the next addSession() for
// the same sessionId — a writer swap during this gap would mismatch the new ws.
const recentlyEndedSessions = new Map(); // sessionId → expiry timestamp
const RECENTLY_ENDED_GRACE_MS = 2000;

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

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
    writer
  });
  if (writer && runTag) {
    registerSessionProcess(sessionId, { provider: 'claude', writer, runTag, projectPath });
  }
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
  // Stop process-state monitoring and tell every viewer the session is idle.
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

    // Subscription-seat guard (G4 — SUBSCRIPTION-OAUTH-001): if the Claude
    // credential about to be handed to the subprocess is the OWNER's personal
    // Claude subscription (OAuth), refuse to spawn it on behalf of a non-owner.
    // Validated on the FINAL env (after per-user isolation rewrote
    // CLAUDE_CONFIG_DIR), so the detector sees exactly what the child will use.
    // No-op when the credential is an API key / Bedrock / Vertex (licensable
    // per-user) or when the user IS the owner. See subscription-oauth-guard.js.
    //
    // Role resolution: ws.userId is the authenticated human who spawned this run
    // (set on every WebSocketWriter / SSEStreamWriter / ResponseCollector). We
    // look up the live row so the role is authoritative (not a stale client
    // claim). When there is no userId (single-user / system context — e.g. the
    // git commit-message path passes a writer with no userId), the run is the
    // host operator's own: resolve the sole/first user as the owner-equivalent so
    // the owner-always-passes branch applies instead of a fail-closed throw.
    const spawnUserId = ws?.userId ?? null;
    const spawnUser = spawnUserId != null
      ? (userDb.getUserById(spawnUserId) ?? { id: spawnUserId, role: null })
      : (userDb.getFirstUser() ?? null);
    assertSubscriptionOAuthOwnerOnly(sdkOptions.env, spawnUser);

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

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    // Ultracode (UI intensity 4): besides the SDK effort='max' set above, the
    // CLI's "deeper reasoning + multi-agent workflow" super-modes are activated
    // by magic keywords in the prompt text. Append them here so ultracode takes
    // real effect (no-op for every other effort value). Applied after the image
    // annotation so the keywords ride along on the exact text the CLI receives.
    const finalCommand = maybeApplyUltracodeKeywords(imageResult.modifiedCommand, options.effort);
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

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
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
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        // decision.cancelled originates from a runtime/transport abort (e.g. a
        // transient SDK/transport disconnect), NOT from the user denying the
        // request. We keep the { behavior: 'deny', message } contract but return
        // an honest, retryable message instead of implying the user cancelled.
        return { behavior: 'deny', message: 'Tool use was cancelled by the runtime (not by the user). This is likely a transient SDK/transport abort — the request can be retried.' };
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

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

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
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, processRunTag, options.cwd || options.projectPath || null);
        recordParticipant(capturedSessionId);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
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
        ws.send(msg);
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

      // Extract and send token budget updates from assistant/result usage payloads (#807)
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send completion event
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude' }));
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
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // B-40a: cancel any tool approval that is waiting for user interaction
    // so the approval promise resolves immediately instead of blocking for
    // TOOL_APPROVAL_TIMEOUT_MS after the session is already aborted.
    cancelPendingApprovalsForSession(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
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
    return false;
  }
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
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
  resolveContextWindow,
  getClaudeBuiltInCommands,
  mapCliOptionsToSDK,
  buildValidClaudeModelValues,
  resolveEffortLevel,
  maybeApplyUltracodeKeywords
};
