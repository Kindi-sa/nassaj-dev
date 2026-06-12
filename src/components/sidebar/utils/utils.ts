import type { TFunction } from 'i18next';

import type { Project } from '../../../types/app';
import type { ProjectMembershipFilter, ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider } from '../types/types';

// View-only preference: "my projects" / "team" / "all". Stored under its own
// key so it is safe on a shared browser (no identity, just a display filter).
// Defaults to 'all' to preserve the pre-multi-user behaviour (every project
// visible).
const PROJECT_MEMBERSHIP_FILTER_STORAGE_KEY = 'sidebarProjectMembershipFilter';

export const readProjectMembershipFilter = (): ProjectMembershipFilter => {
  try {
    const storedFilter = localStorage.getItem(PROJECT_MEMBERSHIP_FILTER_STORAGE_KEY);
    return storedFilter === 'mine' || storedFilter === 'team' ? storedFilter : 'all';
  } catch {
    return 'all';
  }
};

export const writeProjectMembershipFilter = (filter: ProjectMembershipFilter): void => {
  try {
    localStorage.setItem(PROJECT_MEMBERSHIP_FILTER_STORAGE_KEY, filter);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

/**
 * Applies the "My projects / Team / All" view filter. This is a view filter
 * only — access is never restricted client-side; the server already excludes
 * projects the user may not see.
 *
 * - `all`  : list untouched (legacy behaviour, default).
 * - `mine` : projects owned by the current user (`isOwner`, stamped by the
 *            server: creator or owner-role project member).
 * - `team` : shared projects — owned by someone else, or ownerless legacy
 *            projects the user participates in (`isMember`). Ownerless
 *            projects without the user's participation appear under `all` only.
 */
export const filterProjectsByMembership = (
  projects: Project[],
  filter: ProjectMembershipFilter,
): Project[] => {
  if (filter === 'mine') {
    return projects.filter((project) => project.isOwner === true);
  }

  if (filter === 'team') {
    return projects.filter((project) => {
      if (project.isOwner === true) {
        return false;
      }

      const hasRegisteredOwner = typeof project.ownerId === 'number';
      return hasRegisteredOwner || project.isMember === true;
    });
  }

  return projects;
};

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

/**
 * Creation date used for sidebar session ordering (newest-created first).
 * Falls back to last activity only for legacy rows that carry no creation
 * timestamp, mirroring the server-side COALESCE(created_at, updated_at).
 */
export const getSessionCreationDate = (session: SessionWithProvider): Date => {
  return new Date(getCreatedTimestamp(session) || getUpdatedTimestamp(session) || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isCursorSession: session.__provider === 'cursor',
    isCodexSession: session.__provider === 'codex',
    isGeminiSession: session.__provider === 'gemini',
    isOpenCodeSession: session.__provider === 'opencode',
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const claudeSessions = [...(project.sessions || [])].map((session) => ({
    ...session,
    __provider: 'claude' as const,
  }));

  const cursorSessions = (project.cursorSessions || []).map((session) => ({
    ...session,
    __provider: 'cursor' as const,
  }));

  const codexSessions = (project.codexSessions || []).map((session) => ({
    ...session,
    __provider: 'codex' as const,
  }));

  const geminiSessions = (project.geminiSessions || []).map((session) => ({
    ...session,
    __provider: 'gemini' as const,
  }));

  const antigravitySessions = (project.antigravitySessions || []).map((session) => ({
    ...session,
    __provider: 'antigravity' as const,
  }));

  const opencodeSessions = (project.opencodeSessions || []).map((session) => ({
    ...session,
    __provider: 'opencode' as const,
  }));

  return [
    ...claudeSessions,
    ...cursorSessions,
    ...codexSessions,
    ...geminiSessions,
    ...antigravitySessions,
    ...opencodeSessions,
  ].sort((a, b) => {
    // Starred (per-user favourite) sessions float to the top within the
    // project; among equal star state, newest-created first (NOT last
    // activity, so a session keeps its position while it is being worked on).
    const aStarred = Boolean(a.starred);
    const bStarred = Boolean(b.starred);
    if (aStarred !== bStarred) {
      return aStarred ? -1 : 1;
    }
    return getSessionCreationDate(b).getTime() - getSessionCreationDate(a).getTime();
  });
};

export const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
