import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { GeminiProvider } from '@/modules/providers/list/gemini/gemini.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { DisabledProvider } from '@/modules/providers/shared/base/disabled.provider.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// Partial<Record<...>> because not every LLMProvider literal in the type union
// is guaranteed to have a concrete provider instance registered at startup.
// `resolveProvider` already returns an `AppError` for any unregistered key.
const providers: Partial<Record<LLMProvider, IProvider>> = {
  // Antigravity (agy) is temporarily disabled during the upstream v1.33 sync
  // (#762 introduced the provider-models layer; the agy adapter needs to be
  // re-wired on top of it before re-enabling). We register a DisabledProvider
  // stub under the `antigravity` key — NOT the real AntigravityProvider, and
  // NOT a deleted entry — so resume of existing agy sessions reaches a
  // graceful "temporarily disabled" path instead of throwing
  // UNSUPPORTED_PROVIDER. The agy model catalog is preserved in
  // antigravity-models.provider.ts (ANTIGRAVITY_FALLBACK_MODELS).
  // TODO(antigravity-reenable): swap back to `new AntigravityProvider()` once
  //   the agy adapter is rebuilt over the provider-models layer via
  //   antigravity-models.provider.ts. Tracked as a separate work item.
  antigravity: new DisabledProvider(
    'antigravity',
    'Antigravity (agy) is temporarily disabled.',
  ),
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  gemini: new GeminiProvider(),
  opencode: new OpenCodeProvider(),
};

/**
 * Central registry for resolving concrete provider implementations by id.
 */
export const providerRegistry = {
  listProviders(): IProvider[] {
    return Object.values(providers);
  },

  resolveProvider(provider: string): IProvider {
    const key = provider as LLMProvider;
    const resolvedProvider = providers[key];
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  },
};
