import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { VendorProvider } from '../vendorProviders';

/**
 * Drives the encrypted per-user vendor API-key store from the UI for a single
 * vendor provider (kimi/deepseek/glm). It talks to the backend key routes added
 * in provider.routes.ts:
 *
 *   GET    /api/providers/:provider/api-key  -> { configured: boolean }  (never the value)
 *   POST   /api/providers/:provider/api-key  -> upsert { apiKey }
 *   DELETE /api/providers/:provider/api-key  -> remove (idempotent)
 *
 * The stored value is never read back; we only ever surface whether a key is
 * configured. After a successful set/delete the caller can refresh the shared
 * `/auth/status` so the connection badge flips (ADR-030).
 */

type ApiKeyStatusResponse = {
  success?: boolean;
  data?: { provider?: string; configured?: boolean };
  error?: string;
  message?: string;
};

type MutationResult = { success: true } | { success: false; error: string };

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ApiKeyStatusResponse;
    return payload?.error ?? payload?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function useVendorApiKey(provider: VendorProvider) {
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `/api/providers/${provider}/api-key`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(endpoint);
      if (!response.ok) {
        setError(await readError(response, 'Failed to read API key status'));
        return;
      }
      const payload = (await response.json()) as ApiKeyStatusResponse;
      setConfigured(Boolean(payload.data?.configured));
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = useCallback(
    async (apiKey: string): Promise<MutationResult> => {
      const trimmed = apiKey.trim();
      if (!trimmed) {
        const message = 'API key is required';
        setError(message);
        return { success: false, error: message };
      }

      setSaving(true);
      setError(null);
      try {
        const response = await authenticatedFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: trimmed }),
        });
        if (!response.ok) {
          const message = await readError(response, 'Failed to save API key');
          setError(message);
          return { success: false, error: message };
        }
        setConfigured(true);
        return { success: true };
      } catch {
        const message = 'Network error';
        setError(message);
        return { success: false, error: message };
      } finally {
        setSaving(false);
      }
    },
    [endpoint],
  );

  const deleteKey = useCallback(async (): Promise<MutationResult> => {
    setSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch(endpoint, { method: 'DELETE' });
      if (!response.ok) {
        const message = await readError(response, 'Failed to remove API key');
        setError(message);
        return { success: false, error: message };
      }
      setConfigured(false);
      return { success: true };
    } catch {
      const message = 'Network error';
      setError(message);
      return { success: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [endpoint]);

  return { configured, loading, saving, error, refresh, saveKey, deleteKey };
}
