import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { isCliInstalled } from '@/shared/utils.js';

export class HermesProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = isCliInstalled('hermes');
    return {
      installed,
      provider: 'hermes',
      authenticated: false,
      email: null,
      method: null,
      // Hermes does not expose a programmatic auth-status command yet;
      // once installed, the user runs `hermes` from the terminal to sign in.
      error: installed ? undefined : 'Hermes is not installed',
    };
  }
}
