// Hermes (Nous) CLI adapter.
// Mirrors the lifecycle contract of opencode-cli.js so the chat WebSocket layer
// can dispatch `hermes-command` identically to `opencode-command`, but:
//   * the binary is `hermes` invoked headless as `hermes -z PROMPT [-m MODEL]`,
//     which loads its own Nous OAuth from ~/.hermes/auth.json and bypasses tool
//     permissions; it prints a plain-text reply on stdout (no JSON envelope).
//   * because Hermes has no session-id event and its synchronizer returns 0
//     (HermesSessionSynchronizer.synchronize → 0), the routing row in `sessions`
//     is written explicitly at spawn time. Without it getSessionProvider() returns
//     null and a resumed turn is mis-routed to Claude (the very bug T-205 fixes).
//   * plain-text stdout is streamed line-by-line as `stream_delta` (the exact path
//     opencode uses for non-JSON lines), closed with `stream_end` before `complete`.
//     This shows the reply progressively and removes any need for a `thinking` timer.

import { spawn } from 'child_process';
import crypto from 'node:crypto';

import crossSpawn from 'cross-spawn';

import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { sessionsDb } from './modules/database/index.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, stampCoordinatorId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

const activeHermesProcesses = new Map();

const HERMES_NOT_INSTALLED_MESSAGE =
  'Hermes CLI is not installed. Install it and run `hermes setup --portal`.';

async function spawnHermes(command, options = {}, ws) {
  // Mirror opencode B-31: verify the project directory exists before spawning.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      if (ws) {
        ws.send(createNormalizedMessage(
          buildCwdMissingPayload(cwdCheck.error, { sessionId: options.sessionId || null, provider: 'hermes' })
        ));
      }
      return;
    }
  }

  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, sessionSummary } = options;
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    const isNewSession = !sessionId;
    let capturedSessionId = sessionId || null;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let hermesProcess = null;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'hermes',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'hermes',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Hermes CLI exited with code ${code}`,
      });
    };

    // New session: generate the UUID, write the routing row, announce session_created.
    if (isNewSession) {
      capturedSessionId = crypto.randomUUID();

      // Write the `sessions` routing row BEFORE the synchronizer (Hermes has none:
      // HermesSessionSynchronizer.synchronize returns 0). jsonlPath=null — Hermes
      // keeps the transcript in its own store (~/.hermes), not a JSONL file. Without
      // this row getSessionProvider() returns null and the resumed turn is mis-routed
      // to Claude. Wrapped in try/catch (agy-cli pattern) so a DB hiccup never blocks
      // the run; the row also gives recordSpawn its parent for the B-PRIV guard.
      try {
        sessionsDb.createSession(capturedSessionId, 'hermes', workingDir, undefined, undefined, undefined, null);
      } catch (err) {
        console.error('[hermes] failed to register session in DB:', err?.message || err);
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'hermes',
      }));
    }

    // Stream a single stdout line as stream_delta (opencode's non-JSON path). The
    // coordinator id stamp attributes the assistant text to the JWT-sourced spawner
    // so viewers/mirrors render the author correctly (B-MU-UX-FIX-ASSISTANT-AUTHOR).
    const emitLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }
      ws.send(stampCoordinatorId(createNormalizedMessage({
        kind: 'stream_delta',
        content: line,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'hermes',
      }), ws?.userId));
    };

    void providerModelsService.resolveResumeModel('hermes', sessionId, model).then((resolvedModel) => {
      // Security: the prompt is a standalone argv entry, never string-concatenated.
      // `hermes -z` runs headless (loads OAuth, bypasses permissions); there is no
      // resume/conversation flag, so prior context is not replayed in this phase.
      const args = ['-z', command];
      if (resolvedModel) {
        args.push('-m', resolvedModel);
      }

      hermesProcess = spawnFunction('hermes', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Hermes follows agy: env flows through resolveProviderEnv so the iron-rule
        // guard / isolation seam is honoured. 'hermes' is not in the switch, so it
        // returns the shared base env (shared ~/.hermes/auth.json — a documented
        // constraint until Hermes becomes truly multi-user).
        env: resolveProviderEnv(ws?.userId ?? null, 'hermes', { ...process.env }),
      });

      activeHermesProcesses.set(processKey, hermesProcess);
      hermesProcess.sessionId = processKey;
      // Re-key the active map to the real session id so abort/check-status from the
      // client (which carry the UUID) match the live process.
      if (capturedSessionId && capturedSessionId !== processKey) {
        activeHermesProcesses.delete(processKey);
        activeHermesProcesses.set(capturedSessionId, hermesProcess);
        hermesProcess.sessionId = capturedSessionId;
      }
      hermesProcess.stdin.end();

      hermesProcess.stdout.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';
        completeLines.forEach((line) => emitLine(line));
      });

      hermesProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        if (!stderrText.trim()) {
          return;
        }
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'hermes',
        }));
      });

      hermesProcess.on('close', async (code) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeHermesProcesses.delete(finalSessionId);
        activeHermesProcesses.delete(processKey);

        // Flush any trailing partial line, then close the stream BEFORE complete so
        // the converter finalises the streaming assistant bubble (stream_end is a
        // control event) ahead of the terminal `complete`.
        if (stdoutLineBuffer.trim()) {
          emitLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        ws.send(createNormalizedMessage({
          kind: 'stream_end',
          sessionId: finalSessionId,
          provider: 'hermes',
        }));

        ws.send(createNormalizedMessage({
          kind: 'complete',
          exitCode: code,
          isNewSession: isNewSession && !!command,
          sessionId: finalSessionId,
          provider: 'hermes',
        }));

        if (code === 0) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        if (code === 127 || code === null) {
          const installed = await providerAuthService.isProviderInstalled('hermes');
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: HERMES_NOT_INSTALLED_MESSAGE,
              sessionId: finalSessionId,
              provider: 'hermes',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'Hermes CLI process was terminated' : `Hermes CLI exited with code ${code}`));
      });

      hermesProcess.on('error', async (error) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeHermesProcesses.delete(finalSessionId);
        activeHermesProcesses.delete(processKey);

        const installed = await providerAuthService.isProviderInstalled('hermes');
        let errorCode;
        let errorContent;
        if (!installed) {
          errorCode = 'cli_not_installed';
          errorContent = HERMES_NOT_INSTALLED_MESSAGE;
        } else {
          const mapped = mapSpawnError(error);
          errorCode = mapped.code;
          errorContent = mapped.fallbackMessage;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          code: errorCode,
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'hermes',
        }));
        notifyTerminalState({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

function abortHermesSession(sessionId) {
  const process = activeHermesProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  process.kill('SIGTERM');
  activeHermesProcesses.delete(sessionId);
  return true;
}

function isHermesSessionActive(sessionId) {
  return activeHermesProcesses.has(sessionId);
}

function getActiveHermesSessions() {
  return Array.from(activeHermesProcesses.keys());
}

export {
  spawnHermes,
  abortHermesSession,
  isHermesSessionActive,
  getActiveHermesSessions,
};
