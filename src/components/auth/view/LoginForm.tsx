import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { IS_PLATFORM } from '../../../constants/config';
import { useBranding } from '../../../contexts/BrandingContext';
import { useAuth } from '../context/AuthContext';
import { useWebAuthn } from '../hooks/useWebAuthn';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * Login form component.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 *
 * When the browser supports WebAuthn (and we are not on the platform build),
 * a secondary "sign in with a passkey" button is offered above the password
 * form (C-PK-2). Password sign-in remains the default path; user-cancelled
 * passkey prompts are silent by design.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { login } = useAuth();
  const { isSupported: isPasskeySupported, loginWithPasskey } = useWebAuthn();
  // Custom branding title (if configured) is interpolated into the description
  // copy (`{{appName}}`) so the login screen never names the stock product.
  const { title: brandingTitle } = useBranding();
  const appName = brandingTitle ?? t('app.title', { ns: 'sidebar', defaultValue: 'CloudCLI' });

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeySubmitting, setIsPasskeySubmitting] = useState(false);

  const showPasskeyButton = isPasskeySupported && !IS_PLATFORM;
  const isBusy = isSubmitting || isPasskeySubmitting;

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  const handlePasskeyLogin = useCallback(async () => {
    setErrorMessage('');
    setIsPasskeySubmitting(true);
    const result = await loginWithPasskey();
    setIsPasskeySubmitting(false);

    // A dismissed passkey prompt is not an error — stay silent.
    if (!result.success && result.kind !== 'cancelled') {
      setErrorMessage(
        result.kind === 'network' ? t('login.errors.networkError') : t('passkey.errors.failed'),
      );
    }
  }, [loginWithPasskey, t]);

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description', { appName })}
      footerText={t('login.footer')}
    >
      {showPasskeyButton && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={handlePasskeyLogin}
            disabled={isBusy}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 font-medium text-foreground transition-colors duration-200 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            {isPasskeySubmitting ? t('passkey.loginLoading') : t('passkey.loginButton')}
          </button>

          <div className="flex items-center gap-3" aria-hidden>
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase text-muted-foreground">{t('passkey.divider')}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isBusy}
          autoComplete="username"
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isBusy}
          type="password"
          autoComplete="current-password"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isBusy}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? t('login.loading') : t('login.submit')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
