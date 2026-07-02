/**
 * Workflow-supervisor configuration & the master feature flag (ADR-053,
 * M-BG-2-CODE — the durable external workflow launcher for B-103).
 *
 * MASTER FLAG: WORKFLOW_SUPERVISOR
 * -------------------------------
 * The ENTIRE feature is gated behind this single env flag. It defaults OFF, and
 * when OFF every entry point in this module is a hard no-op:
 *   - the chat→intent bridge (launch-intent) writes NOTHING,
 *   - the standalone supervisor loop refuses to start,
 *   - the scope-liveness source is never consulted (the pid path is unchanged).
 * There is therefore ZERO behavior change on the critical path while the flag is
 * off — the whole module is dormant code. Turning it on is the only thing that
 * activates any of it.
 *
 * WHY A SHARED PARSER (not scattered `process.env` reads)
 * ------------------------------------------------------
 * A single `isSupervisorEnabled()` keeps the on/off semantics identical at every
 * call site (bridge, supervisor, liveness) so the no-op guarantee cannot drift
 * between them. Accepts the same '1'/'true' truthy convention as the existing
 * ENABLE_ULTRACODE_WORKFLOWS / WORKFLOW_RECONCILE flags for consistency.
 */

import path from 'node:path';
import os from 'node:os';

/** Truthy values that turn a flag ON, matching the repo's existing convention. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Master gate for the whole workflow-supervisor feature. OFF by default: when
 * this returns false every code path in the module is a no-op (see file header).
 * Read live (not cached) so a test can flip the env between cases.
 */
export function isSupervisorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WORKFLOW_SUPERVISOR;
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Per-user cap on concurrently running workflow scopes (ADR-053 §ج-4). A launch
 * intent that would exceed this is rejected/queued rather than launched, so a
 * user cannot exhaust host memory with unbounded parallel `claude -p` scopes.
 * Overridable via WORKFLOW_SUPERVISOR_MAX_PER_USER; defaults to a conservative 3.
 */
export function maxConcurrentPerUser(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_MAX_PER_USER ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

/**
 * Root of the control-file tree the chat bridge writes intents into and the
 * supervisor reads them from. Mirrors the runner-bridge's file-only contract
 * (ADR-RUNNER-BRIDGE-001): the two processes share ONLY these files, never a
 * socket or DB handle. Overridable via WORKFLOW_SUPERVISOR_STATE_DIR for tests.
 *
 * Layout:
 *   <root>/intents/<userId>/<wfLaunchId>.json   — chat writes, supervisor reads
 *   <root>/scopes/<wfLaunchId>/supervisor.json  — supervisor writes, UI reads
 *   <root>/scopes/<wfLaunchId>/pause            — stop control file
 */
export function supervisorStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.WORKFLOW_SUPERVISOR_STATE_DIR ||
    path.join(os.homedir(), '.local', 'share', 'nassaj-dev', 'workflow-supervisor')
  );
}

export function intentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'intents');
}

export function scopesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'scopes');
}

/** Per-user intent directory: <root>/intents/<userId>. */
export function userIntentDir(userId: number, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(intentsDir(env), String(userId));
}

/** Per-scope state directory: <root>/scopes/<wfLaunchId>. */
export function scopeStateDir(wfLaunchId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(scopesDir(env), wfLaunchId);
}

/**
 * The systemd UNIT name for a launch id. Kept in one place so the bridge,
 * supervisor, liveness source, and force-stop all agree on the exact name.
 *
 * TRANSIENT SERVICE, NOT --scope (correctness fix over the ADR's illustrative
 * `--scope`): `systemd-run --user --scope -- cmd` BLOCKS the launcher until the
 * command finishes, which would (a) serialize the supervisor's poll loop behind
 * one long workflow, (b) defeat the per-user concurrency cap, and (c) force
 * supervisor.json to be written on COMPLETION instead of at the moment of launch
 * (violating fito T-241). A transient `--unit=wf-*.service` returns immediately,
 * is owned by the user systemd manager, and OUTLIVES the launcher — which is the
 * exact B-103 survival guarantee. Hence the `.service` suffix.
 */
export function scopeUnitName(wfLaunchId: string): string {
  return `wf-${wfLaunchId}.service`;
}
