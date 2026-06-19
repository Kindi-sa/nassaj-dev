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
// The hosted vendor providers (kimi/deepseek/glm) report authenticated=true via
// the same endpoint once their API key is configured (ADR-036 / ADR-030).
export const CLI_PROVIDERS: LLMProvider[] = [
  'claude',
  'cursor',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
  'kimi',
  'deepseek',
  'glm',
];

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  gemini: '/api/providers/gemini/auth/status',
  antigravity: '/api/providers/antigravity/auth/status',
  opencode: '/api/providers/opencode/auth/status',
  kimi: '/api/providers/kimi/auth/status',
  deepseek: '/api/providers/deepseek/auth/status',
  glm: '/api/providers/glm/auth/status',
};

const initialStatus = (loading: boolean): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading,
});

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: initialStatus(loading),
  cursor: initialStatus(loading),
  codex: initialStatus(loading),
  gemini: initialStatus(loading),
  antigravity: initialStatus(loading),
  opencode: initialStatus(loading),
  kimi: initialStatus(loading),
  deepseek: initialStatus(loading),
  glm: initialStatus(loading),
});
