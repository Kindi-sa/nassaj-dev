/**
 * Project Board types — mirror of docs/project-state.json (schema v1).
 * Spec: ~/.claude/wiki/project-board.md
 */

export type PhaseStatus = 'pending' | 'current' | 'done' | 'cancelled';
export type TaskStatus = 'open' | 'in_progress' | 'done';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'fixed' | 'wontfix';

export type BoardPhase = {
  id: string;
  title: string;
  status: PhaseStatus;
  progress: number;
};

export type BoardTask = {
  id: string;
  phase: string;
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
