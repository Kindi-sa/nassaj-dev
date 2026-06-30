import { useCallback, useRef, useState, useEffect } from 'react';
import { PanelTop, PanelTopDashed, PanelTopClose, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainContentHeaderProps } from '../../types/types';
import { Tooltip } from '../../../../shared/view/ui';
import { useUiPreferences, type TabsDisplayMode } from '../../../../hooks/useUiPreferences';
import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import HeaderUsageIndicator from './HeaderUsageIndicator';

// Cyclic order of the header tab-display modes: full -> compact -> hidden -> full.
const NEXT_TABS_MODE: Record<TabsDisplayMode, TabsDisplayMode> = {
  full: 'compact',
  compact: 'hidden',
  hidden: 'full',
};

// Icon shown on the toggle reflects the *current* mode at a glance.
const TABS_MODE_ICON: Record<TabsDisplayMode, LucideIcon> = {
  full: PanelTop,
  compact: PanelTopDashed,
  hidden: PanelTopClose,
};

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
}: MainContentHeaderProps) {
  const { t, i18n } = useTranslation('common');
  const { preferences, setPreference } = useUiPreferences();

  // Cyclic quick-toggle for the header tab switcher. `tabsDisplayMode` is the
  // single source of truth (full | compact | hidden); each press advances to the
  // next mode. The legacy "Compact tabs (icons only)" appearance checkbox writes
  // the derived `tabsIconOnly` flag, which the preferences reducer keeps in sync
  // with `tabsDisplayMode` (compact <-> checked), so button and checkbox stay one
  // source of truth across reloads and instances.
  const tabsMode = preferences.tabsDisplayMode;
  const nextMode = NEXT_TABS_MODE[tabsMode];
  const CurrentModeIcon = TABS_MODE_ICON[tabsMode];

  const cycleTabsMode = useCallback(() => {
    setPreference('tabsDisplayMode', NEXT_TABS_MODE[tabsMode]);
  }, [setPreference, tabsMode]);

  // No dedicated locale keys yet (locales are owned elsewhere); supply correct
  // per-language defaults so the control is always meaningful for a11y. Future
  // translations of `mainContent.tabsDisplayToggle.*` override these automatically.
  const isArabic = i18n.language?.startsWith('ar');
  const modeName = (mode: TabsDisplayMode): string => {
    if (mode === 'full') {
      return t('mainContent.tabsDisplayToggle.full', {
        defaultValue: isArabic ? 'فرد (أيقونات + نصوص)' : 'Expanded (icons + text)',
      });
    }
    if (mode === 'compact') {
      return t('mainContent.tabsDisplayToggle.compact', {
        defaultValue: isArabic ? 'ضمّ (أيقونات فقط)' : 'Compact (icons only)',
      });
    }
    return t('mainContent.tabsDisplayToggle.hidden', {
      defaultValue: isArabic ? 'إخفاء التبويبات' : 'Hidden tabs',
    });
  };

  // Tooltip/label states the current mode and the next action on press.
  const toggleLabel = t('mainContent.tabsDisplayToggle.label', {
    current: modeName(tabsMode),
    next: modeName(nextMode),
    defaultValue: isArabic
      ? `عرض التبويبات: ${modeName(tabsMode)} — اضغط للانتقال إلى ${modeName(nextMode)}`
      : `Tabs display: ${modeName(tabsMode)} — press to switch to ${modeName(nextMode)}`,
  });

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
          {/* Tab group renders only when the display mode is not "hidden".
              When hidden it is not mounted at all (no offscreen DOM). */}
          {tabsMode !== 'hidden' && (
            <div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">
              {canScrollLeft && (
                <div className="pointer-events-none absolute inset-y-0 start-0 z-10 w-6 bg-gradient-to-r from-background to-transparent rtl:bg-gradient-to-l" />
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
                <div className="pointer-events-none absolute inset-y-0 end-0 z-10 w-6 bg-gradient-to-l from-background to-transparent rtl:bg-gradient-to-r" />
              )}
            </div>
          )}

          {/* Cyclic tabs-display toggle (full -> compact -> hidden), pinned to the
              trailing (inline-end) edge of the header. Small and quiet (ghost):
              muted by default, gentle accent on hover; the icon reflects the
              current mode. Sole control bound to `tabsDisplayMode`; the appearance
              "Compact tabs" checkbox stays consistent via the preferences reducer. */}
          <Tooltip content={toggleLabel} position="bottom">
            <button
              type="button"
              onClick={cycleTabsMode}
              aria-label={toggleLabel}
              title={toggleLabel}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CurrentModeIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
