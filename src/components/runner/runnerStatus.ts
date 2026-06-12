/**
 * Derive the user-facing runner UI state from the runner's (status, stage),
 * with null-safe defaults. Pure, shared by the control bar and the per-task
 * dots so both agree on color + label. Mirrors ADR-RUNNER-BRIDGE-001:
 * awaiting_approval is a stage carried with status=idle, surfaced as its own
 * UI state.
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

// Stage groupings cover both the legacy (review/fix/critique/phase) and the
// current (build/verify/gate) runner stage vocabularies.
const BUILD_STAGES = new Set(['phase', 'build', 'fix', 'review']);
const VERIFY_STAGES = new Set(['critique', 'verify', 'gate']);

export function deriveRunnerUiState(runner: RunnerStatus | null): RunnerUiState {
  if (!runner || !runner.registered) {
    return 'idle';
  }
  if (runner.enabled === false) {
    return 'disabled';
  }

  const stage = runner.cycle?.stage ?? '';
  const status = runner.cycle?.status ?? 'idle';

  if (stage === 'awaiting_approval') {
    return 'awaiting_approval';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'interrupted') {
    return 'interrupted';
  }
  if (runner.paused) {
    return 'blocked';
  }
  if (status === 'running') {
    if (VERIFY_STAGES.has(stage)) {
      return 'verifying';
    }
    if (BUILD_STAGES.has(stage)) {
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
