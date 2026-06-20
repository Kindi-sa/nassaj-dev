import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { VENDOR_PROVIDERS, type VendorProvider } from '../vendorProviders';

export type VendorKeyStatusMap = Record<VendorProvider, boolean>;

type ApiKeyStatusResponse = {
  success?: boolean;
  data?: { provider?: string; configured?: boolean };
};

const createInitialMap = (): VendorKeyStatusMap => ({
  kimi: false,
  deepseek: false,
  glm: false,
});

/**
 * Reads, for all hosted vendor providers at once, whether an API key is
 * configured (existence only — never the value). Used by the model picker to
 * gate vendor models behind ADR-030: a provider with no key is shown disabled
 * with a CTA to add one; a configured provider is selectable.
 */
export function useVendorKeyStatuses(enabled = true) {
  const [statuses, setStatuses] = useState<VendorKeyStatusMap>(createInitialMap);
  const [loading, setLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        VENDOR_PROVIDERS.map(async (provider) => {
          try {
            const response = await authenticatedFetch(`/api/providers/${provider}/api-key`);
            if (!response.ok) {
              return [provider, false] as const;
            }
            const payload = (await response.json()) as ApiKeyStatusResponse;
            return [provider, Boolean(payload.data?.configured)] as const;
          } catch {
            return [provider, false] as const;
          }
        }),
      );

      const next = createInitialMap();
      for (const [provider, configured] of results) {
        next[provider] = configured;
      }
      setStatuses(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  return { statuses, loading, refresh };
}
