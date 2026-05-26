// Antigravity (agy) CLI adapter.
// Mirrors the lifecycle contract of gemini-cli.js so the chat WebSocket layer
// can dispatch antigravity-command identically to gemini-command, but:
//   * the binary is `agy` and accepts the prompt as a positional argument (-p)
//   * conversations are addressed by a `brain` UUID stored under
//     ~/.gemini/antigravity-cli/brain/<UUID>/ rather than a CLI-reported session id
//   * output is plain text streamed on stdout; no JSON envelope to parse.
//
// Brain UUID discovery is filesystem-based: we snapshot existing UUID folders
// before spawn and pick the newly-created one after the process exits. This
// avoids depending on agy emitting any structured "session created" event.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import sessionManager from './sessionManager.js';
import { participantsDb, sessionsDb } from './modules/database/index.js';
import {
    clearAntigravityProjectPath,
    registerAntigravityProjectPath,
} from './modules/providers/list/antigravity/antigravity-project-registry.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage } from './shared/utils.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { userConfigDir } from './services/isolation/provision-user-dirs.js';
import { isProviderIsolated } from './services/provider-sharing.js';

const AGY_PATH = process.env.AGY_PATH || path.join(os.homedir(), '.local', 'bin', 'agy');

// Brain store location. When agy is isolated for this user (admin policy) the
// spawn env sets HOME to the per-user root, so agy materializes its brain under
// that user's ~/.gemini/antigravity-cli/brain. The filesystem-based brain
// discovery and transcript-path logic must read from the SAME directory, so we
// compute it from the per-user home whenever isolation is active. When agy is
// shared (default / ADR-016) or there is no authenticated user, fall back to the
// operator home — identical to the previous static BRAIN_DIR.
function getBrainDir(userId = null) {
    const shouldIsolate =
        userId !== null && userId !== undefined && userId !== '' && isProviderIsolated('agy');
    const homeRoot = shouldIsolate ? userConfigDir(userId, '') : os.homedir();
    return path.join(homeRoot, '.gemini', 'antigravity-cli', 'brain');
}

// Project-level instructions filename, mirrored at both the project root and the
// global config dir (~/.claude). agy has no native equivalent of CLAUDE.md, so we
// inject these instructions ourselves on the first message of a fresh conversation.
const INSTRUCTIONS_FILENAME = 'NASSAJ.md';

// Read a UTF-8 file, returning trimmed content or null on any failure (missing
// file, permission error, etc.). Silent by design: instruction files are
// optional and their absence must never block a run.
async function readInstructionFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const trimmed = content.trim();
        return trimmed ? trimmed : null;
    } catch {
        return null;
    }
}

// Always-on base instruction injected at the start of every new conversation.
// Kept minimal: just the language rule that agy ignores by default.
const BASE_INSTRUCTIONS = `IMPORTANT: Always respond exclusively in formal Arabic (العربية الفصحى). Never switch to English under any circumstances, even for technical terms — transliterate or translate them instead.`;

// Build the instructions prefix injected ahead of the user's first message in a
// new conversation. Merges: base instructions (always) + project-specific file
// (<projectPath>/NASSAJ.md or CLAUDE.md, if present).
// The global ~/.claude/NASSAJ.md is NOT injected — it contains nassaj branding
// that misleads agy when working in unrelated projects (e.g. diwan).
async function buildInstructionsPrefix(projectPath) {
    const parts = [BASE_INSTRUCTIONS];

    if (projectPath) {
        const projectInstructions =
            (await readInstructionFile(path.join(projectPath, INSTRUCTIONS_FILENAME))) ||
            (await readInstructionFile(path.join(projectPath, 'CLAUDE.md')));
        if (projectInstructions) parts.push(projectInstructions);
    }

    return `<instructions>\n${parts.join('\n\n')}\n</instructions>`;
}

// Map agy CLI exit codes to actionable messages. Mirrors mapGeminiExitCodeToMessage
// in gemini-cli.js so the chat surface stays consistent across providers.
function getAgyExitMessage(code) {
    const messages = {
        1: 'agy CLI general error. Check if agy is installed: ~/.local/bin/agy --version',
        2: 'agy CLI authentication error. Run: agy -p "hello" to re-authenticate',
        126: 'agy CLI permission denied. Check file permissions: chmod +x ~/.local/bin/agy',
        127: 'agy CLI not found. Install from: https://developers.google.com/gemini/antigravity',
        130: 'agy CLI was interrupted (SIGINT)',
        143: 'agy CLI was terminated (SIGTERM)',
    };
    return messages[code] || `agy exited with code ${code}`;
}

// Track active sessions keyed by nassaj-side sessionId.
// Value: { process, brainUUID } — brainUUID is the agy conversation id, populated
// either from the resumed session or discovered on close for new sessions.
const activeSessions = new Map();

async function listBrainIds(userId = null) {
    try {
        const entries = await fs.readdir(getBrainDir(userId));
        return new Set(entries);
    } catch {
        // The brain dir may not exist yet on a fresh install; treat as empty set.
        return new Set();
    }
}

// B-ISO-AGYLOCK: narrow in-process mutex over the brain-UUID discovery window.
//
// agy reports no session id; we identify a fresh brain by diffing the BRAIN_DIR
// snapshot taken before spawn against the dir after the brain folder appears. If
// two fresh spawns interleave their snapshots, both could diff the same newly
// created folder and bind the wrong conversation. We serialize ONLY the window
// from "snapshot prior ids" to "new UUID assigned" — a few hundred ms — so it
// never blocks conversation reads or other providers' spawns. Implemented as a
// promise chain (no async-mutex dependency): each acquirer awaits the previous
// release before snapshotting.
let agyDiscoveryChain = Promise.resolve();

function acquireDiscoveryLock() {
    let release;
    const ready = agyDiscoveryChain;
    agyDiscoveryChain = new Promise((resolve) => {
        release = resolve;
    });
    return ready.then(() => release);
}

function generateNassajSessionId() {
    // Pattern matches the cursor/codex adapters: timestamp + random suffix.
    // We avoid using brainUUID as the nassaj session id so multiple resumes of
    // the same brain don't collide in activeSessions before discovery.
    return `agy_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildTranscriptPath(brainUUID, userId = null) {
    return path.join(getBrainDir(userId), brainUUID, '.system_generated', 'logs', 'transcript.jsonl');
}

// Extract the brain UUID embedded in a transcript jsonl_path, i.e. the path
// segment immediately under the brain root: .../brain/<UUID>/.system_generated/...
// Returns null when the path does not match the expected antigravity layout.
function extractBrainUUIDFromJsonlPath(jsonlPath) {
    if (typeof jsonlPath !== 'string' || !jsonlPath) {
        return null;
    }
    const marker = `${path.sep}brain${path.sep}`;
    const markerIndex = jsonlPath.indexOf(marker);
    if (markerIndex === -1) {
        return null;
    }
    const afterBrain = jsonlPath.slice(markerIndex + marker.length);
    const uuid = afterBrain.split(path.sep)[0];
    return uuid || null;
}

// Recover the agy brain UUID for a resumed session from the persisted DB row.
// Used when the in-memory sessionManager has no `cliSessionId` (server restart,
// or a conversation opened from history). Only antigravity rows are honoured so
// a Claude/cursor session id can never be misread as a brain UUID. The brain
// UUID is taken from the jsonl_path when present and otherwise from the
// session_id itself, which for antigravity sessions equals the brain UUID.
function resolveBrainUUIDFromDb(sessionId) {
    let row;
    try {
        row = sessionsDb.getSessionById(sessionId);
    } catch (err) {
        console.error('[agy] failed to look up session for resume:', err?.message || err);
        return null;
    }

    if (!row || row.provider !== 'antigravity') {
        return null;
    }

    return extractBrainUUIDFromJsonlPath(row.jsonl_path) || row.session_id || null;
}

// Discovers the brain UUID created by a fresh agy run and binds it to its real
// workspace path. Runs at most once per spawn (idempotent via the shared state
// object). We register the real path in two places so a concurrent synchronize()
// can never file the placeholder for this conversation:
//   * the in-process registry the synchronizer consults before falling back, and
//   * the DB row itself, so the binding survives once written.
// Discovery is filesystem diff-based, so it works as soon as agy materializes the
// brain folder (on first output) rather than waiting for process exit.
async function discoverAndRegisterBrainSession(state, priorBrainIds, cleanCwd, finalSessionId, userId = null) {
    if (state.discovered) {
        return;
    }

    let currentBrainIds;
    try {
        currentBrainIds = await listBrainIds(userId);
    } catch {
        return;
    }

    const discoveredBrainUUID = [...currentBrainIds].find((id) => !priorBrainIds.has(id)) || null;
    if (!discoveredBrainUUID) {
        // The brain folder may not exist yet on the first chunk; retry on a later
        // chunk or at close. Leave state.discovered false so we try again.
        return;
    }

    state.discovered = true;
    state.brainUUID = discoveredBrainUUID;

    // Bind for the synchronizer first: this is synchronous and closes the race
    // window even if the DB write below is delayed or fails.
    registerAntigravityProjectPath(discoveredBrainUUID, cleanCwd);

    const persisted = sessionManager.getSession(finalSessionId);
    if (persisted) {
        persisted.cliSessionId = discoveredBrainUUID;
        sessionManager.saveSession(finalSessionId);
    }

    try {
        sessionsDb.createSession(
            discoveredBrainUUID,
            'antigravity',
            cleanCwd,
            undefined,
            undefined,
            undefined,
            buildTranscriptPath(discoveredBrainUUID, userId),
        );
    } catch (err) {
        console.error('[agy] failed to register session in DB:', err?.message || err);
    }
}

async function spawnAntigravity(command, options = {}, ws) {
    const opts = options && typeof options === 'object' ? options : {};
    const { sessionId, projectPath, cwd, sessionSummary } = opts;

    // The authenticated user driving this run. Drives both the spawn env
    // (resolveProviderEnv) and which brain dir we read for UUID discovery, so
    // an isolated agy reads/writes the same per-user brain store.
    const userId = ws?.userId ?? null;

    // Resolve the brain UUID for resume. Primary source is the in-memory
    // sessionManager (`cliSessionId`, matching the gemini adapter naming). It is
    // populated only during the run that created the conversation, so it is
    // empty after a server restart or when the chat was resumed from history.
    // Fall back to the persisted session row in that case: for antigravity
    // sessions the nassaj session_id IS the brain UUID (see
    // discoverAndRegisterBrainSession below, which writes the row keyed by the
    // discovered brain UUID), and the jsonl_path embeds the same UUID. Without
    // this fallback a resume would be misdetected as a fresh conversation and
    // start a new brain instead of continuing the existing transcript.
    const existingSession = sessionId ? sessionManager.getSession(sessionId) : null;
    const existingBrainUUID = existingSession?.cliSessionId
        || (sessionId ? resolveBrainUUIDFromDb(sessionId) : null);

    // B-ISO-AGYLOCK: only fresh conversations (no brain to resume) race on UUID
    // discovery, so serialize the discovery window for those only. Resumed
    // conversations carry an explicit --conversation id and need no lock.
    const needsDiscovery = !existingBrainUUID;
    const releaseDiscoveryLock = needsDiscovery ? await acquireDiscoveryLock() : null;
    let discoveryLockReleased = false;
    const freeDiscoveryLock = () => {
        if (releaseDiscoveryLock && !discoveryLockReleased) {
            discoveryLockReleased = true;
            releaseDiscoveryLock();
        }
    };

    // Snapshot brain UUIDs *before* spawn so we can detect the new one after close.
    const priorBrainIds = await listBrainIds(userId);

    // Inject project + global instructions only on a fresh conversation (no brain
    // to resume). Resumed conversations already carry their context, so re-sending
    // the prefix would duplicate it on every turn. The injected prefix is sent to
    // agy only — sessionManager records the original user message below — so the
    // chat history surface stays free of instruction boilerplate.
    let commandToSend = command || '';
    if (!existingBrainUUID) {
        const instructionsPrefix = await buildInstructionsPrefix(projectPath || cwd);
        if (instructionsPrefix) {
            commandToSend = `${instructionsPrefix}\n\n${commandToSend}`;
        }
    }

    // Resolve and sanitize the workspace dir up front — strip non-printable chars
    // that can leak in from terminal copy/paste. This value is both the process
    // cwd AND the explicit agy workspace (--add-dir) below.
    const cleanCwd = (cwd || projectPath || process.cwd())
        .replace(/[^\x20-\x7E]/g, '')
        .trim();

    // agy in --print mode ignores the OS process cwd and defaults to its internal
    // scratch directory (~/.gemini/antigravity-cli/scratch). Without an explicit
    // workspace it wanders the home tree and latches onto unrelated projects
    // (e.g. it reads ~/nassaj-core/NASSAJ.md while the user is in diwan). Pin the
    // workspace to the selected project with --add-dir so agy stays scoped to it.
    const args = ['-p', commandToSend, '--dangerously-skip-permissions'];
    if (cleanCwd) {
        args.push('--add-dir', cleanCwd);
    }
    if (existingBrainUUID) {
        args.push('--conversation', existingBrainUUID);
    }

    // Establish (or reuse) the nassaj-side session id and persist it so the
    // chat history layer can correlate streamed messages with their session.
    let finalSessionId = sessionId;
    let isNewSession = false;
    if (!finalSessionId) {
        finalSessionId = generateNassajSessionId();
        isNewSession = true;
        sessionManager.createSession(finalSessionId, cwd || projectPath || process.cwd());
    }

    if (command) {
        sessionManager.addMessage(finalSessionId, 'user', command);
    }

    let sessionCreatedSent = false;
    let assistantText = '';
    let terminalNotified = false;

    const safeSend = (payload) => {
        if (!ws) return;
        try {
            ws.send(createNormalizedMessage({ ...payload, provider: 'antigravity' }));
        } catch (err) {
            // ws may close mid-stream; avoid crashing the spawn pipeline.
            console.error('[agy] failed to forward ws payload:', err?.message || err);
        }
    };

    const notifyTerminal = ({ code = null, error = null } = {}) => {
        if (terminalNotified) return;
        terminalNotified = true;

        if (code === 0 && !error) {
            notifyRunStopped({
                userId: ws?.userId || null,
                provider: 'antigravity',
                sessionId: finalSessionId,
                sessionName: sessionSummary,
                stopReason: 'completed',
            });
            return;
        }

        notifyRunFailed({
            userId: ws?.userId || null,
            provider: 'antigravity',
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            error: error || getAgyExitMessage(code),
        });
    };

    let agProcess;
    try {
        agProcess = spawn(AGY_PATH, args, {
            cwd: cleanCwd,
            // Single source of truth for the spawn env. When agy is isolated for
            // this user (admin policy) the resolver overrides HOME to the per-user
            // root so the brain store lands in the isolated tree; when shared it
            // returns the operator env unchanged (ADR-016 default).
            env: resolveProviderEnv(userId, 'agy', process.env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        freeDiscoveryLock();
        safeSend({ kind: 'error', content: `Failed to launch agy: ${err.message}`, sessionId: finalSessionId });
        notifyTerminal({ error: err });
        throw err;
    }

    activeSessions.set(finalSessionId, { process: agProcess, brainUUID: existingBrainUUID });

    // Record the authenticated human who spawned this agy run. Idempotent at the
    // DB layer; skipped for unauthenticated (single-user) runs with no userId.
    if (ws?.userId) {
        participantsDb.recordSpawn(finalSessionId, ws.userId);
    }

    // Shared discovery state so the early stdout hook and the close-time safety
    // net cooperate and never double-register the same brain UUID.
    const discoveryState = { discovered: false, brainUUID: existingBrainUUID };

    return new Promise((resolve, reject) => {
        // Emit session_created on the first stdout chunk for new sessions so the
        // frontend can pin the conversation id before the stream finishes.
        agProcess.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            if (!text) return;

            if (!sessionCreatedSent && isNewSession) {
                sessionCreatedSent = true;
                safeSend({
                    kind: 'session_created',
                    newSessionId: finalSessionId,
                    sessionId: finalSessionId,
                });
            }

            // Bind the real workspace path as early as possible — agy has already
            // materialized the brain folder by the time it streams output — so any
            // synchronize() that fires mid-run resolves the real project instead of
            // racing the close handler and writing the placeholder.
            if (!existingBrainUUID && !discoveryState.discovered) {
                discoverAndRegisterBrainSession(discoveryState, priorBrainIds, cleanCwd, finalSessionId, userId)
                    .then(() => {
                        // Release the discovery lock the moment a UUID is bound, so the
                        // window stays narrow and concurrent fresh spawns proceed.
                        if (discoveryState.discovered) {
                            freeDiscoveryLock();
                        }
                    })
                    .catch(() => { /* retried on next chunk / at close */ });
            }

            assistantText += text;
            safeSend({ kind: 'stream_delta', content: text, sessionId: finalSessionId });
        });

        agProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            // agy inherits node's deprecation noise; suppress it to keep the
            // chat transcript clean and avoid false error toasts on the client.
            if (!msg) return;
            if (msg.includes('DeprecationWarning') || msg.includes('[DEP')) return;
            console.error('[agy stderr]', msg.trim());
        });

        agProcess.on('close', async (code) => {
            activeSessions.delete(finalSessionId);

            // Safety net: a run that produced no stdout (or whose brain folder
            // appeared only at exit) skips the early discovery hook, so retry here.
            // discoverAndRegisterBrainSession is idempotent via discoveryState.
            if (!existingBrainUUID) {
                await discoverAndRegisterBrainSession(discoveryState, priorBrainIds, cleanCwd, finalSessionId, userId);
            }
            // Always release the discovery lock at close — covers runs that never
            // produced stdout or where discovery never bound a UUID.
            freeDiscoveryLock();
            const discoveredBrainUUID = existingBrainUUID ? null : discoveryState.brainUUID;

            // The DB row now carries the real path durably; drop the in-process
            // binding so the registry never grows unbounded across long uptimes.
            if (discoveredBrainUUID) {
                clearAntigravityProjectPath(discoveredBrainUUID);
            }

            if (assistantText) {
                sessionManager.addMessage(finalSessionId, 'assistant', assistantText);
            }

            // PDPL audit log — metadata only, never message content.
            // Session id is sufficient as an audit trail; client IP is intentionally omitted.
            console.log(JSON.stringify({
                audit: true,
                event: 'antigravity_session_end',
                timestamp: new Date().toISOString(),
                sessionId: finalSessionId,
                brainUUID: discoveredBrainUUID || existingBrainUUID || null,
                exitCode: code,
                provider: 'antigravity',
            }));

            safeSend({
                kind: 'complete',
                exitCode: code,
                isNewSession,
                sessionId: finalSessionId,
            });

            if (code !== 0) {
                safeSend({
                    kind: 'error',
                    content: getAgyExitMessage(code),
                    sessionId: finalSessionId,
                });
                notifyTerminal({ code });
                // Resolve rather than reject so the WS dispatcher does not turn
                // a non-zero exit into a generic "websocket error" toast — the
                // structured error message above already informs the user.
                resolve({ code, sessionId: finalSessionId });
                return;
            }

            notifyTerminal({ code });
            resolve({ code, sessionId: finalSessionId });
        });

        agProcess.on('error', (err) => {
            activeSessions.delete(finalSessionId);
            freeDiscoveryLock();
            safeSend({ kind: 'error', content: err.message, sessionId: finalSessionId });
            notifyTerminal({ error: err });
            reject(err);
        });
    });
}

function abortAntigravitySession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session?.process) return false;

    try {
        session.process.kill('SIGTERM');
    } catch {
        return false;
    }

    const killTimer = setTimeout(() => {
        if (activeSessions.has(sessionId)) {
            try {
                session.process.kill('SIGKILL');
            } catch {
                // Best-effort cleanup; process may already be gone.
            }
        }
    }, 5000);
    // Don't hold the event loop open just for the safety-net SIGKILL.
    killTimer.unref?.();
    return true;
}

function isAntigravitySessionActive(sessionId) {
    return activeSessions.has(sessionId);
}

function getActiveAntigravitySessions() {
    // Match the gemini adapter shape (array of session ids) so the
    // get-active-sessions endpoint stays uniform across providers.
    return Array.from(activeSessions.keys());
}

export {
    spawnAntigravity,
    abortAntigravitySession,
    isAntigravitySessionActive,
    getActiveAntigravitySessions,
};
