import { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import { useAuth } from '../../../../auth';
import SettingsSection from '../../SettingsSection';
import { useAgyConnection } from '../../../hooks/useAgyConnection';

import AgySetupModal from './AgySetupModal';

/**
 * "Antigravity (agy) subscription" section of the personal Profile tab.
 * Mirror of `ClaudeConnectionSection`.
 *
 * Shows whether the current user has linked their own agy credential and, when
 * not linked, drives a guided onboarding flow:
 *  1. a warning banner explaining isolation requires a personal link,
 *  2. a "Link Antigravity account" button that opens the terminal running
 *     `agy` (which launches OAuth when no valid token exists),
 *  3. an explicit "I've verified" re-check (plus an automatic re-check when the
 *     terminal process exits).
 *
 * The owner is symbolically linked by the backend, so the endpoint reports
 * `connected: true` and no onboarding CTA is shown — they are never forced
 * through the flow.
 */
export default function AgyConnectionSection() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const { connected, loading, error, refresh } = useAgyConnection(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openModal = useCallback(() => setIsModalOpen(true), []);
  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // Re-check status when the terminal process exits (agy login finished).
  const handleProcessComplete = useCallback(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingsSection
      title={t('agyConnection.title')}
      description={t('agyConnection.description')}
    >
      {/* Status indicator */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-foreground">
          {t('agyConnection.statusLabel')}
        </span>

        {loading ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t('agyConnection.checking')}
          </span>
        ) : connected ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-700 dark:bg-green-900/20 dark:text-green-400"
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {t('agyConnection.connected')}
          </span>
        ) : (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            {t('agyConnection.notConnected')}
          </span>
        )}

        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
          <span className="ms-1.5">{t('agyConnection.recheck')}</span>
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('agyConnection.loadError')}
        </p>
      )}

      {/* Onboarding banner + CTA — only when not connected (owner is auto-linked) */}
      {!loading && !connected && !isOwner && (
        <div
          role="alert"
          className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/15"
        >
          <p className="text-sm text-amber-800 dark:text-amber-300">
            {t('agyConnection.banner')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('agyConnection.bannerHint')}{' '}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              agy
            </code>
            .
          </p>
          <Button type="button" size="sm" onClick={openModal}>
            <Link2 className="h-4 w-4" aria-hidden />
            <span className="ms-1.5">{t('agyConnection.linkButton')}</span>
          </Button>
        </div>
      )}

      {/* Owner note: linked automatically, no action required */}
      {!loading && isOwner && connected && (
        <p className="text-sm text-muted-foreground">{t('agyConnection.ownerNote')}</p>
      )}

      <AgySetupModal
        isOpen={isModalOpen}
        onClose={closeModal}
        onComplete={handleProcessComplete}
      />
    </SettingsSection>
  );
}
