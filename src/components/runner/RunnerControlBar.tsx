import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Ban,
  Bot,
  CheckCheck,
  Gauge,
  Pause,
  Play,
  Square,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { useRunner, type RunnerAction } from './useRunner';
import {
  UI_STATE_STYLES,
  deriveRunnerUiState,
  isPulsing,
  type RunnerUiState,
} from './runnerStatus';

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
export default function RunnerControlBar({ projectId }: { projectId: string | null | undefined }) {
  const { t } = useTranslation('projectBoard');
  const { runner, registered, actionPending, start, stop, pause, resume, approve } =
    useRunner(projectId);
  const [flash, setFlash] = useState<string | null>(null);

  // Additive overlay: nothing to show when the runner does not target this project.
  if (!registered || !runner) {
    return null;
  }

  const uiState: RunnerUiState = deriveRunnerUiState(runner);
  const pulse = isPulsing(uiState);
  const stage = runner.cycle?.stage ?? null;
  const cycle = runner.cycle?.cycle ?? null;
  const isAwaiting = uiState === 'awaiting_approval';
  const isPaused = runner.paused;
  const isEnabled = runner.enabled !== false;
  const model = runner.config?.model ?? null;
  const threshold = runner.config?.threshold ?? null;
  const lastError = runner.cycle?.last_error || null;
  const verdict = runner.verdict;

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
        title={lastError ?? undefined}
      >
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full bg-current',
            pulse && 'animate-pulse',
          )}
        />
        <Bot className="h-3 w-3" />
        <span>{statusLabel}</span>
        {stageLabel && uiState !== 'idle' && uiState !== 'awaiting_approval' && (
          <span className="opacity-80">· {stageLabel}</span>
        )}
        {cycle !== null && <span className="opacity-70">· {t('runner.cycle', { n: cycle })}</span>}
      </span>

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

      {/* Last verdict */}
      {verdict && typeof verdict.clean === 'boolean' && (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]',
            verdict.clean
              ? 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
          )}
          title={verdict.notes ?? undefined}
        >
          <CheckCheck className="h-3 w-3" />
          <span>{verdict.clean ? t('runner.clean') : t('runner.unclean')}</span>
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
