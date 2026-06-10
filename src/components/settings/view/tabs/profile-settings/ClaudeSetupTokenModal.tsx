import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import StandaloneShell from '../../../../standalone-shell/view/StandaloneShell';
import { DEFAULT_PROJECT_FOR_EMPTY_SHELL } from '../../../../../constants/config';

/** The approved registration command that writes the credential into the
 *  caller's isolated per-user directory (PTY injects the isolated env). */
const SETUP_TOKEN_COMMAND = 'claude setup-token';

type ClaudeSetupTokenModalProps = {
  isOpen: boolean;
  onClose: () => void;
  /** Called when the `claude setup-token` process exits, so the caller can
   *  re-check the connection status. */
  onComplete?: (exitCode: number) => void;
};

/**
 * Guided onboarding for linking the current user's own Claude subscription.
 *
 * Reuses the existing terminal stack (`StandaloneShell` → `Shell`, the same
 * component `ProviderLoginModal` uses for CLI logins). The shell auto-runs
 * `claude setup-token`, which opens the OAuth flow and writes the credential
 * into the user's isolated directory. On process exit we surface a "verify"
 * affordance via `onComplete` so the parent can refresh the status indicator.
 *
 * The terminal itself is LTR (CLI output is English/ANSI); the surrounding
 * chrome and instructions are RTL Arabic.
 */
export default function ClaudeSetupTokenModal({ isOpen, onClose, onComplete }: ClaudeSetupTokenModalProps) {
  const { t } = useTranslation('settings');

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-card shadow-xl max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-semibold text-foreground">
            {t('claudeConnection.modal.title')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('claudeConnection.modal.close')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Instructions */}
        <div className="flex-shrink-0 border-b border-border bg-muted/30 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {t('claudeConnection.modal.instructions')}{' '}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {SETUP_TOKEN_COMMAND}
            </code>
            {'. '}
            {t('claudeConnection.modal.afterComplete')}
          </p>
        </div>

        {/* Terminal — LTR, runs the setup-token command */}
        <div className="min-h-0 flex-1" dir="ltr">
          <StandaloneShell
            project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
            command={SETUP_TOKEN_COMMAND}
            onComplete={onComplete}
            minimal
          />
        </div>
      </div>
    </div>
  );
}
