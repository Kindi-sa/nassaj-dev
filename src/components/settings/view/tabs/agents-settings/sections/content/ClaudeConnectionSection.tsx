import { useCallback, useState } from 'react';

import { useAuth } from '../../../../../../auth';
import { useClaudeConnection } from '../../../../../hooks/useClaudeConnection';
import type { AuthStatus } from '../../../../../types/types';

import AccountContent, { type UserCredentialLink } from './AccountContent';
import ClaudeSetupTokenModal from './ClaudeSetupTokenModal';

type ClaudeConnectionSectionProps = {
  authStatus: AuthStatus;
  onLogin: () => void;
};

/**
 * Claude Account view with the per-user subscription link merged in
 * [C-MU-UX-AGENT-CREDS]. Thin stateful wrapper: it owns the
 * `useClaudeConnection` fetch (B-MU-ONBOARD) and the `claude setup-token`
 * terminal modal, and renders the single unified credential card
 * (`AccountContent`) so connection state appears exactly once per agent.
 *
 * Onboarding flow (non-owner, not linked): the card shows a warning banner
 * with a "Link Claude account" CTA that opens the terminal modal running
 * `claude setup-token`; status is re-checked when the process exits and via
 * the explicit Re-check button. The owner is symbolically linked by the
 * backend and never forced through the flow.
 */
export default function ClaudeConnectionSection({ authStatus, onLogin }: ClaudeConnectionSectionProps) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const { connected, loading, error, refresh } = useClaudeConnection(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openModal = useCallback(() => setIsModalOpen(true), []);
  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // Re-check status when the terminal process exits (setup-token finished).
  const handleProcessComplete = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleRecheck = useCallback(() => {
    void refresh();
  }, [refresh]);

  const userLink: UserCredentialLink = {
    connected,
    loading,
    error,
    isOwner,
    i18nPrefix: 'claudeConnection',
    command: 'claude setup-token',
    onLink: openModal,
    onRecheck: handleRecheck,
  };

  return (
    <>
      <AccountContent
        agent="claude"
        authStatus={authStatus}
        onLogin={onLogin}
        userLink={userLink}
      />

      <ClaudeSetupTokenModal
        isOpen={isModalOpen}
        onClose={closeModal}
        onComplete={handleProcessComplete}
      />
    </>
  );
}
