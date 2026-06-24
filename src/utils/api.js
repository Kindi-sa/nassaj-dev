import { IS_PLATFORM } from "../constants/config";

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    // Auto-logout on definitive auth rejection. Fires a custom event so
    // AuthContext can clear the session without a circular import.
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
      return response;
    }

    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      localStorage.setItem('auth-token', refreshedToken);
    }
    return response;
  });
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    user: () => authenticatedFetch('/api/auth/user'),
    // Current identity incl. role + status (Phase-MU).
    me: () => authenticatedFetch('/api/auth/me'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),

    // Self-service profile (Phase-MU F-1 / F-2).
    // Change own password — returns a fresh token so the current device stays signed in.
    changePassword: (currentPassword, newPassword) =>
      authenticatedFetch('/api/auth/me/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    // Change own username.
    changeUsername: (username) =>
      authenticatedFetch('/api/auth/me/username', {
        method: 'PATCH',
        body: JSON.stringify({ username }),
      }),
    // Upload own profile picture (multipart). The Content-Type header is left
    // unset so the browser adds the multipart boundary automatically.
    updateAvatar: (file) => {
      const formData = new FormData();
      formData.append('avatar', file);
      return authenticatedFetch('/api/auth/me/avatar', {
        method: 'PATCH',
        body: formData,
      });
    },
    // Pick a generated gallery avatar or a palette colour (no file upload).
    // Pass exactly one of { color } or { avatar } (an svg+xml data URI).
    updateAvatarChoice: (choice) =>
      authenticatedFetch('/api/auth/me/avatar-choice', {
        method: 'PATCH',
        body: JSON.stringify(choice),
      }),

    // WebAuthn passkeys (B-PK / C-PK). The two login endpoints are public
    // (no token yet); registration and credential management require auth.
    // Options endpoints return raw @simplewebauthn option JSON — pass them
    // straight to startRegistration/startAuthentication({ optionsJSON }).
    webauthn: {
      registerOptions: () =>
        authenticatedFetch('/api/auth/webauthn/register/options', { method: 'POST' }),
      // `response` is the RegistrationResponseJSON produced by startRegistration.
      registerVerify: (response, name) =>
        authenticatedFetch('/api/auth/webauthn/register/verify', {
          method: 'POST',
          body: JSON.stringify(name ? { response, name } : { response }),
        }),
      listCredentials: () => authenticatedFetch('/api/auth/webauthn/credentials'),
      renameCredential: (id, name) =>
        authenticatedFetch(`/api/auth/webauthn/credentials/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        }),
      deleteCredential: (id) =>
        authenticatedFetch(`/api/auth/webauthn/credentials/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      // Public login pair — same contract as POST /api/auth/login on verify.
      loginOptions: () => fetch('/api/auth/webauthn/login/options', { method: 'POST' }),
      // `response` is the AuthenticationResponseJSON produced by startAuthentication.
      loginVerify: (response) => fetch('/api/auth/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      }),
    },

    // Invite acceptance (public): creates a `user` account from an invite token.
    acceptInvite: (token, username, password) => fetch('/api/auth/invite/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, username, password }),
    }),

    // Invite management (owner/admin).
    listInvites: () => authenticatedFetch('/api/auth/invites'),
    createInvite: ({ role, email, ttlHours } = {}) =>
      authenticatedFetch('/api/auth/invites', {
        method: 'POST',
        body: JSON.stringify({ role, email, ttlHours }),
      }),
    revokeInvite: (id) =>
      authenticatedFetch(`/api/auth/invites/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    // User management (owner/admin list; owner-only mutations).
    listUsers: () => authenticatedFetch('/api/auth/users'),
    updateUserRole: (id, role) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    updateUserStatus: (id, status) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    // Reset another user's password to a generated temporary one (owner/admin).
    // The temp password is returned ONCE in plaintext.
    resetUserPassword: (id) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}/reset-password`, {
        method: 'POST',
      }),
    // Permanently delete a user account (owner-only). Cannot delete self or last owner.
    deleteUser: (id) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },

  // App-wide branding (custom logo + title). Read is available to any
  // authenticated user (needed to render the header); writes are owner-only,
  // enforced on the server.
  branding: {
    get: () => authenticatedFetch('/api/settings/branding'),
    updateTitle: (title) =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ title }),
      }),
    updateLogoOnly: (logoOnly) =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ logoOnly }),
      }),
    updateSplashHideTitle: (splashHideTitle) =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ splashHideTitle }),
      }),
    uploadLogo: (file, variant = 'light') => {
      const formData = new FormData();
      formData.append('logo', file);
      return authenticatedFetch(`/api/settings/branding/logo?variant=${encodeURIComponent(variant)}`, {
        method: 'POST',
        body: formData,
      });
    },
    deleteLogo: (variant = 'light') =>
      authenticatedFetch(`/api/settings/branding/logo?variant=${encodeURIComponent(variant)}`, {
        method: 'DELETE',
      }),
  },

  // Admin-only: per-provider credential sharing mode (shared vs isolated).
  admin: {
    getProviderSharing: () => authenticatedFetch('/api/admin/provider-sharing'),
    updateProviderSharing: (config) =>
      authenticatedFetch('/api/admin/provider-sharing', {
        method: 'PUT',
        body: JSON.stringify(config),
      }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => authenticatedFetch('/api/projects'),
  archivedProjects: () => authenticatedFetch('/api/projects/archived'),
  projectSessions: (projectId, { limit = 20, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params.toString()}`);
  },
  projectTaskmaster: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  // Project Board — live projection of docs/project-state.json + ARCHITECTURE files.
  projectBoard: (projectId) =>
    authenticatedFetch(`/api/project-board/${encodeURIComponent(projectId)}`),
  // Runner Bridge — read runner state + write control files (ADR-RUNNER-BRIDGE-001).
  runnerStatus: (projectId) =>
    authenticatedFetch(`/api/runner/${encodeURIComponent(projectId)}`),
  runnerControl: (projectId, action) =>
    authenticatedFetch(`/api/runner/${encodeURIComponent(projectId)}/${action}`, {
      method: 'POST',
    }),
  // Multi-user participation (Phase-MU): humans + agents seen in a session/project.
  // Lazy endpoints — fetched on demand (hover/open), never in the initial load.
  sessionParticipants: (sessionId) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/participants`),
  sessionAgents: (sessionId) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/agents`),
  projectParticipants: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/participants`),
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectId, displayName) =>
    authenticatedFetch(`/api/projects/${projectId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  restoreProject: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
  // Project privacy (C-PRIV-6). Server returns { success, data:{ projectId, visibility } }
  // and broadcasts `projects_updated`; the frontend updates optimistically first.
  setProjectVisibility: (projectId, visibility) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    }),
  // Project membership management (manager-only). Optional in this UI wave.
  getProjectMembers: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/members`),
  addProjectMember: (projectId, userId, role = 'member') =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    }),
  removeProjectMember: (projectId, userId) =>
    authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  // Session deletion now mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) {
      params.set('force', 'true');
    }
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${sessionId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  getArchivedSessions: () =>
    authenticatedFetch('/api/providers/sessions/archived'),
  restoreSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}/restore`, {
      method: 'POST',
    }),
  renameSession: (sessionId, summary) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    }),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) params.set('force', 'true');
    const qs = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem('auth-token');
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/providers/search/sessions?${params.toString()}`;
  },
  createProject: (projectData) =>
    authenticatedFetch('/api/projects/create-project', {
      method: 'POST',
      body: JSON.stringify(projectData),
    }),
  migrateLegacyProjectStars: (projectIds) =>
    authenticatedFetch('/api/projects/migrate-legacy-stars', {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    }),
  toggleProjectStar: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`, {
      method: 'POST',
    }),
  // Per-user session star/favorite. Idempotent — `starred` is the desired
  // absolute state, not a toggle. The user is taken from the auth token server-side.
  // Returns { success, data: { sessionId, projectName, starred } }.
  starSession: (sessionId, projectName, starred) =>
    authenticatedFetch('/api/sessions/star', {
      method: 'POST',
      body: JSON.stringify({ sessionId, projectName, starred }),
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectId, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectId, options = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, options),

  // File operations
  createFile: (projectId, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectId, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectId, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectId, formData) =>
    authenticatedFetch(`/api/projects/${projectId}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectId) =>
      authenticatedFetch(`/api/taskmaster/init/${projectId}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectId, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectId, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectId, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectId, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectId}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
    // Per-user Claude subscription link status (Phase-MU, B-MU-ONBOARD).
    // Returns { connected: boolean, provider: 'claude' }. With per-user
    // isolation each user links their own Claude credential via the terminal
    // (`claude setup-token`); the owner is symbolically linked automatically.
    claudeConnection: () => authenticatedFetch('/api/user/claude-connection'),
    // Per-user Antigravity (agy) subscription link status. Mirrors
    // claudeConnection: returns { connected: boolean, provider: 'agy' }. Each
    // user links their own agy credential by running `agy` interactively in the
    // terminal (which launches OAuth when no valid token exists); the owner is
    // symbolically linked automatically and always reports connected: true.
    agyConnection: () => authenticatedFetch('/api/user/agy-connection'),
  },

  // Provider account/usage endpoints.
  providers: {
    // Claude account usage (plan limits, session/weekly windows, extra usage).
    // Backend caches for 180s; the client should not poll more frequently.
    claudeUsage: () => authenticatedFetch('/api/providers/claude/usage'),
    // Antigravity (agy) read-only active model. The model is chosen inside agy's
    // own settings; agy ignores any UI selection, so we only display it.
    antigravityActiveModel: () => authenticatedFetch('/api/providers/antigravity/active-model'),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
