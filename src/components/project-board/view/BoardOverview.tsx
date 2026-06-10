import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  Wrench,
  XCircle,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import type {
  BoardDecision,
  BoardIssue,
  BoardSprint,
  BoardTask,
  IssueSeverity,
  ProjectBoardState,
  TaskKind,
  TaskStatus,
} from '../types';

type BoardOverviewProps = {
  state: ProjectBoardState;
};

const SEVERITY_STYLES: Record<IssueSeverity, string> = {
  low: 'bg-muted text-muted-foreground border-border',
  medium: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  critical: 'bg-destructive/10 text-destructive border-destructive/30',
};

const KIND_STYLES: Record<TaskKind, string> = {
  feature: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  bug: 'bg-destructive/10 text-destructive border-destructive/30',
  chore: 'bg-muted text-muted-foreground border-border',
  spike: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
};

const TASK_COLUMNS: TaskStatus[] = ['open', 'in_progress', 'done'];

/** DOM anchor for an issue row, target of the bug-task → issue visual link. */
function issueAnchorId(issueId: string): string {
  return `board-issue-${issueId}`;
}

/** Completion stats of the tasks assigned to one sprint. */
function sprintTaskStats(state: ProjectBoardState, sprintId: string) {
  const sprintTasks = (state.tasks ?? []).filter((task) => task.sprint === sprintId);
  const done = sprintTasks.filter((task) => task.status === 'done').length;
  const total = sprintTasks.length;
  return { done, total, progress: total ? Math.round((done / total) * 100) : 0 };
}

function PhaseTimeline({ state }: { state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');

  if (!state.phases?.length) {
    return null;
  }

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('phases.title')}</h3>
      <ol className="relative space-y-0 border-s-2 border-border ps-5">
        {state.phases.map((phase) => {
          const isCurrent = phase.status === 'current';
          const progress = Math.max(0, Math.min(100, Number(phase.progress) || 0));

          return (
            <li key={phase.id} className="relative pb-5 last:pb-0">
              <span
                className={cn(
                  'absolute -start-[1.65rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 bg-background',
                  phase.status === 'done' && 'border-green-500 text-green-500',
                  isCurrent && 'border-primary text-primary',
                  phase.status === 'pending' && 'border-border text-muted-foreground',
                  phase.status === 'cancelled' && 'border-border text-muted-foreground',
                )}
              >
                {phase.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5" />}
                {isCurrent && <CircleDot className="h-3.5 w-3.5" />}
                {phase.status === 'pending' && <Circle className="h-3 w-3" />}
                {phase.status === 'cancelled' && <XCircle className="h-3.5 w-3.5" />}
              </span>

              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{phase.id}</span>
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
                {isCurrent && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {t('phases.current')}
                  </span>
                )}
              </div>

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
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Highlighted bar for the single sprint with status="current" (schema 1.1). */
function CurrentSprintBar({ state }: { state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');
  const sprint = (state.sprints ?? []).find((entry) => entry.status === 'current');

  if (!sprint) {
    return null;
  }

  const phase = (state.phases ?? []).find((entry) => entry.id === sprint.phase);
  const { done, total, progress } = sprintTaskStats(state, sprint.id);

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {t('sprint.current')}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{sprint.id}</span>
        <span className="text-sm font-medium text-foreground">{sprint.goal}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{sprint.phase}</span>
        {phase && <span>{phase.title}</span>}
        {sprint.started && <span>{t('sprint.started', { date: sprint.started })}</span>}
        <span className="tabular-nums">{t('sprint.taskCount', { done, total })}</span>
        <span className="flex min-w-32 flex-1 items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </span>
          <span className="w-9 text-end tabular-nums">{progress}%</span>
        </span>
      </div>
    </div>
  );
}

/** Collapsed secondary list of planned/done sprints. */
function OtherSprintRow({ sprint, state }: { sprint: BoardSprint; state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');
  const { done, total } = sprintTaskStats(state, sprint.id);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2">
      <span className="font-mono text-[10px] text-muted-foreground">{sprint.id}</span>
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-[10px] font-medium',
          sprint.status === 'done'
            ? 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400'
            : 'bg-muted text-muted-foreground border-border',
        )}
      >
        {t(`sprint.status.${sprint.status}`, { defaultValue: sprint.status })}
      </span>
      <span className="text-xs text-foreground">{sprint.goal}</span>
      <span className="ms-auto flex items-center gap-3 text-[10px] tabular-nums text-muted-foreground">
        <span className="font-mono">{sprint.phase}</span>
        {sprint.ended && <span>{t('sprint.ended', { date: sprint.ended })}</span>}
        <span>{t('sprint.taskCount', { done, total })}</span>
      </span>
    </div>
  );
}

function SprintsSection({ state }: { state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');
  const sprints = state.sprints ?? [];
  const others = sprints.filter((sprint) => sprint.status !== 'current');

  // v1 file (no sprints array) → render nothing, board looks exactly as before.
  if (!sprints.length) {
    return null;
  }

  return (
    <section className="space-y-2">
      <CurrentSprintBar state={state} />
      {others.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            {t('sprint.others', { count: others.length })}
          </summary>
          <div className="mt-2 space-y-2">
            {others.map((sprint) => (
              <OtherSprintRow key={sprint.id} sprint={sprint} state={state} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

type TaskCardProps = {
  task: BoardTask;
  currentSprintId: string | null;
  onIssueClick: (issueId: string) => void;
};

function TaskCard({ task, currentSprintId, onIssueClick }: TaskCardProps) {
  const { t } = useTranslation('projectBoard');
  const kindStyle = task.kind ? KIND_STYLES[task.kind] : null;

  return (
    <div className="rounded-lg border border-border/60 bg-card p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className={cn('text-xs text-foreground', task.status === 'done' && 'text-muted-foreground')}>
          {task.title}
        </p>
        <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground">{task.id}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        {kindStyle && (
          <span className={cn('rounded-full border px-1.5 py-0.5 font-medium', kindStyle)}>
            {t(`tasksSection.kind.${task.kind}`, { defaultValue: task.kind })}
          </span>
        )}
        {task.issue && (
          <button
            type="button"
            onClick={() => onIssueClick(task.issue as string)}
            title={t('tasksSection.issueLink', { id: task.issue })}
            aria-label={t('tasksSection.issueLink', { id: task.issue })}
            className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            <Bug className="h-2.5 w-2.5" />
            {task.issue}
          </button>
        )}
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{task.phase}</span>
        {task.sprint && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 font-mono',
              task.sprint === currentSprintId ? 'bg-primary/10 text-primary' : 'bg-muted',
            )}
          >
            {task.sprint}
          </span>
        )}
        {task.owner && <span>{task.owner}</span>}
        {task.closed && <span>{task.closed}</span>}
      </div>
    </div>
  );
}

/**
 * Sort weight inside a column: current-sprint tasks first, then tasks
 * scheduled in other sprints, then backlog (no sprint). With no current
 * sprint (v1 files) every task weighs the same and the order is unchanged.
 */
function taskSprintWeight(task: BoardTask, currentSprintId: string | null): number {
  if (currentSprintId && task.sprint === currentSprintId) return 0;
  return task.sprint ? 1 : 2;
}

function TasksBoard({
  state,
  onIssueClick,
}: {
  state: ProjectBoardState;
  onIssueClick: (issueId: string) => void;
}) {
  const { t } = useTranslation('projectBoard');
  const tasks = state.tasks ?? [];
  const currentSprintId =
    (state.sprints ?? []).find((sprint) => sprint.status === 'current')?.id ?? null;

  if (!tasks.length) {
    return null;
  }

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('tasksSection.title')}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {TASK_COLUMNS.map((column) => {
          const columnTasks = tasks
            .filter((task) => task.status === column)
            .sort(
              (a, b) => taskSprintWeight(a, currentSprintId) - taskSprintWeight(b, currentSprintId),
            );

          return (
            <div key={column} className="rounded-xl border border-border/60 bg-muted/30 p-2.5">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-foreground">
                  {t(`tasksSection.${column}`)}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {columnTasks.length}
                </span>
              </div>
              <div className="space-y-2">
                {columnTasks.length ? (
                  columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      currentSprintId={currentSprintId}
                      onIssueClick={onIssueClick}
                    />
                  ))
                ) : (
                  <p className="px-1 py-2 text-center text-[11px] text-muted-foreground">
                    {t('tasksSection.empty')}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function IssueRow({ issue, highlighted }: { issue: BoardIssue; highlighted: boolean }) {
  const { t } = useTranslation('projectBoard');

  return (
    <div
      id={issueAnchorId(issue.id)}
      className={cn(
        'rounded-lg border border-border/60 bg-card p-3 transition-shadow duration-300',
        highlighted && 'ring-2 ring-destructive/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            SEVERITY_STYLES[issue.severity] ?? SEVERITY_STYLES.low,
          )}
        >
          {t(`issues.severity.${issue.severity}`, { defaultValue: issue.severity })}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{issue.id}</span>
        <span
          className={cn(
            'text-sm',
            issue.status === 'open' ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {issue.title}
        </span>
        <span className="ms-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          {issue.status === 'fixed' && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
          {issue.status === 'open' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
          {issue.status === 'wontfix' && <XCircle className="h-3.5 w-3.5" />}
          {t(`issues.status.${issue.status}`, { defaultValue: issue.status })}
        </span>
      </div>
      {issue.fix && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Wrench className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{issue.fix}</span>
        </p>
      )}
    </div>
  );
}

function IssuesList({
  state,
  highlightedIssue,
}: {
  state: ProjectBoardState;
  highlightedIssue: string | null;
}) {
  const { t } = useTranslation('projectBoard');
  const issues = state.issues ?? [];

  if (!issues.length) {
    return null;
  }

  // Open issues first, then by severity weight inside each group.
  const severityWeight: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...issues].sort((a, b) => {
    const openDelta = Number(a.status !== 'open') - Number(b.status !== 'open');
    if (openDelta !== 0) return openDelta;
    return (severityWeight[a.severity] ?? 4) - (severityWeight[b.severity] ?? 4);
  });

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('issues.title')}</h3>
      <div className="space-y-2">
        {sorted.map((issue) => (
          <IssueRow key={issue.id} issue={issue} highlighted={issue.id === highlightedIssue} />
        ))}
      </div>
    </section>
  );
}

function DecisionRow({ decision }: { decision: BoardDecision }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{decision.id}</span>
        <span className="text-sm font-medium text-foreground">{decision.title}</span>
      </div>
      {decision.link && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <FileText className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span dir="ltr" className="break-all font-mono text-[11px]">
            {decision.link}
          </span>
        </p>
      )}
    </div>
  );
}

function DecisionsList({ state }: { state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');
  const decisions = state.decisions ?? [];

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('decisions.title')}</h3>
      {decisions.length ? (
        <div className="space-y-2">
          {decisions.map((decision) => (
            <DecisionRow key={decision.id} decision={decision} />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
          {t('decisions.empty')}
        </p>
      )}
    </section>
  );
}

export default function BoardOverview({ state }: BoardOverviewProps) {
  const { t } = useTranslation('projectBoard');
  const [highlightedIssue, setHighlightedIssue] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bug-task → issue visual link: scroll to the issue row and flash it.
  const handleIssueClick = useCallback((issueId: string) => {
    document
      .getElementById(issueAnchorId(issueId))
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedIssue(issueId);
    if (highlightTimer.current) {
      clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = setTimeout(() => setHighlightedIssue(null), 2200);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current) {
        clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">{state.project}</h2>
          {state.updated && (
            <span className="text-xs text-muted-foreground">
              {t('updated', { date: state.updated })}
            </span>
          )}
        </div>

        <PhaseTimeline state={state} />
        <SprintsSection state={state} />
        <TasksBoard state={state} onIssueClick={handleIssueClick} />
        <IssuesList state={state} highlightedIssue={highlightedIssue} />
        <DecisionsList state={state} />
      </div>
    </div>
  );
}
