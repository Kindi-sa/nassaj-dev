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
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage } from './shared/utils.js';

const AGY_PATH = process.env.AGY_PATH || path.join(os.homedir(), '.local', 'bin', 'agy');
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

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

async function listBrainIds() {
    try {
        const entries = await fs.readdir(BRAIN_DIR);
        return new Set(entries);
    } catch {
        // BRAIN_DIR may not exist yet on a fresh install; treat as empty set.
        return new Set();
    }
}

function generateNassajSessionId() {
    // Pattern matches the cursor/codex adapters: timestamp + random suffix.
    // We avoid using brainUUID as the nassaj session id so multiple resumes of
    // the same brain don't collide in activeSessions before discovery.
    return `agy_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function spawnAntigravity(command, options = {}, ws) {
    const opts = options && typeof options === 'object' ? options : {};
    const { sessionId, projectPath, cwd, sessionSummary } = opts;

    // Resolve the brain UUID for resume. The sessionManager stores it under
    // `cliSessionId` to match the gemini adapter naming.
    const existingSession = sessionId ? sessionManager.getSession(sessionId) : null;
    const existingBrainUUID = existingSession?.cliSessionId || null;

    // Snapshot brain UUIDs *before* spawn so we can detect the new one after close.
    const priorBrainIds = await listBrainIds();

    const args = ['-p', command || '', '--dangerously-skip-permissions'];
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

    // Clean the working dir like gemini-cli.js does — strip non-printable chars
    // that can leak in from terminal copy/paste.
    const cleanCwd = (cwd || projectPath || process.cwd())
        .replace(/[^\x20-\x7E]/g, '')
        .trim();

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
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        safeSend({ kind: 'error', content: `Failed to launch agy: ${err.message}`, sessionId: finalSessionId });
        notifyTerminal({ error: err });
        throw err;
    }

    activeSessions.set(finalSessionId, { process: agProcess, brainUUID: existingBrainUUID });

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

            // Persist the discovered brain UUID for new sessions so subsequent
            // turns can resume the same agy conversation.
            let discoveredBrainUUID = null;
            if (!existingBrainUUID) {
                try {
                    const currentBrainIds = await listBrainIds();
                    discoveredBrainUUID = [...currentBrainIds].find((id) => !priorBrainIds.has(id)) || null;
                    if (discoveredBrainUUID) {
                        const persisted = sessionManager.getSession(finalSessionId);
                        if (persisted) {
                            persisted.cliSessionId = discoveredBrainUUID;
                            sessionManager.saveSession(finalSessionId);
                        }
                    }
                } catch (err) {
                    console.error('[agy] brain UUID discovery failed:', err?.message || err);
                }
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
