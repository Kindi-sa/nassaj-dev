import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   *
   * `userId` is forwarded to the provider so credential-isolating providers
   * report the status of that user's resolved environment, not the operator's.
   */
  async getProviderAuthStatus(
    providerName: string,
    userId?: string | number | null,
  ): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.auth.getStatus(userId);
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};
