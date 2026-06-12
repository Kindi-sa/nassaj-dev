import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff, Loader2, Upload } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { useAuth } from '../../../auth';
import { useBranding } from '../../../../contexts/BrandingContext';
import { api } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

const TITLE_MAX_LENGTH = 60;
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — must match the server limit.
// Raster formats are validated by magic bytes on the server; SVG is detected by
// XML content and sanitized server-side (DOMPurify) before storage, then served
// under a strict CSP + nosniff. These client lists only pre-check the selection.
//
// The logo inputs deliberately carry NO `accept` attribute: modern Chromium on
// Android maps any image-flavoured accept (MIME types AND extensions alike) to
// the system Photo Picker, which cannot show SVG files at all. Omitting accept
// is the only reliable way to get the general document picker on Android; on
// iOS/desktop it merely shows an unfiltered file dialog, which is acceptable.
const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];

type Status = { kind: 'idle' | 'success' | 'error'; message?: string };

export default function BrandingSettingsTab() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const { title, logoUrl, logoDarkUrl, logoOnly, splashHideTitle, refresh } = useBranding();

  const isOwner = user?.role === 'owner';
  const defaultTitle = t('app.title', { ns: 'sidebar', defaultValue: 'CloudCLI' });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const darkFileInputRef = useRef<HTMLInputElement>(null);
  const [titleValue, setTitleValue] = useState(title ?? '');
  const [titleStatus, setTitleStatus] = useState<Status>({ kind: 'idle' });
  const [titleSaving, setTitleSaving] = useState(false);

  const [logoStatus, setLogoStatus] = useState<Status>({ kind: 'idle' });
  const [logoBusy, setLogoBusy] = useState(false);

  const [logoDarkStatus, setLogoDarkStatus] = useState<Status>({ kind: 'idle' });
  const [logoDarkBusy, setLogoDarkBusy] = useState(false);

  const [logoOnlyStatus, setLogoOnlyStatus] = useState<Status>({ kind: 'idle' });
  const [logoOnlyBusy, setLogoOnlyBusy] = useState(false);

  const [splashHideTitleStatus, setSplashHideTitleStatus] = useState<Status>({ kind: 'idle' });
  const [splashHideTitleBusy, setSplashHideTitleBusy] = useState(false);

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

  const handleLogoSelected = (variant: 'light' | 'dark') => async (event: React.ChangeEvent<HTMLInputElement>) => {
    const setStatus = variant === 'dark' ? setLogoDarkStatus : setLogoStatus;
    const setBusy = variant === 'dark' ? setLogoDarkBusy : setLogoBusy;

    const file = event.target.files?.[0];
    // Reset the input so re-selecting the same file fires change again.
    event.target.value = '';
    if (!file) return;

    // Document pickers may report an empty or generic MIME type (e.g.
    // application/octet-stream) for perfectly valid files, so accept when
    // EITHER the MIME type OR the extension matches. The server has the final
    // word: it validates raster formats by magic bytes and SVG by XML content.
    const hasAcceptedType =
      ACCEPTED_MIME.includes(file.type) ||
      ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!hasAcceptedType) {
      setStatus({ kind: 'error', message: t('brandingSettings.errorType') });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setStatus({ kind: 'error', message: t('brandingSettings.errorSize') });
      return;
    }

    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      const response = await api.branding.uploadLogo(file, variant);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || t('brandingSettings.errorGeneric'));
      }
      await refresh();
      setStatus({ kind: 'success', message: t('brandingSettings.savedLogo') });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : t('brandingSettings.errorGeneric'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleLogoOnlyChange = async (value: boolean) => {
    setLogoOnlyBusy(true);
    setLogoOnlyStatus({ kind: 'idle' });
    try {
      const response = await api.branding.updateLogoOnly(value);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || t('brandingSettings.errorGeneric'));
      }
      await refresh();
      setLogoOnlyStatus({ kind: 'success', message: t('brandingSettings.savedLogoOnly') });
    } catch (error) {
      setLogoOnlyStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : t('brandingSettings.errorGeneric'),
      });
    } finally {
      setLogoOnlyBusy(false);
    }
  };

  const handleSplashHideTitleChange = async (value: boolean) => {
    setSplashHideTitleBusy(true);
    setSplashHideTitleStatus({ kind: 'idle' });
    try {
      const response = await api.branding.updateSplashHideTitle(value);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || t('brandingSettings.errorGeneric'));
      }
      await refresh();
      setSplashHideTitleStatus({ kind: 'success', message: t('brandingSettings.savedSplash') });
    } catch (error) {
      setSplashHideTitleStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : t('brandingSettings.errorGeneric'),
      });
    } finally {
      setSplashHideTitleBusy(false);
    }
  };

  const handleRemoveLogo = (variant: 'light' | 'dark') => async () => {
    const setStatus = variant === 'dark' ? setLogoDarkStatus : setLogoStatus;
    const setBusy = variant === 'dark' ? setLogoDarkBusy : setLogoBusy;

    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      const response = await api.branding.deleteLogo(variant);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || t('brandingSettings.errorGeneric'));
      }
      await refresh();
      setStatus({ kind: 'success', message: t('brandingSettings.removedLogo') });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : t('brandingSettings.errorGeneric'),
      });
    } finally {
      setBusy(false);
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
                  className="hidden"
                  onChange={handleLogoSelected('light')}
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
                    onClick={handleRemoveLogo('light')}
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

      {/* Dark-theme logo variant */}
      <SettingsSection
        title={t('brandingSettings.logoDarkSection.label')}
        description={t('brandingSettings.logoDarkSection.description')}
      >
        <SettingsCard className="p-4">
          <div className="flex items-center gap-4">
            {/* Preview on a dark backdrop so a light-on-dark logo is judgeable */}
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-zinc-900">
              {logoDarkUrl ? (
                <img
                  src={logoDarkUrl}
                  alt={t('brandingSettings.logoSection.previewAlt')}
                  className="h-full w-full object-contain"
                />
              ) : (
                <ImageOff className="h-6 w-6 text-zinc-400" aria-hidden="true" />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <input
                  ref={darkFileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleLogoSelected('dark')}
                  aria-label={t('brandingSettings.logoDarkSection.uploadAria')}
                />
                <Button
                  variant="outline"
                  onClick={() => darkFileInputRef.current?.click()}
                  disabled={!isOwner || logoDarkBusy}
                >
                  {logoDarkBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {t('brandingSettings.logoDarkSection.uploadButton')}
                </Button>
                {logoDarkUrl && (
                  <Button
                    variant="ghost"
                    onClick={handleRemoveLogo('dark')}
                    disabled={!isOwner || logoDarkBusy}
                  >
                    {t('brandingSettings.logoSection.removeButton')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('brandingSettings.logoDarkSection.hint')}
              </p>
            </div>
          </div>

          {logoDarkStatus.kind !== 'idle' && (
            <p className={`mt-3 text-xs ${statusClass(logoDarkStatus)}`} role="status">
              {logoDarkStatus.message}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Logo-only (wordmark) mode */}
      <SettingsSection
        title={t('brandingSettings.logoOnlySection.label')}
        description={t('brandingSettings.logoOnlySection.description')}
      >
        <SettingsCard className="p-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">
              {t('brandingSettings.logoOnlySection.toggleLabel')}
            </p>
            <SettingsToggle
              checked={logoOnly}
              onChange={handleLogoOnlyChange}
              ariaLabel={t('brandingSettings.logoOnlySection.toggleLabel')}
              disabled={!isOwner || !logoUrl || logoOnlyBusy}
            />
          </div>
          {!logoUrl && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('brandingSettings.logoOnlySection.needsLogo')}
            </p>
          )}
          {logoOnlyStatus.kind !== 'idle' && (
            <p className={`mt-2 text-xs ${statusClass(logoOnlyStatus)}`} role="status">
              {logoOnlyStatus.message}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Splash screen: hide the app name and show only the logo */}
      <SettingsSection
        title={t('brandingSettings.splashSection.label')}
        description={t('brandingSettings.splashSection.description')}
      >
        <SettingsCard className="p-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">
              {t('brandingSettings.splashSection.toggleLabel')}
            </p>
            <SettingsToggle
              checked={splashHideTitle}
              onChange={handleSplashHideTitleChange}
              ariaLabel={t('brandingSettings.splashSection.toggleLabel')}
              disabled={!isOwner || !logoUrl || splashHideTitleBusy}
            />
          </div>
          {!logoUrl && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('brandingSettings.logoOnlySection.needsLogo')}
            </p>
          )}
          {splashHideTitleStatus.kind !== 'idle' && (
            <p className={`mt-2 text-xs ${statusClass(splashHideTitleStatus)}`} role="status">
              {splashHideTitleStatus.message}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
