import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { api } from '../../../utils/api';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  OnboardingStatusPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
  }, []);

  // Re-fetch the authoritative identity after sign-in. The login/invite
  // responses carry a trimmed user object (id/username/role) that omits
  // `mustChangePassword`; /api/auth/user returns the full row so the forced
  // password-change gate (F-2) can engage immediately after sign-in.
  const hydrateUserIdentity = useCallback(async () => {
    try {
      const response = await api.auth.user();
      if (!response.ok) {
        return;
      }
      const payload = await parseJsonSafely<AuthUserPayload>(response);
      if (payload?.user) {
        setUser(payload.user);
      }
    } catch (caughtError) {
      console.error('Failed to hydrate user identity:', caughtError);
    }
  }, []);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      if (!token) {
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, token]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await hydrateUserIdentity();
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydrateUserIdentity, setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const acceptInvite = useCallback<AuthContextValue['acceptInvite']>(
    async (inviteToken, username, password) => {
      try {
        setError(null);
        const response = await api.auth.acceptInvite(inviteToken, username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.inviteFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Invite acceptance error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const changePassword = useCallback<AuthContextValue['changePassword']>(
    async (currentPassword, newPassword) => {
      try {
        setError(null);
        const response = await api.auth.changePassword(currentPassword, newPassword);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.passwordChangeFailed);
          return { success: false, error: message };
        }

        // Persist the fresh token so this device stays signed in (server rotated
        // pwd_iat and would otherwise invalidate the old token), and clear the
        // forced-change gate locally — the server has already cleared it.
        setToken(payload.token);
        persistToken(payload.token);
        setUser((previous) =>
          previous ? { ...previous, mustChangePassword: false } : previous,
        );
        return { success: true };
      } catch (caughtError) {
        console.error('Password change error:', caughtError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [],
  );

  const changeUsername = useCallback<AuthContextValue['changeUsername']>(
    async (username) => {
      try {
        setError(null);
        const response = await api.auth.changeUsername(username);
        const payload = await parseJsonSafely<AuthSessionPayload & { username?: string }>(response);

        if (!response.ok) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.usernameChangeFailed);
          return { success: false, error: message };
        }

        const nextUsername = payload?.username ?? username;
        setUser((previous) => (previous ? { ...previous, username: nextUsername } : previous));
        return { success: true };
      } catch (caughtError) {
        console.error('Username change error:', caughtError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [],
  );

  // Update the avatar on the in-context user after a successful upload. The
  // upload request itself lives in the profile UI; the context only owns the
  // canonical user object, so callers reflect the new URL here.
  const updateAvatar = useCallback<AuthContextValue['updateAvatar']>((avatarUrl) => {
    setUser((previous) => (previous ? { ...previous, avatarUrl } : previous));
  }, []);

  const logout = useCallback(() => {
    const tokenToInvalidate = token;
    clearSession();

    if (tokenToInvalidate) {
      void api.auth.logout().catch((caughtError: unknown) => {
        console.error('Logout endpoint error:', caughtError);
      });
    }
  }, [clearSession, token]);

  const mustChangePassword = Boolean(user?.mustChangePassword);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      mustChangePassword,
      error,
      login,
      register,
      acceptInvite,
      changePassword,
      changeUsername,
      updateAvatar,
      logout,
      refreshOnboardingStatus,
    }),
    [
      acceptInvite,
      changePassword,
      changeUsername,
      updateAvatar,
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      mustChangePassword,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
