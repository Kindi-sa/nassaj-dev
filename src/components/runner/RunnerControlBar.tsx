import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Ban,
  Bot,
  CheckCheck,
  Gauge,
  Inbox,
  Pause,
  Play,
  Square,
} from 'lucide-react';

import { cn } from '../../lib/utils';

import type { RunnerAction, RunnerStatus } from './useRunner';
import {
  UI_STATE_STYLES,
  deriveRunnerUiState,
  isPulsing,
  type RunnerUiState,
} from './runnerStatus';

/**
 * The slice of useRunner's return value the bar consumes. The hook is lifted to
 * ProjectBoardPanel and lives once per project (see finding: double useRunner) —
 * this bar is a pure presentational consumer of that single instance.
 */
export type RunnerControlBarProps = {
  runner: RunnerStatus | null;
  registered: boolean;
  actionPending: RunnerAction | null;
  start: () => Promise<{ ok: boolean; status?: number }>;
  stop: () => Promise<{ ok: boolean; status?: number }>;
  pause: () => Promise<{ ok: boolean; status?: number }>;
  resume: () => Promise<{ ok: boolean; status?: number }>;
  approve: () => Promise<{ ok: boolean; status?: number }>;
};

/**
 * RunnerControlBar — live control strip injected on the Project Board header,
 * right-aligned next to the section PillBar (ProjectBoardPanel.tsx). Renders
 * NOTHING when the project is not registered with the runner, so the board is
 * byte-for-byte unchanged for projects with no runner.
 *
 * Status pill (status + stage + cycle, color-coded) + Start/Pause/Resume/
 * Approve/Stop buttons wired to the bridge POST endpoints. Approve is enabled
 * only when stage = awaiting_approval. Shows model, quota threshold and last
 * verdict / last error inline. ADR-RUNNER-BRIDGE-001.
 *
 * No terminal: every control is a button. Multi-project: the bar appears
 * automatically for any project whose path matches a runner registry entry.
 */
export default function RunnerControlBar({
  runner,
  registered,
  actionPending,
  start,
  stop,
  pause,
  resume,
  approve,
}: RunnerControlBarProps) {
  const { t } = useTranslation('projectBoard');
  const [flash, setFlash] = useState<string | null>(null);

  // Additive overlay: nothing to show when the runner does not target this project.
  if (!registered || !runner) {
    return null;
  }

  const uiState: RunnerUiState = deriveRunnerUiState(runner);
  const pulse = isPulsing(uiState);
  // v2: stage and cycle come from checkpoint.pointer
  const stage = runner.checkpoint?.pointer?.stage != null
    ? String(runner.checkpoint.pointer.stage)
    : null;
  const cycle = runner.checkpoint?.pointer?.cycle ?? null;
  const isAwaiting = uiState === 'awaiting_approval';
  const isPaused = runner.paused;
  const isEnabled = runner.enabled !== false;
  const model = runner.config?.model ?? null;
  const threshold = runner.config?.threshold ?? null;
  // v2: no last_error in checkpoint; show exit_reason from supervisor instead
  const lastError = runner.supervisor?.session?.exit_reason ?? null;
  // v2: no critique-verdict.json — blocked tasks surfaced instead
  const blockedCount = Object.keys(runner.checkpoint?.blocked ?? {}).length;
  const pendingCount = runner.pendingApprovals?.length ?? 0;
  // v2: cycle stats from supervisor
  const totalCycles = runner.supervisor?.cycle_stats?.total_cycles ?? null;
  const tokensThisSession = runner.supervisor?.cycle_stats?.tokens_this_session ?? null;

  const shortName = t('runner.label');
  const fullName = t('runner.fullName');
  const statusLabel = t(`runner.status.${uiState}`, { defaultValue: uiState });
  const stageLabel = stage
    ? t(`runner.stages.${stage}`, { defaultValue: stage })
    : null;

  const runResult = async (action: RunnerAction, fn: () => Promise<{ ok: boolean; status?: number }>) => {
    const result = await fn();
    if (!result.ok) {
      const key = result.status === 409 ? 'runner.errors.notAwaiting' : 'runner.errors.generic';
      setFlash(t(key));
      setTimeout(() => setFlash(null), 3000);
    }
  };

  const busy = actionPending !== null;

  const btn =
    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="flex flex-wrap items-center gap-2" dir="rtl">
      {/* Status pill */}
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
          UI_STATE_STYLES[uiState],
        )}
        title={lastError ?? fullName}
        aria-label={fullName}
      >
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full bg-current',
            pulse && 'animate-pulse',
          )}
        />
        <Bot className="h-3 w-3" />
        <span className="font-semibold">{shortName}</span>
        <span className="opacity-50">·</span>
        <span>{statusLabel}</span>
        {stageLabel && uiState !== 'idle' && uiState !== 'awaiting_approval' && (
          <span className="opacity-80">· {stageLabel}</span>
        )}
        {cycle !== null && <span className="opacity-70">· {t('runner.cycle', { n: cycle })}</span>}
      </span>

      {/* Pending approvals counter (Phase ب) — amber "awaiting your review",
          shown only when the auto-mode runner logged sensitive actions. */}
      {pendingCount > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
          title={t('approvals.awaitingReview')}
          aria-label={t('approvals.awaitingReview')}
        >
          <Inbox className="h-3 w-3" />
          <span className="tabular-nums">{pendingCount}</span>
          <span>{t('approvals.awaitingReview')}</span>
        </span>
      )}

      {/* Model + quota badges */}
      {model && (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <Bot className="h-3 w-3" />
          <span dir="ltr" className="font-mono">{model}</span>
        </span>
      )}
      {threshold !== null && (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <Gauge className="h-3 w-3" />
          <span className="tabular-nums">{threshold}%</span>
        </span>
      )}

      {/* v2: blocked tasks badge */}
      {blockedCount > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[10px] text-orange-600 dark:text-orange-400"
          title={t('runner.blockedTasks', { defaultValue: 'Blocked tasks' })}
        >
          <CheckCheck className="h-3 w-3" />
          <span className="tabular-nums">{blockedCount}</span>
          <span>{t('runner.blocked', { defaultValue: 'blocked' })}</span>
        </span>
      )}

      {/* v2: total cycles + session tokens from supervisor */}
      {totalCycles !== null && (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <span>{t('runner.totalCycles', { n: totalCycles, defaultValue: `${totalCycles} cycles` })}</span>
        </span>
      )}
      {tokensThisSession !== null && tokensThisSession > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" dir="ltr">
          <span className="tabular-nums">{tokensThisSession.toLocaleString()}</span>
          <span>{t('runner.tokens', { defaultValue: 'tok' })}</span>
        </span>
      )}

      {/* Controls */}
      <div className="flex items-center gap-1.5">
        {/* Start: enable when disabled */}
        {!isEnabled && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runResult('start', start)}
            className={cn(btn, 'border-green-500/40 text-green-600 hover:bg-green-500/10 dark:text-green-400')}
          >
            <Play className="h-3 w-3" />
            <span>{t('runner.actions.start')}</span>
          </button>
        )}

        {/* Pause / Resume toggle (only meaningful while enabled) */}
        {isEnabled && !isPaused && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runResult('pause', pause)}
            className={cn(btn, 'border-orange-500/40 text-orange-600 hover:bg-orange-500/10 dark:text-orange-400')}
          >
            <Pause className="h-3 w-3" />
            <span>{t('runner.actions.pause')}</span>
          </button>
        )}
        {isEnabled && isPaused && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runResult('resume', resume)}
            className={cn(btn, 'border-green-500/40 text-green-600 hover:bg-green-500/10 dark:text-green-400')}
          >
            <Activity className="h-3 w-3" />
            <span>{t('runner.actions.resume')}</span>
          </button>
        )}

        {/* Approve next phase — only when awaiting */}
        <button
          type="button"
          disabled={busy || !isAwaiting}
          onClick={() => void runResult('approve', approve)}
          className={cn(btn, 'border-blue-500/40 text-blue-600 hover:bg-blue-500/10 dark:text-blue-400')}
        >
          <CheckCheck className="h-3 w-3" />
          <span>{t('runner.actions.approve')}</span>
        </button>

        {/* Stop: hard-disable when enabled */}
        {isEnabled && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runResult('stop', stop)}
            className={cn(btn, 'border-destructive/40 text-destructive hover:bg-destructive/10')}
          >
            <Square className="h-3 w-3" />
            <span>{t('runner.actions.stop')}</span>
          </button>
        )}
      </div>

      {flash && (
        <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
          <Ban className="h-3 w-3" />
          {flash}
        </span>
      )}
    </div>
  );
}
