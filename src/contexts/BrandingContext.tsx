import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../utils/api';

/**
 * App-wide branding (custom logo + title).
 *
 * The values are stored server-side in `app_config` (application-level, shared
 * across all users) and fetched once when the app mounts — from a PUBLIC,
 * non-sensitive endpoint, so the pre-auth screens (login/setup/splash) already
 * show the custom identity. When either value is null the UI falls back to its
 * built-in default (the inline SVG logo and the i18n `app.title`).
 */
export type Branding = {
  title: string | null;
  logoUrl: string | null;
  /** Show the uploaded logo alone (wordmark mode) instead of icon + title. */
  logoOnly: boolean;
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
  const [branding, setBranding] = useState<Branding>({ title: null, logoUrl: null, logoOnly: false });
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
        logoOnly: data?.logoOnly === true,
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

  // Apply the custom identity to the document chrome (tab title + favicon) as
  // soon as branding resolves, so the very first thing a visitor sees — even on
  // the pre-auth login/setup screens — is the custom brand, not the default
  // values baked into index.html. When no custom value is set we leave the
  // static defaults untouched.
  useEffect(() => {
    if (isLoading || typeof document === 'undefined') {
      return;
    }
    if (branding.title) {
      document.title = branding.title;
    }
    if (branding.logoUrl) {
      // Replace the static favicon links with the uploaded logo (all allowed
      // upload formats — png/jpg/webp/svg — are valid favicon sources in
      // current browsers). apple-touch-icon links are left alone: iOS needs
      // fixed-size PNGs and falls back gracefully.
      document.head.querySelectorAll('link[rel="icon"]').forEach((node) => node.remove());
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = branding.logoUrl;
      document.head.appendChild(link);
    }
  }, [branding.title, branding.logoUrl, isLoading]);

  return (
    <BrandingContext.Provider value={{ ...branding, isLoading, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}
