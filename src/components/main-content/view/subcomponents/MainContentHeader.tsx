import { useCallback, useRef, useState, useEffect } from 'react';
import { PanelTop } from 'lucide-react';
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

  // Quick-access shortcut for the existing "Compact tabs (icons only)" setting
  // (the `tabsIconOnly` preference, also exposed as a checkbox in the appearance
  // settings). Toggling here flips the very same synced `uiPreferences` value, so
  // the button and the settings checkbox are one source of truth — pressing the
  // button switches the tab pills between icons-only and icons+text, and the
  // checkbox reflects it (and vice versa) across reloads and instances.
  const compactTabs = preferences.tabsIconOnly;

  const toggleCompactTabs = useCallback(() => {
    setPreference('tabsIconOnly', !compactTabs);
  }, [setPreference, compactTabs]);

  // No dedicated locale key yet (locales are owned elsewhere); supply a correct
  // per-language default so the control is always meaningful for a11y. A future
  // translation of `mainContent.compactTabsToggle.*` overrides these automatically.
  const isArabic = i18n.language?.startsWith('ar');
  const toggleLabel = compactTabs
    ? t('mainContent.compactTabsToggle.expand', {
        defaultValue: isArabic ? 'توسيع التبويبات (أيقونات + نصوص)' : 'Expand tabs (icons + text)',
      })
    : t('mainContent.compactTabsToggle.compact', {
        defaultValue: isArabic ? 'تبويبات مضغوطة (أيقونات فقط)' : 'Compact tabs (icons only)',
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
          {/* Quick-access toggle for the "Compact tabs (icons only)" preference
              (`tabsIconOnly`). It is a shortcut to the same setting exposed as a
              checkbox in appearance settings — pressed = compact (icons only).
              The tab group always renders; only the per-tab text labels show or
              hide based on the preference. */}
          <Tooltip content={toggleLabel} position="bottom">
            <button
              type="button"
              onClick={toggleCompactTabs}
              aria-label={toggleLabel}
              aria-pressed={compactTabs}
              title={toggleLabel}
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                compactTabs
                  ? 'bg-accent/80 text-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-accent/80 hover:text-foreground'
              }`}
            >
              <PanelTop className="h-4 w-4" aria-hidden="true" />
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
