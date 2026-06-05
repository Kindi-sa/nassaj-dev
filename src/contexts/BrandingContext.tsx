import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../utils/api';

/**
 * App-wide branding (custom logo + title).
 *
 * The values are stored server-side in `app_config` (application-level, shared
 * across all users) and fetched once when the authenticated shell mounts. When
 * either value is null the UI falls back to its built-in default (the inline SVG
 * logo and the i18n `app.title`).
 */
export type Branding = {
  title: string | null;
  logoUrl: string | null;
};

type BrandingContextValue = Branding & {
  /** True while the initial fetch is in flight. */
  isLoading: boolean;
  /** Re-fetch from the server (used after an owner edits branding). */
  refresh: () => Promise<void>;
};

const BrandingContext = createContext<BrandingContextValue | null>(null);

export const useBranding = (): BrandingContextValue => {
  const ctx = useContext(BrandingContext);
  if (!ctx) {
    throw new Error('useBranding must be used within a BrandingProvider');
  }
  return ctx;
};

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>({ title: null, logoUrl: null });
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await api.branding.get();
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      setBranding({
        title: typeof data?.title === 'string' && data.title.length > 0 ? data.title : null,
        logoUrl: typeof data?.logoUrl === 'string' && data.logoUrl.length > 0 ? data.logoUrl : null,
      });
    } catch {
      // Network/parse failure: keep defaults so the header still renders.
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <BrandingContext.Provider value={{ ...branding, isLoading, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}
