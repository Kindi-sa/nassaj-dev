import { useCallback, useRef, useState, useEffect } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainContentHeaderProps } from '../../types/types';
import { Tooltip } from '../../../../shared/view/ui';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import HeaderUsageIndicator from './HeaderUsageIndicator';

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
}: MainContentHeaderProps) {
  const { t } = useTranslation('common');
  const { preferences, setPreference } = useUiPreferences();
  const sidebarVisible = preferences.sidebarVisible;

  // Sidebar visibility now lives in the top bar (next to the tab pills) instead
  // of inside the sidebar header. `sidebarVisible` is the same `uiPreferences`
  // value the sidebar reads; the hook's cross-instance sync keeps both in step.
  // Desktop-only: on mobile the sidebar is a drawer driven by `sidebarOpen`.
  const toggleSidebar = useCallback(() => {
    setPreference('sidebarVisible', !sidebarVisible);
  }, [setPreference, sidebarVisible]);

  const sidebarToggleLabel = sidebarVisible
    ? t('versionUpdate.ariaLabels.closeSidebar')
    : t('versionUpdate.ariaLabels.showSidebar');

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
          />
        </div>

        <HeaderUsageIndicator />

        <div className="flex min-w-0 flex-shrink items-center gap-1.5 sm:flex-shrink-0">
          {/* Sidebar show/hide toggle — desktop only (mobile uses the drawer
              menu button on the left). The panel glyph is mirrored in RTL via
              `scale-x-[-1]` so the arrow folds toward the sidebar's side. */}
          <Tooltip content={sidebarToggleLabel} position="bottom">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={sidebarToggleLabel}
              aria-pressed={sidebarVisible}
              title={sidebarToggleLabel}
              className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex"
            >
              {sidebarVisible ? (
                <PanelLeftClose className="h-4 w-4 rtl:scale-x-[-1]" aria-hidden="true" />
              ) : (
                <PanelLeftOpen className="h-4 w-4 rtl:scale-x-[-1]" aria-hidden="true" />
              )}
            </button>
          </Tooltip>

          <div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className="scrollbar-hide overflow-x-auto"
            >
              <MainContentTabSwitcher
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={shouldShowTasksTab}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
