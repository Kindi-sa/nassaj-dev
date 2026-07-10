/**
 * Standalone supervisor entrypoint (ADR-053 §ج, architecture decision (ب)).
 *
 * A SEPARATE PROCESS, on the nassaj-ops pattern — NOT a module inside the
 * critical path. It is meant to run as its own systemd user unit
 * (workflow-supervisor.service, see workflow-supervisor.service.template) so a
 * launched workflow survives the exit of ANY coordinator (terminal/ssh/the
 * nassaj-dev app itself). nassaj-dev only ever WRITES intents; THIS process owns
 * identity validation and the privileged systemd-run.
 *
 * MASTER NO-OP: refuses to start when WORKFLOW_SUPERVISOR is off, so deploying
 * this file changes nothing until the flag is set.
 *
 * REBOOT SEMANTICS (§ج-4, decided): transient scopes do NOT survive reboot and
 * are NOT auto-resumed. After a reboot the supervisor simply resumes polling for
 * NEW intents; any pre-reboot scope is gone and its workflow is surfaced as a
 * visible ORPHAN by the liveness source (is-active → inactive) — visibility, not
 * silent revival, consistent with the rejected resumeFromRunId auto-resume.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { resolveProviderEnvStrict } from '@/services/isolation/resolve-provider-env-strict.js';

import {
  isSupervisorEnabled,
  intentsDir,
  scopeStateDir,
  taskArtifactDir,
} from './config.js';
import type { DurableTask } from './intent.js';
import { processIntent, type SupervisorRecord } from './supervisor-core.js';
import {
  computeIsolationSetenv,
  launchScope,
  listActiveUserScopes,
  listAllActiveScopes,
} from './systemd.js';

const CLAUDE_BIN = process.env.WORKFLOW_SUPERVISOR_CLAUDE_BIN || 'claude';
const POLL_INTERVAL_MS = Number.parseInt(
  process.env.WORKFLOW_SUPERVISOR_POLL_MS ?? '',
  10,
) || 2000;

/** Atomic JSON write (tmp + rename) — same contract as the bridge. */
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, filePath);
}

/** Persist supervisor.json under the per-scope state dir (UI reads via watcher). */
async function writeSupervisorRecord(wfLaunchId: string, record: SupervisorRecord): Promise<void> {
  await atomicWriteJson(path.join(scopeStateDir(wfLaunchId), 'supervisor.json'), record);
}

/**
 * Persist the full DurableTask (delivery context) under the task artifact dir at
 * the moment of launch, so a later monitor can deliver to the requesting
 * conversation. The dir is 0700 (web-originated context — §هـ-4).
 */
async function writeTaskRecord(taskId: string, task: DurableTask): Promise<void> {
  const dir = taskArtifactDir(taskId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => {});
  await atomicWriteJson(path.join(dir, 'task.json'), task);
}

/**
 * Handle one intent file: read → processIntent (GATE2 → concurrency → launch).
 * On a terminal outcome (launched/denied/error) the intent file is consumed
 * (deleted). On `queued` it is LEFT on disk for a later tick.
 */
async function handleIntentFile(filePath: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable/half-written (rename should prevent the latter) — skip; a
    // corrupt file that never becomes valid is cleaned by the sweep timer.
    return;
  }

  const outcome = await processIntent(raw, {
    authorize: {
      // STRICT ownership predicate — NOT visibility (§ج-3 حرج-2).
      isOwnedOrMembered: (projectPath, userId) =>
        projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, userId),
      // FAIL-CLOSED env resolver (§هـ-1): a non-integer id THROWS here instead
      // of falling open to the owner subscription. GATE2 already guarantees an
      // integer id before this runs, so it never throws on the happy path — this
      // is the belt over the fail-open resolveProviderEnv the critic flagged.
      resolveEnv: (userId, provider, baseEnv) =>
        resolveProviderEnvStrict(userId, provider, baseEnv),
    },
    listActiveScopes: listActiveUserScopes,
    // HOST-WIDE gate source (§ج-5) — bounds total memory across all users.
    listAllActiveScopes,
    launchScope: async ({ intent, env }) => {
      // Forward the isolation keys (esp. the ToS-critical CLAUDE_CONFIG_DIR)
      // deterministically — a transient unit inherits NOTHING, so a dropped key
      // would silently fall back to the owner/default credentials.
      const setenv = computeIsolationSetenv(env, process.env);
      // Task artifact dir (result.json[.partial] + DONE land here — §أ-2/§أ-4).
      const resultDir = taskArtifactDir(intent.wfLaunchId);
      await fsp.mkdir(resultDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(resultDir, 0o700).catch(() => {});
      return launchScope({
        wfLaunchId: intent.wfLaunchId,
        userId: intent.userId,
        cwd: intent.projectPath,
        claudeBin: CLAUDE_BIN,
        scriptOrPrompt: intent.scriptOrPrompt,
        model: intent.model,
        setenv,
        resultDir,
      });
    },
    writeRecord: writeSupervisorRecord,
    writeTaskRecord,
  });

  if (outcome.status === 'queued') {
    // Leave the intent for a later tick (capacity may free up).
    console.info(JSON.stringify({ level: 'info', msg: 'workflow intent queued', file: path.basename(filePath), reason: outcome.reason }));
    return;
  }

  // launched / denied / error: consume the intent so it is not reprocessed.
  await fsp.rm(filePath, { force: true });
  console.info(
    JSON.stringify({
      level: outcome.status === 'launched' ? 'info' : 'warn',
      msg: `workflow intent ${outcome.status}`,
      file: path.basename(filePath),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('unit' in outcome ? { unit: outcome.unit } : {}),
    }),
  );
}

/** One poll pass over every user's intents dir. */
async function pollOnce(): Promise<void> {
  const root = intentsDir();
  let userDirs: string[];
  try {
    userDirs = await fsp.readdir(root);
  } catch {
    return; // no intents yet
  }
  for (const userDir of userDirs) {
    const dir = path.join(root, userDir);
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) {
        continue;
      }
      try {
        await handleIntentFile(path.join(dir, file));
      } catch (error) {
        console.error(
          JSON.stringify({ level: 'error', msg: 'intent handler crashed', file, error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }
}

/** Start the poll loop. No-op (never loops) when the flag is off. */
export async function runSupervisor(): Promise<void> {
  if (!isSupervisorEnabled()) {
    console.info(JSON.stringify({ level: 'info', msg: 'WORKFLOW_SUPERVISOR off — supervisor is a no-op, exiting' }));
    return;
  }
  console.info(JSON.stringify({ level: 'info', msg: 'workflow supervisor started', intentsDir: intentsDir(), pollMs: POLL_INTERVAL_MS }));
  // Simple sequential poll loop; the runner pattern favors cron/timer, but a
  // long-lived poller is equivalent and self-contained for the scope of B-103.
  while (true) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Direct-exec entrypoint (node dist-server/.../supervisor.js). Guarded so an
// import for tests does not start the loop.
const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /workflow-supervisor[/\\]supervisor(\.[cm]?js|\.ts)?$/.test(process.argv[1] ?? '');
if (isMain) {
  runSupervisor().catch((error) => {
    console.error(JSON.stringify({ level: 'error', msg: 'supervisor fatal', error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
