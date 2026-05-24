import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

// Providers actively probed by the auth status refresher. Newly declared
// providers in the LLMProvider union (e.g. `antigravity`) are intentionally
// omitted from this list until their backend auth endpoint exists, to avoid
// 404 noise during refresh. The Records below still carry placeholder entries
// to satisfy the exhaustive `Record<LLMProvider, X>` type constraint.
export const CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini'];

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  gemini: '/api/providers/gemini/auth/status',
  // Placeholder: no backend route yet; `CLI_PROVIDERS` excludes this provider
  // so the refresher does not call this endpoint.
  antigravity: '/api/providers/antigravity/auth/status',
};

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, email: null, method: null, error: null, loading },
  cursor: { authenticated: false, email: null, method: null, error: null, loading },
  codex: { authenticated: false, email: null, method: null, error: null, loading },
  gemini: { authenticated: false, email: null, method: null, error: null, loading },
  // Placeholder so consumers that dot-access `providerAuthStatus.antigravity`
  // do not encounter undefined; refresher skips this provider until wired up.
  antigravity: { authenticated: false, email: null, method: null, error: null, loading: false },
});
