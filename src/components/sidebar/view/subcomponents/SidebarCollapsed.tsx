import { Settings, Sparkles, PanelLeftOpen } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { Project } from '../../../../types/app';

import { SystemStatsCollapsed } from './SystemStats';
import { ClaudeUsageCollapsed } from './ClaudeUsageCollapsed';
import { PresenceCountCollapsed } from './PresenceCountCollapsed';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  updateAvailable: boolean;
  onShowVersionModal: () => void;
  /** Project list — used by the active-conversations popover to name projects. */
  projects?: Project[];
  /** Select a project from the active-conversations popover. */
  onProjectSelect?: (project: Project) => void;
  /** مزوّد الجلسة المفتوحة حالياً — يحجب أشرطة حصة Claude لغير جلسات claude. */
  sessionProvider?: string | null;
  t: TFunction;
};

export default function SidebarCollapsed({
  onExpand,
  onShowSettings,
  updateAvailable,
  onShowVersionModal,
  projects,
  onProjectSelect,
  sessionProvider,
  t,
}: SidebarCollapsedProps) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-background/80 py-3 backdrop-blur-sm">
      {/* Expand button with brand logo */}
      <button
        onClick={onExpand}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}
        title={t('common:versionUpdate.ariaLabels.showSidebar')}
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      <div className="nav-divider my-1 w-6" />

      {/* Settings */}
      <button
        onClick={onShowSettings}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.settings')}
        title={t('actions.settings')}
      >
        <Settings className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      {/* Live CPU/RAM stats */}
      <SystemStatsCollapsed t={t} />

      {/* Claude usage windows — divider rendered inside component */}
      <ClaudeUsageCollapsed sessionProvider={sessionProvider} />

      {/* Active conversations count — divider rendered inside component.
        * Hover/focus/click reveals the per-project breakdown; selecting a row
        * expands the sidebar and surfaces that project. */}
      <PresenceCountCollapsed
        projects={projects}
        onProjectSelect={onProjectSelect}
        onExpand={onExpand}
      />

      {/* Update indicator */}
      {updateAvailable && (
        <button
          onClick={onShowVersionModal}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('common:versionUpdate.ariaLabels.updateAvailable')}
          title={t('common:versionUpdate.ariaLabels.updateAvailable')}
        >
          <Sparkles className="h-4 w-4 text-blue-500" />
          <span className="absolute end-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        </button>
      )}
    </div>
  );
}
