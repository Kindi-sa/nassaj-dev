import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useBranding } from '../../../contexts/BrandingContext';

const loadingDotAnimationDelays = ['0s', '0.1s', '0.2s'];

/**
 * First-paint splash shown while the auth status is being resolved.
 * Carries the custom branding (logo + title) when configured; while branding is
 * still loading it shows a neutral placeholder instead of flashing the stock
 * name for a frame.
 */
export default function AuthLoadingScreen() {
  const { t } = useTranslation('sidebar');
  const { title: brandingTitle, logoUrl: brandingLogoUrl, isLoading: isBrandingLoading } = useBranding();

  // The placeholder is U+00A0 so the heading keeps its line box while loading.
  const displayTitle = isBrandingLoading
    ? ' '
    : brandingTitle ?? t('app.title', { defaultValue: 'CloudCLI' });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="text-center">
        <div className="mb-4 flex justify-center">
          {brandingLogoUrl ? (
            <img src={brandingLogoUrl} alt="" className="h-16 w-16 rounded-lg object-contain" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary shadow-sm">
              <MessageSquare className="h-8 w-8 text-primary-foreground" />
            </div>
          )}
        </div>

        <h1 className="mb-2 text-2xl font-bold text-foreground">{displayTitle}</h1>

        <div className="flex items-center justify-center space-x-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full"
              style={{ animationDelay: delay, backgroundColor: 'hsl(var(--brand-accent, var(--primary)))' }}
            />
          ))}
        </div>

        <p className="mt-2 text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}
