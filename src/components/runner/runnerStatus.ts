/**
 * Derive the user-facing runner UI state from the v2 checkpoint/supervisor data,
 * with null-safe defaults. Pure, shared by the control bar and the per-task
 * dots so both agree on color + label. Mirrors ADR-RUNNER-BRIDGE-001.
 *
 * v2 mapping:
 *  - stage  → checkpoint.pointer.stage   (string "0"–"9" or named stage)
 *  - liveness → supervisor.session.heartbeat + exit_reason
 *  - blocked → checkpoint.blocked (non-empty = some tasks blocked)
 *
 * Stage semantics (§3 of minwal-v2-design.md, steps 0–9):
 *   0 = init/read, 1 = recon, 2 = plan-gate, 3 = build, 4 = verify,
 *   5 = critique×3, 6 = fix, 7 = commit+board, 8 = checkpoint, 9 = exit
 */
import type { RunnerStatus } from './useRunner';

export type RunnerUiState =
  | 'idle'
  | 'building'
  | 'verifying'
  | 'running'
  | 'interrupted'
  | 'failed'
  | 'blocked'
  | 'awaiting_approval'
  | 'disabled';

// v2 numeric stages (as strings) that map to build vs. verify UI states.
const BUILD_STAGE_NUMS = new Set(['1', '2', '3', '6', '7', '8']);   // recon / gate / build / fix / commit / checkpoint
const VERIFY_STAGE_NUMS = new Set(['4', '5']);                        // verify / critique×3
// Named stages (backward compat + coordinator may use names in stage field)
const BUILD_STAGES = new Set(['phase', 'build', 'fix', 'review', 'recon', 'plan']);
const VERIFY_STAGES = new Set(['critique', 'verify', 'verdict', 'gate']);

/**
 * Extract a normalised string stage from checkpoint.pointer.stage.
 * The coordinator writes stage as "0"–"9" (step index) or as a named string.
 */
function extractStage(runner: RunnerStatus): string {
  const raw = runner.checkpoint?.pointer?.stage;
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

/**
 * Derive a synthetic "running/idle/failed" status from supervisor liveness.
 * We have no explicit status field in v2 — we infer:
 *   - exit_reason non-null → interrupted or failed
 *   - heartbeat recent (< 20 min) → running
 *   - no supervisor data → idle
 */
function deriveLivenessStatus(runner: RunnerStatus): 'running' | 'idle' | 'interrupted' | 'failed' {
  const session = runner.supervisor?.session;
  if (!session) return 'idle';

  const exitReason = session.exit_reason;
  if (exitReason) {
    // Treat error/crash exits as failed; clean exits (null) as idle.
    return exitReason === 'error' || exitReason === 'crash' ? 'failed' : 'interrupted';
  }

  // Heartbeat freshness: > 20 min stale = not running.
  const heartbeat = session.heartbeat;
  if (!heartbeat) return 'idle';
  const ageSec = (Date.now() - new Date(heartbeat).getTime()) / 1000;
  return ageSec < 1200 ? 'running' : 'idle';
}

export function deriveRunnerUiState(runner: RunnerStatus | null): RunnerUiState {
  if (!runner || !runner.registered) {
    return 'idle';
  }
  if (runner.enabled === false) {
    return 'disabled';
  }
  if (runner.paused) {
    return 'blocked';
  }

  const stage = extractStage(runner);
  const status = deriveLivenessStatus(runner);

  if (stage === 'awaiting_approval') {
    return 'awaiting_approval';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'interrupted') {
    return 'interrupted';
  }
  if (status === 'running') {
    if (VERIFY_STAGES.has(stage) || VERIFY_STAGE_NUMS.has(stage)) {
      return 'verifying';
    }
    if (BUILD_STAGES.has(stage) || BUILD_STAGE_NUMS.has(stage)) {
      return 'building';
    }
    return 'running';
  }
  return 'idle';
}

/** Tailwind classes for the status pill, keyed by derived UI state. */
export const UI_STATE_STYLES: Record<RunnerUiState, string> = {
  idle: 'bg-muted text-muted-foreground border-border',
  building: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  verifying: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30',
  running: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  interrupted: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30',
  failed: 'bg-destructive/10 text-destructive border-destructive/30',
  blocked: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  awaiting_approval: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  disabled: 'bg-muted text-muted-foreground/70 border-border',
};

/** True when the state should pulse (active work). */
export function isPulsing(state: RunnerUiState): boolean {
  return state === 'building' || state === 'verifying' || state === 'running';
}
