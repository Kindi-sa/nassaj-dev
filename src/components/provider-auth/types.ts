import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  authenticated: boolean;
  installed: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
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
};

// fail-open: installed defaults to true so providers remain visible before the
// first auth-status response arrives. Only an explicit installed===false hides them.
export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, installed: true, email: null, method: null, error: null, loading },
  cursor: { authenticated: false, installed: true, email: null, method: null, error: null, loading },
  codex: { authenticated: false, installed: true, email: null, method: null, error: null, loading },
  gemini: { authenticated: false, installed: true, email: null, method: null, error: null, loading },
  antigravity: { authenticated: false, installed: true, email: null, method: null, error: null, loading },
  opencode: { authenticated: false, installed: true, email: null, method: null, error: null, loading },
});
