import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  authenticated: boolean;
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

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, email: null, method: null, error: null, loading },
  cursor: { authenticated: false, email: null, method: null, error: null, loading },
  codex: { authenticated: false, email: null, method: null, error: null, loading },
  gemini: { authenticated: false, email: null, method: null, error: null, loading },
  antigravity: { authenticated: false, email: null, method: null, error: null, loading },
  opencode: { authenticated: false, email: null, method: null, error: null, loading },
});
