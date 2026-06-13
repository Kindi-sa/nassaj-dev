/**
 * RunnerJourney — «مسار المِنوال عبر المراحل»
 * ==============================================
 *
 * Vertical timeline overlaying the runner's cycle history on top of the
 * project's phase list. Shows the owner at a glance:
 *   «Which phase is the runner in now, how many cycles finished, what is next?»
 *
 * Design brief: docs/design/minwal-journey-brief.md
 * Data contract: runner-bridge.service.ts → RunnerStatus.history (CycleHistory)
 * ADR-RUNNER-BRIDGE-001: read-only. Never writes runner files.
 *
 * Additive: renders null unless `registered && history != null`.
 * The board is byte-for-byte unchanged for projects with no runner.
 *
 * RTL-first: logical properties (border-s, ps, -start-*) throughout.
 * a11y: color is never the sole signal; aria-live on the live indicator;
 *       animate-pulse wrapped in motion-safe:.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Bot,
  CheckCircle2,
  Circle,
  CircleDot,
  Pause,
  XCircle,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import type { BoardPhase } from '../project-board/types';

import type { CycleHistory, CycleRecord, CycleStageResult } from './useRunner';
import { UI_STATE_STYLES } from './runnerStatus';

// ─── constants ───────────────────────────────────────────────────────────────

/** After this many seconds without a heartbeat we consider the runner stale. */
const STALE_THRESHOLD_S = 180; // 3 × typical 60s tick

/** Chips beyond this count are hidden behind a "show all" toggle. */
const MAX_VISIBLE_CHIPS = 20;

// ─── types ───────────────────────────────────────────────────────────────────

export type RunnerJourneyProps = {
  /** Board phases from docs/project-state.json (same source as PhaseTimeline). */
  phases: BoardPhase[];
  /**
   * Cycle journey log. null → section is hidden entirely (project not yet
   * registered / file absent). Passed from useRunner via ProjectBoardPanel.
   */
  history: CycleHistory | null;
  /** True when the runner is registered with this project (guard). */
  registered: boolean;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Seconds since a timestamp string. Returns Infinity on bad input. */
function secondsSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  return isFinite(diff) ? diff : Infinity;
}

/** True if heartbeat is stale (runner might be frozen). */
function isHeartbeatStale(heartbeatAt: string | null | undefined): boolean {
  return secondsSince(heartbeatAt) > STALE_THRESHOLD_S;
}

/** Tailwind classes for a cycle/stage status token. */
function cycleStatusClasses(status: string | undefined): string {
  switch (status) {
    case 'succeeded':
    case 'ok':
    case 'clean':
      return 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400';
    case 'failed':
    case 'unclean':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'interrupted':
      return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400';
    case 'running':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'awaiting':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400';
    case 'skipped':
    case 'pending':
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

/** Icon for a cycle status. Accompanies the color so color is not the sole signal. */
function CycleStatusIcon({ status, className }: { status: string | undefined; className?: string }) {
  const cls = cn('h-3 w-3 flex-shrink-0', className);
  switch (status) {
    case 'succeeded':
    case 'ok':
    case 'clean':
      return <CheckCircle2 className={cls} />;
    case 'failed':
    case 'unclean':
      return <XCircle className={cls} />;
    case 'interrupted':
      return <Pause className={cls} />;
    case 'running':
      return <Activity className={cls} />;
    default:
      return <Circle className={cls} />;
  }
}

// ─── sub-components ──────────────────────────────────────────────────────────

/**
 * Four stage dots: build → verify → verdict → gate.
 * Each dot is aria-hidden (decorative); the parent card carries the full label.
 */
function StageDots({
  stages,
  currentStage,
  isCurrentCycle,
}: {
  stages: CycleRecord['stages'] | undefined;
  currentStage: string | undefined;
  isCurrentCycle: boolean;
}) {
  const { t } = useTranslation('projectBoard');
  const STAGE_KEYS = ['build', 'verify', 'verdict', 'gate'] as const;

  return (
    <div className="mt-2 flex items-center gap-2" role="list" aria-label={t('runner.journey.phasesLabel')}>
      {STAGE_KEYS.map((key) => {
        const result: CycleStageResult | undefined = stages?.[key];
        const isActive = isCurrentCycle && currentStage === key;
        const status = result?.status ?? (isActive ? 'running' : 'pending');
        const label = t(`runner.journey.stage.${key}`);
        const modelLabel = result?.model ? ` · ${result.model}` : '';

        return (
          <div
            key={key}
            role="listitem"
            className="flex items-center gap-1"
            title={`${label}${modelLabel}`}
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-2 w-2 rounded-full border',
                cycleStatusClasses(status),
                isActive && 'motion-safe:animate-pulse',
              )}
            />
            <span className="text-[10px] text-muted-foreground">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Compact chip for a single closed cycle (used in the mini-chip grid). */
function CycleChip({
  cycle,
  isCurrentCycle,
  onClick,
}: {
  cycle: CycleRecord;
  isCurrentCycle: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation('projectBoard');
  const n = cycle.cycle ?? '?';
  const status = cycle.status ?? 'pending';
  const label = t('runner.journey.cycleN', { n }) + ' · ' + (cycle.task_id ?? cycle.phase_id ?? '');

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'h-4 w-4 rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70',
        cycleStatusClasses(status),
        isCurrentCycle && 'ring-2 ring-primary/50',
      )}
    />
  );
}

/** Full expanded card for a single cycle. */
function CycleCard({
  cycle,
  isCurrentCycle,
  currentStage,
  isStale,
}: {
  cycle: CycleRecord;
  isCurrentCycle: boolean;
  currentStage?: string;
  isStale?: boolean;
}) {
  const { t } = useTranslation('projectBoard');
  const n = cycle.cycle ?? '?';
  const status = cycle.status ?? (isCurrentCycle ? 'running' : 'pending');
  const taskId = cycle.task_id;
  const taskTitle = cycle.task_title;

  return (
    <div
      className={cn(
        'rounded-lg border p-2.5',
        isCurrentCycle
          ? 'border-primary/30 bg-primary/5'
          : 'border-border/60 bg-card',
      )}
      aria-label={t('runner.journey.cycleN', { n }) + (taskId ? ` · ${taskId}` : '')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Cycle number */}
        <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">
          {t('runner.journey.cycleN', { n })}
        </span>

        {/* Task or phase ref */}
        {taskId && (
          <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">
            {taskId}
          </span>
        )}
        {taskTitle && (
          <span className="text-xs text-foreground">{taskTitle}</span>
        )}

        {/* Status badge */}
        <span
          className={cn(
            'ms-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
            cycleStatusClasses(status),
          )}
        >
          <CycleStatusIcon status={status} />
          {isCurrentCycle
            ? t(`runner.status.${status}`, { defaultValue: status })
            : t(`runner.journey.cycleStatus.${status}`, { defaultValue: status })}
        </span>

        {/* «هنا» indicator for current cycle */}
        {isCurrentCycle && (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse"
            />
            {t('runner.journey.here')}
          </span>
        )}
      </div>

      {/* Stale warning */}
      {isCurrentCycle && isStale && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {t('runner.journey.stale')}
        </p>
      )}

      {/* Stage dots — shown for current cycle always; for closed cycles on expand */}
      {isCurrentCycle && (
        <StageDots
          stages={cycle.stages}
          currentStage={currentStage}
          isCurrentCycle={isCurrentCycle}
        />
      )}
    </div>
  );
}

/** Cycles list for one phase — collapsible, current phase open by default. */
function PhaseCycles({
  phaseId,
  cycles,
  currentCycleRecord,
  isCurrent,
  currentStage,
  isStale,
}: {
  phaseId: string;
  cycles: CycleRecord[];
  currentCycleRecord: CycleRecord | null;
  isCurrent: boolean;
  currentStage?: string;
  isStale?: boolean;
}) {
  const { t } = useTranslation('projectBoard');
  const [expandedCycle, setExpandedCycle] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Merge closed cycles + in-progress current (if not yet in cycles[])
  const allCycles: CycleRecord[] = [...cycles];
  if (currentCycleRecord && isCurrent) {
    const alreadyIn = allCycles.some((c) => c.cycle === currentCycleRecord.cycle);
    if (!alreadyIn) {
      allCycles.push(currentCycleRecord);
    }
  }

  if (!allCycles.length) {
    // No cycles for this phase yet
    if (!isCurrent) return null;
    return (
      <p className="ps-2 text-[11px] text-muted-foreground">
        {t('runner.journey.noCycles')}
      </p>
    );
  }

  const totalCount = allCycles.length;
  const visibleCycles = showAll ? allCycles : allCycles.slice(0, MAX_VISIBLE_CHIPS);

  // For current phase: expand to full cards; for others: mini chip grid
  if (isCurrent) {
    return (
      <div className="mt-2 space-y-2">
        {allCycles.map((cycle) => {
          const isCurrentCycle =
            currentCycleRecord !== null && cycle.cycle === currentCycleRecord.cycle;
          return (
            <CycleCard
              key={cycle.cycle ?? phaseId + String(allCycles.indexOf(cycle))}
              cycle={cycle}
              isCurrentCycle={isCurrentCycle}
              currentStage={isCurrentCycle ? currentStage : undefined}
              isStale={isCurrentCycle ? isStale : undefined}
            />
          );
        })}
      </div>
    );
  }

  // Closed / pending phases: mini chips in a wrap grid
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        {t('runner.journey.cyclesCount', { n: totalCount })}
        &ensp;
        <span className="flex flex-wrap gap-1 pt-1" aria-hidden="true">
          {cycles.slice(0, 5).map((c) => (
            <span
              key={c.cycle}
              className={cn('h-3.5 w-3.5 rounded border', cycleStatusClasses(c.status))}
            />
          ))}
          {cycles.length > 5 && (
            <span className="text-[9px] text-muted-foreground">+{cycles.length - 5}</span>
          )}
        </span>
      </summary>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {visibleCycles.map((cycle) => {
          const isExpanded = expandedCycle === cycle.cycle;
          return (
            <div key={cycle.cycle ?? String(allCycles.indexOf(cycle))} className="w-full">
              <CycleChip
                cycle={cycle}
                isCurrentCycle={false}
                onClick={() =>
                  setExpandedCycle(isExpanded ? null : (cycle.cycle ?? null))
                }
              />
              {isExpanded && (
                <div className="mt-1.5">
                  <CycleCard
                    cycle={cycle}
                    isCurrentCycle={false}
                  />
                </div>
              )}
            </div>
          );
        })}
        {totalCount > MAX_VISIBLE_CHIPS && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[11px] text-muted-foreground underline decoration-border hover:text-foreground"
          >
            {t('runner.journey.showAll', { n: totalCount })}
          </button>
        )}
      </div>
    </details>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

/**
 * RunnerJourney — مسار المِنوال عبر المراحل
 *
 * Placed in BoardOverview, below PhaseTimeline, visible only when
 * `registered && history != null`.
 */
export default function RunnerJourney({ phases, history, registered }: RunnerJourneyProps) {
  const { t } = useTranslation('projectBoard');

  // Guard: additive, never shown unless runner is registered and has history data
  if (!registered || !history) {
    return null;
  }

  const current = history.current;
  const cycles = history.cycles ?? [];
  const totalCycles = history.total_cycles ?? cycles.length;

  // Build a map of phase_id → closed cycles for that phase
  const cyclesByPhase = new Map<string, CycleRecord[]>();
  for (const c of cycles) {
    const pid = c.phase_id ?? '__unknown__';
    if (!cyclesByPhase.has(pid)) cyclesByPhase.set(pid, []);
    cyclesByPhase.get(pid)!.push(c);
  }

  // Current cycle pseudo-record (in-flight, not yet in cycles[])
  const currentCycleRecord: CycleRecord | null = current
    ? {
        cycle: current.cycle,
        phase_id: current.phase_id,
        task_id: current.task_id,
        status: current.status ?? 'running',
        started_at: current.started_at,
        stages: {},
      }
    : null;

  const currentPhaseId = current?.phase_id ?? null;
  const currentStage = current?.stage;
  const currentStatus = current?.status ?? 'idle';
  const heartbeatAt = current?.heartbeat_at;
  const stale = isHeartbeatStale(heartbeatAt);

  // Derive the pill UI state from the current status/stage
  const pillUiState = (() => {
    if (currentStatus === 'failed') return 'failed';
    if (currentStatus === 'interrupted') return 'interrupted';
    if (currentStage === 'awaiting_approval') return 'awaiting_approval';
    if (currentStatus === 'running') {
      if (currentStage === 'build' || currentStage === 'fix' || currentStage === 'phase') return 'building';
      if (currentStage === 'verify' || currentStage === 'verdict' || currentStage === 'gate') return 'verifying';
      return 'running';
    }
    return 'idle';
  })();
  const isLive = pillUiState === 'building' || pillUiState === 'verifying' || pillUiState === 'running';

  return (
    <section dir="rtl" aria-labelledby="runner-journey-heading">
      {/* Section header with live indicator */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 id="runner-journey-heading" className="text-sm font-semibold text-foreground">
          {t('runner.journey.title')}
        </h3>

        {/* Live «المِنوال هنا» pill — layer 1 of 3 */}
        {current && (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
              UI_STATE_STYLES[pillUiState],
            )}
            aria-live="polite"
            aria-atomic="true"
            aria-label={t('runner.journey.here') + ' · ' + t('runner.journey.cycleN', { n: current.cycle ?? '?' })}
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full bg-current',
                isLive && !stale && 'motion-safe:animate-pulse',
              )}
            />
            <Bot className="h-3 w-3" aria-hidden="true" />
            <span>{t('runner.journey.here')}</span>
            <span className="opacity-50" aria-hidden="true">·</span>
            <span>{t('runner.journey.cycleN', { n: current.cycle ?? '?' })}</span>
            {stale && (
              <span className="ms-1 opacity-60">({t('runner.journey.stale')})</span>
            )}
          </span>
        )}

        {/* Total cycles count badge */}
        {totalCycles > 0 && (
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t('runner.journey.cyclesCount', { n: totalCycles })}
          </span>
        )}
      </div>

      {/* Vertical timeline — mirrors PhaseTimeline's exact markup */}
      {phases.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('runner.journey.noCycles')}</p>
      ) : (
        <ol className="relative space-y-0 border-s-2 border-border ps-5">
          {phases.map((phase) => {
            const isCurrent = phase.status === 'current';
            const isRunnerHere = phase.id === currentPhaseId;
            const phaseCycles = cyclesByPhase.get(phase.id) ?? [];
            const progress = Math.max(0, Math.min(100, Number(phase.progress) || 0));

            return (
              <li key={phase.id} className="relative pb-5 last:pb-0">
                {/* Phase node — mirrors PhaseTimeline icons exactly */}
                <span
                  className={cn(
                    'absolute -start-[1.65rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 bg-background',
                    phase.status === 'done' && 'border-green-500 text-green-500',
                    isCurrent && 'border-primary text-primary',
                    isRunnerHere && isCurrent && 'motion-safe:animate-pulse',
                    (phase.status === 'pending' || phase.status === 'cancelled') &&
                      'border-border text-muted-foreground',
                  )}
                  aria-hidden="true"
                >
                  {phase.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5" />}
                  {isCurrent && <CircleDot className="h-3.5 w-3.5" />}
                  {phase.status === 'pending' && <Circle className="h-3 w-3" />}
                  {phase.status === 'cancelled' && <XCircle className="h-3.5 w-3.5" />}
                </span>

                {/* Phase header row */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                    {phase.id}
                  </span>
                  <span
                    className={cn(
                      'text-sm font-medium',
                      phase.status === 'cancelled'
                        ? 'text-muted-foreground line-through'
                        : 'text-foreground',
                    )}
                  >
                    {phase.title}
                  </span>

                  {/* «المِنوال هنا» on phase node — layer 2 of 3 */}
                  {isRunnerHere && current && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                        UI_STATE_STYLES[pillUiState],
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'inline-block h-1.5 w-1.5 rounded-full bg-current',
                          isLive && !stale && 'motion-safe:animate-pulse',
                        )}
                      />
                      {t('runner.journey.here')}
                    </span>
                  )}
                </div>

                {/* Progress bar (only for non-cancelled phases) */}
                {phase.status !== 'cancelled' && (
                  <div className="mt-2 flex max-w-md items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          phase.status === 'done' ? 'bg-green-500' : 'bg-primary',
                        )}
                        style={{ width: `${phase.status === 'done' ? 100 : progress}%` }}
                      />
                    </div>
                    <span className="w-9 text-end text-[11px] tabular-nums text-muted-foreground">
                      {phase.status === 'done' ? 100 : progress}%
                    </span>
                  </div>
                )}

                {/* Cycles for this phase */}
                <div className="mt-2">
                  <PhaseCycles
                    phaseId={phase.id}
                    cycles={phaseCycles}
                    currentCycleRecord={isRunnerHere ? currentCycleRecord : null}
                    isCurrent={isRunnerHere}
                    currentStage={isRunnerHere ? currentStage : undefined}
                    isStale={isRunnerHere ? stale : undefined}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Empty state: registered but no cycles started */}
      {cycles.length === 0 && !current && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t('runner.journey.noCycles')}
        </p>
      )}
    </section>
  );
}
