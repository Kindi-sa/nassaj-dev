import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  authenticated: boolean;
  installed: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
  /**
   * True only when the HTTP request itself failed (non-2xx response or network
   * error). Distinct from `error`, which the backend fills for legitimate
   * negative states (e.g. "Not installed", "Not authenticated") on a successful
   * 200 response. Filtering logic uses this flag for fail-open decisions so that
   * a populated `error` from a successful check still triggers hide/disable.
   */
  checkFailed: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

// Providers actively probed by the auth status refresher. Antigravity is
// enabled again over the provider-models layer (live agy catalog with a
// graceful fallback); its auth status endpoint reports the real agy auth state.
export const CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'];

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  gemini: '/api/providers/gemini/auth/status',
  antigravity: '/api/providers/antigravity/auth/status',
  opencode: '/api/providers/opencode/auth/status',
  // Placeholder providers: declared in the union but not probed (absent from
  // CLI_PROVIDERS). Endpoints follow the same shape for when a backend lands.
  deepseek: '/api/providers/deepseek/auth/status',
  glm: '/api/providers/glm/auth/status',
  hermes: '/api/providers/hermes/auth/status',
  sakana: '/api/providers/sakana/auth/status',
};

// fail-open: installed defaults to true so providers remain visible before the
// first auth-status response arrives. Only an explicit installed===false hides them.
export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  cursor: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  codex: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  gemini: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  antigravity: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  opencode: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  deepseek: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  glm: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  hermes: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
  sakana: { authenticated: false, installed: true, email: null, method: null, error: null, loading, checkFailed: false },
});
