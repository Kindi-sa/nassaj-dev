import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, KanbanSquare, Network } from 'lucide-react';

import { Pill, PillBar } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { useProjectBoard } from '../hooks/useProjectBoard';

import ArchitectureView from './ArchitectureView';
import BoardOverview from './BoardOverview';

type ProjectBoardPanelProps = {
  selectedProject: Project | null;
};

type BoardSection = 'overview' | 'architecture';

/** Minimal valid docs/project-state.json (schema v1, spec: ~/.claude/wiki/project-board.md). */
function buildStarterTemplate(projectName: string): string {
  return `${JSON.stringify(
    {
      $version: 1,
      project: projectName,
      updated: new Date().toISOString().slice(0, 10),
      phases: [],
      tasks: [],
      issues: [],
      decisions: [],
    },
    null,
    2
  )}\n`;
}

/**
 * Guidance shown when the project has no docs/project-state.json: explains the
 * missing file and offers a one-click copy of a valid starter template.
 */
function BoardEmptyState({ projectName }: { projectName: string }) {
  const { t } = useTranslation('projectBoard');
  const [copied, setCopied] = useState(false);

  const handleCopyTemplate = async () => {
    const ok = await copyTextToClipboard(buildStarterTemplate(projectName));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <KanbanSquare className="mx-auto mb-3 h-10 w-10 text-muted-foreground/60" />
        <h3 className="mb-2 text-sm font-semibold text-foreground">{t('empty.title')}</h3>
        <p className="mb-3 text-sm text-muted-foreground">{t('empty.description')}</p>
        <code className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground" dir="ltr">
          docs/project-state.json
        </code>
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void handleCopyTemplate()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span>{copied ? t('empty.copied') : t('empty.copyTemplate')}</span>
          </button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('empty.hint')}</p>
      </div>
    </div>
  );
}

/**
 * "Project Board" tab — a zero-LLM live view of the project's own files
 * (docs/project-state.json + ARCHITECTURE*.md). See ~/.claude/wiki/project-board.md.
 */
export default function ProjectBoardPanel({ selectedProject }: ProjectBoardPanelProps) {
  const { t } = useTranslation('projectBoard');
  const [section, setSection] = useState<BoardSection>('overview');
  const { board, isLoading, loadError } = useProjectBoard(selectedProject?.projectId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (loadError || !board) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t('error')}
      </div>
    );
  }

  const hasArchitecture = Boolean(board.architecture.technical || board.architecture.simplified);
  const projectName = selectedProject?.displayName || board.projectId;

  // Guidance empty state: the project has no docs/project-state.json (yet).
  if (!board.available && !board.state && !hasArchitecture) {
    return <BoardEmptyState projectName={projectName} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
        <PillBar>
          <Pill
            isActive={section === 'overview'}
            onClick={() => setSection('overview')}
            className="px-2.5 py-[5px]"
          >
            <KanbanSquare className="h-3.5 w-3.5" />
            <span>{t('sections.overview')}</span>
          </Pill>
          <Pill
            isActive={section === 'architecture'}
            onClick={() => setSection('architecture')}
            className="px-2.5 py-[5px]"
          >
            <Network className="h-3.5 w-3.5" />
            <span>{t('sections.architecture')}</span>
          </Pill>
        </PillBar>
      </div>

      {board.stateError && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t('stateError')}</span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {section === 'overview' ? (
          board.state ? (
            <BoardOverview state={board.state} />
          ) : (
            <BoardEmptyState projectName={projectName} />
          )
        ) : (
          <ArchitectureView
            technical={board.architecture.technical}
            simplified={board.architecture.simplified}
          />
        )}
      </div>
    </div>
  );
}
