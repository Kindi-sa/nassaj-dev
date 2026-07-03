import { Archive, BookOpen, FolderPlus, Plus, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';

import { Button, Input, Tooltip } from '../../../../shared/view/ui';
import { IS_PLATFORM } from '../../../../constants/config';
import { cn } from '../../../../lib/utils';
import { useBranding } from '../../../../contexts/BrandingContext';
import { useTheme } from '../../../../contexts/ThemeContext';
import type { ProjectMembershipFilter, SidebarSearchMode } from '../../types/types';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  membershipFilter: ProjectMembershipFilter;
  onMembershipFilterChange: (filter: ProjectMembershipFilter) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  membershipFilter,
  onMembershipFilterChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const navigate = useNavigate();
  const { title: brandingTitle, logoUrl, logoDarkUrl, logoOnly: brandingLogoOnly } = useBranding();
  const { isDarkMode } = useTheme();
  // Dark theme prefers the dedicated dark logo and falls back to the main one.
  const brandingLogoUrl = isDarkMode ? (logoDarkUrl ?? logoUrl) : logoUrl;
  const showSearchTools = (projectsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'archived'
    ? t('search.archivedPlaceholder', 'Search archived sessions...')
    : t('projects.searchPlaceholder');

  const displayTitle = brandingTitle ?? t('app.title');

  // "My projects / Team / All" view filter (C-MU-UX-PROJ-FILTER), shown where
  // the old Projects/Conversations tabs used to be (C-MU-UX-SIDEBAR-TABS).
  // Flex order follows the document direction, so the segmented control lays
  // out correctly in RTL without extra handling.
  const membershipOptions: { value: ProjectMembershipFilter; label: string }[] = [
    { value: 'mine', label: t('projects.myProjects') },
    { value: 'team', label: t('projects.teamProjects') },
    { value: 'all', label: t('projects.all') },
  ];

  // Shared segmented control: membership filter + archive toggle. Selecting a
  // membership option always returns to the projects view, leaving the archive.
  const filterToggle = (
    <div className="flex items-center rounded-lg bg-muted/50 p-0.5">
      {membershipOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => {
            onMembershipFilterChange(option.value);
            if (searchMode !== 'projects') {
              onSearchModeChange('projects');
            }
          }}
          aria-pressed={searchMode === 'projects' && membershipFilter === option.value}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all whitespace-nowrap",
            searchMode === 'projects' && membershipFilter === option.value
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
      <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top">
        <button
          onClick={() => onSearchModeChange('archived')}
          aria-pressed={searchMode === 'archived'}
          aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
          title={t('search.archiveOnlyTooltip', 'Archive only')}
          className={cn(
            "flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-medium transition-all",
            searchMode === 'archived'
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Archive className="h-3 w-3" />
        </button>
      </Tooltip>
    </div>
  );

  // Wordmark mode: a single uploaded logo replaces the icon + title pair. The
  // title still reaches assistive tech through the img alt text.
  const LogoBlock = () => (brandingLogoOnly && brandingLogoUrl) ? (
    <img
      src={brandingLogoUrl}
      alt={displayTitle}
      className="h-8 w-auto max-w-[180px] min-w-0 object-contain object-left rtl:object-right"
    />
  ) : (
    <div className="flex min-w-0 items-center gap-2.5">
      {brandingLogoUrl ? (
        <img
          src={brandingLogoUrl}
          alt={displayTitle}
          className="h-7 w-auto max-w-[140px] flex-shrink-0 object-contain object-left rtl:object-right"
        />
      ) : (
        /* شعار نسّاج الافتراضي في الشريط الجانبي — وعي بالثيم */
        <img
          src={isDarkMode ? '/nassaj-logo-on-dark.svg' : '/nassaj-logo-on-light.svg'}
          alt="نسّاج"
          className="h-6 w-auto flex-shrink-0"
        />
      )}
      {brandingLogoUrl && (
        <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">{displayTitle}</h1>
      )}
    </div>
  );

  return (
    <div className="flex-shrink-0">
      {/* Desktop header */}
      <div
        className="hidden px-3 pb-2 pt-3 md:block"
        style={{}}
      >
        <div className="flex items-center justify-between gap-2">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex min-w-0 items-center gap-2.5 rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              aria-label={t('tooltips.goHome', displayTitle)}
              title={t('tooltips.goHome', displayTitle)}
            >
              <LogoBlock />
            </button>
          )}

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCreateProject}
              title={t('tooltips.createProject')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Tooltip content={t('tooltips.openWiki')} position="bottom">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('tooltips.openWiki')}
                className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                onClick={() => window.open('/wiki', '_blank', 'noopener,noreferrer')}
              >
                <BookOpen className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Search bar */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {/* Membership filter + archive toggle */}
            {filterToggle}
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 ps-9 pe-14 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter ? (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute end-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              ) : (
                <kbd
                  aria-hidden
                  title={t('tooltips.openCommandPalette')}
                  className="pointer-events-none absolute end-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
                >
                  {MOD_KEY}
                  <span>K</span>
                </kbd>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Desktop divider */}
      <div className="nav-divider hidden md:block" />

      {/* Mobile header */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity active:opacity-70"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex min-w-0 items-center gap-2.5 rounded-lg transition-opacity active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              aria-label={t('tooltips.goHome', displayTitle)}
              title={t('tooltips.goHome', displayTitle)}
            >
              <LogoBlock />
            </button>
          )}

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile search */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {filterToggle}
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 ps-10 pe-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute end-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="nav-divider md:hidden" />
    </div>
  );
}
