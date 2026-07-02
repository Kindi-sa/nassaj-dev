/**
 * Supervisor core — process ONE launch intent (ADR-053 §ج-1..ج-4).
 *
 * This is the pure, dependency-injected heart of the standalone supervisor. It
 * takes a raw intent blob (read from disk) and runs the full gauntlet in order,
 * EARLIEST/RISKIEST FIRST as the ADR mandates:
 *
 *   1. GATE2 — fail-closed identity/ownership (authorizeLaunch). A non-integer or
 *      non-owner userId is DENIED here with ZERO launch and NO owner/system
 *      fallback. This is the ToS blocker; it runs before anything privileged.
 *   2. Concurrency — per-user scope cap (admitLaunch). An (N+1)th launch is
 *      rejected/queued, never launched into OOM.
 *   3. Launch — systemd-run --user --scope with the ISOLATED env from GATE2
 *      passed via --setenv, and supervisor.json written at the MOMENT OF LAUNCH
 *      (not on complete — фиتo T-241).
 *
 * Every dependency (ownership predicate, env resolver, scope lister, launcher,
 * writer, clock) is injected so the whole decision path is unit-testable without
 * a DB, without systemd, and without touching the disk. The runnable entrypoint
 * (supervisor.ts) wires the real adapters.
 *
 * NEVER THROWS: a thrown dependency is mapped to a DENY/error outcome so the
 * supervisor's poll loop can log-and-continue on a single bad intent.
 */

import { authorizeLaunch, type AuthorizeDeps } from './ownership-guard.js';
import { admitLaunch, type ActiveScopeLister } from './concurrency.js';
import { scopeUnitName } from './config.js';
import type { LaunchIntent } from './intent.js';

/** supervisor.json written at the moment of launch. UI reads this via the watcher. */
export type SupervisorRecord = {
  schema_version: '1';
  wfLaunchId: string;
  userId: number;
  projectPath: string;
  session: {
    unit: string;
    started: string;
    heartbeat: string;
    exit_reason: string | null;
  };
};

/** Injected launcher: performs the privileged systemd-run and returns the unit. */
export type ScopeLauncher = (args: {
  intent: LaunchIntent;
  env: NodeJS.ProcessEnv;
}) => Promise<string>;

/** Injected writer: persists supervisor.json for a launch id (atomic). */
export type SupervisorRecordWriter = (
  wfLaunchId: string,
  record: SupervisorRecord,
) => Promise<void>;

export type ProcessIntentDeps = {
  authorize: AuthorizeDeps;
  listActiveScopes: ActiveScopeLister;
  launchScope: ScopeLauncher;
  writeRecord: SupervisorRecordWriter;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
};

export type ProcessIntentOutcome =
  | { status: 'launched'; wfLaunchId: string; unit: string }
  | { status: 'denied'; reason: string }
  | { status: 'queued'; reason: string }
  | { status: 'error'; reason: string };

/**
 * Run one intent through GATE2 → concurrency → launch. The order is fixed:
 * ownership is authorized BEFORE the concurrency probe and BEFORE any launch, so
 * an unauthorized intent never even consumes a concurrency check, and NOTHING
 * privileged runs for it.
 */
export async function processIntent(
  raw: unknown,
  deps: ProcessIntentDeps,
): Promise<ProcessIntentOutcome> {
  // 1) GATE2: fail-closed ownership/identity. DENY => launch nothing, no fallback.
  const auth = authorizeLaunch(raw, deps.authorize);
  if (!auth.allow) {
    return { status: 'denied', reason: auth.reason };
  }
  const { intent, env } = auth;

  // 2) Per-user concurrency cap. Over cap => queued (caller leaves the intent on
  //    disk for a later tick), never an OOM launch.
  const admission = await admitLaunch(intent.userId, deps.listActiveScopes, deps.env ?? process.env);
  if (!admission.admit) {
    return { status: 'queued', reason: admission.reason };
  }

  // 3) Launch under a systemd user scope with the ISOLATED env (GATE2 built it).
  const now = deps.now ?? Date.now;
  let unit: string;
  try {
    unit = await deps.launchScope({ intent, env });
  } catch (error) {
    return {
      status: 'error',
      reason: `scope launch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // supervisor.json written AT THE MOMENT OF LAUNCH (фиток T-241), not on complete.
  const nowIso = new Date(now()).toISOString();
  const record: SupervisorRecord = {
    schema_version: '1',
    wfLaunchId: intent.wfLaunchId,
    userId: intent.userId,
    projectPath: intent.projectPath,
    session: {
      unit: unit || scopeUnitName(intent.wfLaunchId),
      started: nowIso,
      heartbeat: nowIso,
      exit_reason: null,
    },
  };
  try {
    await deps.writeRecord(intent.wfLaunchId, record);
  } catch (error) {
    // The scope IS running; failing to record it is a visibility loss, not a
    // launch failure. Surface as error so the loop logs it, but the scope lives.
    return {
      status: 'error',
      reason: `launched but supervisor.json write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return { status: 'launched', wfLaunchId: intent.wfLaunchId, unit: record.session.unit };
}
