import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff, Loader2, Upload } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { useAuth } from '../../../auth';
import { useBranding } from '../../../../contexts/BrandingContext';
import { api } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

const TITLE_MAX_LENGTH = 60;
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — must match the server limit.
const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

type Status = { kind: 'idle' | 'success' | 'error'; message?: string };

export default function BrandingSettingsTab() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const { title, logoUrl, refresh } = useBranding();

  const isOwner = user?.role === 'owner';
  const defaultTitle = t('app.title', { ns: 'sidebar', defaultValue: 'CloudCLI' });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [titleValue, setTitleValue] = useState(title ?? '');
  const [titleStatus, setTitleStatus] = useState<Status>({ kind: 'idle' });
  const [titleSaving, setTitleSaving] = useState(false);

  const [logoStatus, setLogoStatus] = useState<Status>({ kind: 'idle' });
  const [logoBusy, setLogoBusy] = useState(false);

  // Keep the input in sync if branding loads/changes after mount.
  useEffect(() => {
    setTitleValue(title ?? '');
  }, [title]);

  const handleSaveTitle = async () => {
    setTitleSaving(true);
    setTitleStatus({ kind: 'idle' });
    try {
      const response = await api.branding.updateTitle(titleValue);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || t('brandingSettings.errorGeneric'));
      }
      await refresh();
      setTitleStatus({ kind: 'success', message: t('brandingSettings.savedTitle') });
    } catch (error) {
      setTitleStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : t('brandingSettings.errorGeneric'),
      });
    } finally {
      setTitleSaving(false);
    }
  };

  const handleLogoSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input so re-selecting the same file fires change again.
    event.target.value = '';
    if (!file) return;

    if (!ACCEPTED_MIME.includes(file.type)) {
      setLogoStatus({ kind: 'error', message: t('brandingSettings.errorType') });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoStatus({ kind: 'error', message: t('brandingSettings.errorSize') });
      return;
    }

    setLogoBusy(true);
    setLogoStatus({ kind: 'idle' });
    try {
      const response = await api.branding.uploadLogo(file);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || t('brandingSettings.errorGeneric'));
      }
      await refresh();
      setLogoStatus({ kind: 'success', message: t('brandingSettings.savedLogo') });
    } catch (error) {
      setLogoStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : t('brandingSettings.errorGeneric'),
      });
    } finally {
      setLogoBusy(false);
    }
  };

  const handleRemoveLogo = async () => {
    setLogoBusy(true);
    setLogoStatus({ kind: 'idle' });
    try {
      const response = await api.branding.deleteLogo();
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || t('brandingSettings.errorGeneric'));
      }
      await refresh();
      setLogoStatus({ kind: 'success', message: t('brandingSettings.removedLogo') });
    } catch (error) {
      setLogoStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : t('brandingSettings.errorGeneric'),
      });
    } finally {
      setLogoBusy(false);
    }
  };

  const statusClass = (status: Status) =>
    status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground';

  return (
    <div className="space-y-8">
      {!isOwner && (
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          {t('brandingSettings.ownerOnly')}
        </p>
      )}

      {/* Title */}
      <SettingsSection
        title={t('brandingSettings.titleSection.label')}
        description={t('brandingSettings.titleSection.description')}
      >
        <SettingsCard className="p-4">
          <label
            htmlFor="branding-title"
            className="mb-2 block text-sm font-medium text-foreground"
          >
            {t('brandingSettings.titleSection.fieldLabel')}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="branding-title"
              type="text"
              dir="auto"
              maxLength={TITLE_MAX_LENGTH}
              value={titleValue}
              placeholder={defaultTitle}
              disabled={!isOwner || titleSaving}
              onChange={(event) => setTitleValue(event.target.value)}
              className="flex-1"
            />
            <Button
              onClick={handleSaveTitle}
              disabled={!isOwner || titleSaving}
              className="flex-shrink-0"
            >
              {titleSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('brandingSettings.save')}
            </Button>
          </div>
          {titleStatus.kind !== 'idle' && (
            <p className={`mt-2 text-xs ${statusClass(titleStatus)}`} role="status">
              {titleStatus.message}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Logo */}
      <SettingsSection
        title={t('brandingSettings.logoSection.label')}
        description={t('brandingSettings.logoSection.description')}
      >
        <SettingsCard className="p-4">
          <div className="flex items-center gap-4">
            {/* Preview */}
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={t('brandingSettings.logoSection.previewAlt')}
                  className="h-full w-full object-contain"
                />
              ) : (
                <ImageOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_MIME.join(',')}
                  className="hidden"
                  onChange={handleLogoSelected}
                  aria-label={t('brandingSettings.logoSection.uploadAria')}
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!isOwner || logoBusy}
                >
                  {logoBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {t('brandingSettings.logoSection.uploadButton')}
                </Button>
                {logoUrl && (
                  <Button
                    variant="ghost"
                    onClick={handleRemoveLogo}
                    disabled={!isOwner || logoBusy}
                  >
                    {t('brandingSettings.logoSection.removeButton')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('brandingSettings.logoSection.hint')}
              </p>
            </div>
          </div>

          {logoStatus.kind !== 'idle' && (
            <p className={`mt-3 text-xs ${statusClass(logoStatus)}`} role="status">
              {logoStatus.message}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
