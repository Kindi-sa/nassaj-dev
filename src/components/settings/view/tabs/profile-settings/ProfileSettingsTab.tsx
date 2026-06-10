import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Loader2, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import { useAuth } from '../../../../auth';
import { MIN_PASSWORD_LENGTH } from '../../../../auth/constants';
import { api } from '../../../../../utils/api';
import { parseJsonSafely, resolveApiErrorMessage } from '../../../../auth/utils';
import SettingsSection from '../../SettingsSection';

import FeedbackBanner from './FeedbackBanner';
import type { Feedback } from './FeedbackBanner';
import PasskeysSection from './PasskeysSection';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60';

/**
 * Profile settings tab (F-1).
 *
 * Self-service sections, available to every signed-in role:
 *  - Profile picture upload.
 *  - Change username: shows the current username (read-only) and a new value.
 *  - Change password: current + new + confirm. On success the fresh token is
 *    persisted by the auth context, so the session continues without a logout.
 *  - Passkeys: WebAuthn credential management (PasskeysSection, C-PK-3).
 *
 * Form state lives here; the actual mutations are delegated to the auth context
 * (which owns token persistence), keeping this component free of business logic.
 */
export default function ProfileSettingsTab() {
  const { t } = useTranslation('settings');
  const { user, changeUsername, changePassword, updateAvatar } = useAuth();

  const currentUsername = user?.username ?? '';
  const currentAvatarUrl = typeof user?.avatarUrl === 'string' ? user.avatarUrl : '';

  // Avatar section state.
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarFeedback, setAvatarFeedback] = useState<Feedback>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  // Track image load failure so the preview falls back to the placeholder.
  const [avatarImageFailed, setAvatarImageFailed] = useState(false);
  const showAvatarImage = Boolean(currentAvatarUrl) && !avatarImageFailed;

  // Username section state.
  const [newUsername, setNewUsername] = useState('');
  const [usernameFeedback, setUsernameFeedback] = useState<Feedback>(null);
  const [isSavingUsername, setIsSavingUsername] = useState(false);

  // Password section state.
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const openAvatarPicker = useCallback(() => {
    avatarInputRef.current?.click();
  }, []);

  const handleAvatarChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input so selecting the same file again re-triggers onChange.
      event.target.value = '';
      if (!file) {
        return;
      }

      setAvatarFeedback(null);
      setIsUploadingAvatar(true);
      try {
        const response = await api.auth.updateAvatar(file);
        const payload = await parseJsonSafely<{ avatarUrl?: string; error?: string; message?: string }>(
          response,
        );

        if (!response.ok || !payload?.avatarUrl) {
          setAvatarFeedback({
            kind: 'error',
            message: resolveApiErrorMessage(payload, t('profile.avatar.errors.uploadFailed')),
          });
          return;
        }

        updateAvatar(payload.avatarUrl);
        setAvatarImageFailed(false);
        setAvatarFeedback({ kind: 'success', message: t('profile.avatar.success') });
      } catch (caughtError) {
        console.error('Avatar upload error:', caughtError);
        setAvatarFeedback({ kind: 'error', message: t('profile.avatar.errors.network') });
      } finally {
        setIsUploadingAvatar(false);
      }
    },
    [t, updateAvatar],
  );

  const handleUsernameSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setUsernameFeedback(null);

      const next = newUsername.trim();
      if (!next) {
        setUsernameFeedback({ kind: 'error', message: t('profile.username.errors.required') });
        return;
      }
      if (next === currentUsername) {
        setUsernameFeedback({ kind: 'error', message: t('profile.username.errors.unchanged') });
        return;
      }

      setIsSavingUsername(true);
      const result = await changeUsername(next);
      setIsSavingUsername(false);

      if (!result.success) {
        setUsernameFeedback({ kind: 'error', message: result.error });
        return;
      }
      setUsernameFeedback({ kind: 'success', message: t('profile.username.success') });
      setNewUsername('');
    },
    [changeUsername, currentUsername, newUsername, t],
  );

  const handlePasswordSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPasswordFeedback(null);

      if (!currentPassword || !newPassword || !confirmPassword) {
        setPasswordFeedback({ kind: 'error', message: t('profile.password.errors.required') });
        return;
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setPasswordFeedback({
          kind: 'error',
          message: t('profile.password.errors.short', { min: MIN_PASSWORD_LENGTH }),
        });
        return;
      }
      if (newPassword !== confirmPassword) {
        setPasswordFeedback({ kind: 'error', message: t('profile.password.errors.mismatch') });
        return;
      }

      setIsSavingPassword(true);
      const result = await changePassword(currentPassword, newPassword);
      setIsSavingPassword(false);

      if (!result.success) {
        setPasswordFeedback({ kind: 'error', message: result.error });
        return;
      }
      setPasswordFeedback({ kind: 'success', message: t('profile.password.success') });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    },
    [changePassword, confirmPassword, currentPassword, newPassword, t],
  );

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('profile.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('profile.subtitle')}</p>
      </div>

      {/* Profile picture */}
      <SettingsSection
        title={t('profile.avatar.title')}
        description={t('profile.avatar.description')}
      >
        <div className="flex items-center gap-4">
          {showAvatarImage ? (
            <img
              src={currentAvatarUrl}
              alt={t('profile.avatar.currentAlt')}
              className="h-20 w-20 flex-shrink-0 rounded-full object-cover ring-2 ring-border"
              onError={() => setAvatarImageFailed(true)}
            />
          ) : (
            <div
              role="img"
              aria-label={t('profile.avatar.placeholderAlt')}
              className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-full bg-muted ring-2 ring-border"
            >
              <UserRound className="h-9 w-9 text-muted-foreground" aria-hidden />
            </div>
          )}

          <div className="space-y-2">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarChange}
              aria-hidden
              tabIndex={-1}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={openAvatarPicker}
              disabled={isUploadingAvatar}
            >
              {isUploadingAvatar && <Loader2 className="h-4 w-4 animate-spin" />}
              <span className={isUploadingAvatar ? 'ms-1.5' : undefined}>
                {isUploadingAvatar ? t('profile.avatar.uploading') : t('profile.avatar.change')}
              </span>
            </Button>
            <p className="text-xs text-muted-foreground">{t('profile.avatar.hint')}</p>
          </div>
        </div>

        <FeedbackBanner feedback={avatarFeedback} />
      </SettingsSection>

      {/* Change username */}
      <SettingsSection
        title={t('profile.username.title')}
        description={t('profile.username.description')}
      >
        <form onSubmit={handleUsernameSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="profile-current-username"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              {t('profile.username.currentLabel')}
            </label>
            <input
              id="profile-current-username"
              type="text"
              value={currentUsername}
              readOnly
              dir="ltr"
              className={`${inputClass} bg-muted text-left`}
            />
          </div>

          <div>
            <label
              htmlFor="profile-new-username"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              {t('profile.username.newLabel')}
            </label>
            <input
              id="profile-new-username"
              type="text"
              name="username"
              autoComplete="username"
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              placeholder={t('profile.username.placeholder')}
              disabled={isSavingUsername}
              dir="ltr"
              className={`${inputClass} text-left`}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('profile.username.hint')}</p>
          </div>

          <FeedbackBanner feedback={usernameFeedback} />

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={isSavingUsername}>
              {isSavingUsername && <Loader2 className="h-4 w-4 animate-spin" />}
              <span className={isSavingUsername ? 'ms-1.5' : undefined}>
                {isSavingUsername ? t('profile.saving') : t('profile.username.save')}
              </span>
            </Button>
          </div>
        </form>
      </SettingsSection>

      {/* Change password */}
      <SettingsSection
        title={t('profile.password.title')}
        description={t('profile.password.description')}
      >
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="profile-current-password"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              {t('profile.password.currentLabel')}
            </label>
            <input
              id="profile-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder={t('profile.password.currentPlaceholder')}
              disabled={isSavingPassword}
              className={inputClass}
            />
          </div>

          <div>
            <label
              htmlFor="profile-new-password"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              {t('profile.password.newLabel')}
            </label>
            <input
              id="profile-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={t('profile.password.newPlaceholder')}
              disabled={isSavingPassword}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('profile.password.hint', { min: MIN_PASSWORD_LENGTH })}
            </p>
          </div>

          <div>
            <label
              htmlFor="profile-confirm-password"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              {t('profile.password.confirmLabel')}
            </label>
            <input
              id="profile-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder={t('profile.password.confirmPlaceholder')}
              disabled={isSavingPassword}
              className={inputClass}
            />
          </div>

          <FeedbackBanner feedback={passwordFeedback} />

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={isSavingPassword}>
              {isSavingPassword && <Loader2 className="h-4 w-4 animate-spin" />}
              <span className={isSavingPassword ? 'ms-1.5' : undefined}>
                {isSavingPassword ? t('profile.saving') : t('profile.password.save')}
              </span>
            </Button>
          </div>
        </form>
      </SettingsSection>

      {/* Passkeys (C-PK-3) */}
      <PasskeysSection />
    </div>
  );
}
