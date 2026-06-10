/**
 * Project Board types — mirror of docs/project-state.json (schema v1 + 1.1
 * additions: `sprints` array and tasks[].sprint/kind/issue). All 1.1 fields
 * are optional so v1 files keep rendering unchanged.
 * Spec: ~/.claude/wiki/project-board.md
 */

export type PhaseStatus = 'pending' | 'current' | 'done' | 'cancelled';
export type SprintStatus = 'planned' | 'current' | 'done';
export type TaskStatus = 'open' | 'in_progress' | 'done';
export type TaskKind = 'feature' | 'bug' | 'chore' | 'spike';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'fixed' | 'wontfix';

export type BoardPhase = {
  id: string;
  title: string;
  status: PhaseStatus;
  progress: number;
};

export type BoardSprint = {
  id: string;
  phase: string;
  goal: string;
  status: SprintStatus;
  started?: string | null;
  ended?: string | null;
};

export type BoardTask = {
  id: string;
  phase: string;
  /** Sprint id, or null/absent for backlog tasks (schema 1.1). */
  sprint?: string | null;
  /** Task kind badge (schema 1.1). */
  kind?: TaskKind;
  /** Linked issue id (e.g. "B-3") for kind="bug" tasks (schema 1.1). */
  issue?: string | null;
  title: string;
  status: TaskStatus;
  owner?: string;
  closed?: string | null;
};

export type BoardIssue = {
  id: string;
  title: string;
  severity: IssueSeverity;
  status: IssueStatus;
  fix?: string | null;
  found?: string;
};

export type BoardDecision = {
  id: string;
  title: string;
  link?: string;
};

export type ProjectBoardState = {
  $version: number;
  project: string;
  updated: string;
  phases: BoardPhase[];
  /** Schema 1.1 — absent in v1 files. */
  sprints?: BoardSprint[];
  tasks: BoardTask[];
  issues: BoardIssue[];
  decisions: BoardDecision[];
};

export type ProjectBoardResponse = {
  projectId: string;
  available: boolean;
  state: ProjectBoardState | null;
  stateError: boolean;
  architecture: {
    technical: string | null;
    simplified: string | null;
  };
};
