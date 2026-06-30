import { useCallback, useRef, useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
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
  const { t, i18n } = useTranslation('common');
  const { preferences, setPreference } = useUiPreferences();

  // Top-bar action icons (the tab pills: chat · shell · files · git · board)
  // can be folded as a group via a chevron next to them. The state is a synced
  // `uiPreferences` value, so the choice persists across reloads and instances.
  const iconsCollapsed = preferences.topBarIconsCollapsed;

  const toggleIcons = useCallback(() => {
    setPreference('topBarIconsCollapsed', !iconsCollapsed);
  }, [setPreference, iconsCollapsed]);

  // No dedicated locale key yet (locales are owned elsewhere); supply a correct
  // per-language default so the control is always meaningful for a11y. A future
  // translation of `mainContent.toolbarToggle.*` overrides these automatically.
  const isArabic = i18n.language?.startsWith('ar');
  const toggleLabel = iconsCollapsed
    ? t('mainContent.toolbarToggle.show', {
        defaultValue: isArabic ? 'إظهار أيقونات الشريط' : 'Show toolbar icons',
      })
    : t('mainContent.toolbarToggle.hide', {
        defaultValue: isArabic ? 'إخفاء أيقونات الشريط' : 'Hide toolbar icons',
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
          {/* Collapse/show toggle for the action-icon group. When the icons are
              shown the chevron points toward them (inline-end) inviting a fold;
              when collapsed it flips 180° to point back, inviting reveal.
              `rtl:scale-x-[-1]` mirrors the glyph so the inline-end direction is
              correct in RTL as well as LTR. */}
          <Tooltip content={toggleLabel} position="bottom">
            <button
              type="button"
              onClick={toggleIcons}
              aria-label={toggleLabel}
              aria-pressed={iconsCollapsed}
              aria-expanded={!iconsCollapsed}
              title={toggleLabel}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                className={`h-4 w-4 transition-transform rtl:scale-x-[-1] ${
                  iconsCollapsed ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />
            </button>
          </Tooltip>

          {!iconsCollapsed && (
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
          )}
        </div>
      </div>
    </div>
  );
}
