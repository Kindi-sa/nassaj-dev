import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { hydratePreferencesFromServer } from '../../../preferences/preferencesSync';

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
  // Prevent checkAuthStatus from re-running immediately after a successful login/register/invite.
  // Without this flag, changing `token` state causes checkAuthStatus to be rebuilt
  // (it closes over `token`), which re-triggers the useEffect and may call clearSession()
  // before the new token is settled in all async paths.
  const skipNextAuthCheck = useRef(false);

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

  // Pull the account's synced UI preferences and apply them live (the account
  // is authoritative — decision 2), or seed the account from this device on a
  // first sign-in (decision 3). Never throws: a missing route / network error
  // degrades silently to localStorage (the route only goes live after the
  // server restart). Fire-and-forget; preferences must not gate sign-in.
  const hydratePreferences = useCallback(() => {
    void hydratePreferencesFromServer().catch((caughtError) => {
      console.error('Failed to hydrate UI preferences:', caughtError);
    });
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
    // Skip the re-check that fires immediately after login/register/invite sets a new token.
    // The login flow already validates the session via the /login response itself.
    if (skipNextAuthCheck.current) {
      skipNextAuthCheck.current = false;
      setIsLoading(false);
      return;
    }

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
        // Only clear the session on definitive auth rejection (401/403).
        // Do not clear on transient errors (5xx, network) to avoid logout loops.
        const status = userResponse.status;
        if (status === 401 || status === 403) {
          clearSession();
        } else {
          console.error('[Auth] Transient error checking auth status, keeping session:', status);
          setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
        }
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
      hydratePreferences();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      // Network error — do not clear the session, let the user retry.
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, hydratePreferences, token]);

  // Listen for 401 responses dispatched by authenticatedFetch (api.js). When
  // any endpoint rejects the token we clear the local session and redirect to
  // the login page so the user is never left in a broken "logged-in" state.
  useEffect(() => {
    if (IS_PLATFORM) return;

    const handleUnauthorized = () => {
      clearSession();
      // Defense-in-depth: never hard-redirect to /login if we are already on
      // it. The session is already cleared above; a second `location.href`
      // assignment would only force a redundant full-page reload (and could
      // re-arm a reload loop if any pre-auth fetch still 401s on mount).
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('auth:unauthorized', handleUnauthorized);
    };
  }, [clearSession]);

  // Adopt a server-rotated JWT into React state. `authenticatedFetch` (api.js)
  // and the file-upload XHR persist a refreshed token to localStorage and fire
  // `auth:token-refreshed` (see applyRefreshedToken). Without pulling it into
  // state, the token-keyed WebSocket effect keeps dialing with the pre-rotation
  // token until it expires — the B-131 "random logout". Mirrors the
  // `auth:unauthorized` channel above.
  useEffect(() => {
    if (IS_PLATFORM) return;

    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<{ token?: string }>).detail?.token;
      if (!nextToken) return;
      // Persist (idempotent — the dispatcher already wrote it) then adopt into
      // state so the [token]-keyed WebSocket effect reconnects with the fresh
      // token. Skip when unchanged to avoid a redundant reconnect.
      persistToken(nextToken);
      setToken((current) => (current === nextToken ? current : nextToken));
    };

    window.addEventListener('auth:token-refreshed', handleTokenRefreshed);
    return () => {
      window.removeEventListener('auth:token-refreshed', handleTokenRefreshed);
    };
  }, []);

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

        // Prevent the token-change-driven useEffect from re-running checkAuthStatus
        // (which would call clearSession if any intermediate state is stale).
        skipNextAuthCheck.current = true;
        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await hydrateUserIdentity();
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, hydrateUserIdentity, setSession],
  );

  // Passkey sign-in (C-PK-1). The WebAuthn ceremony itself (options +
  // startAuthentication) lives in useWebAuthn; this only exchanges the
  // assertion for a session, then mirrors `login` step for step so the
  // mustChangePassword and onboarding gates engage identically.
  const loginWithPasskey = useCallback<AuthContextValue['loginWithPasskey']>(
    async (assertionResponse) => {
      try {
        setError(null);
        const response = await api.auth.webauthn.loginVerify(assertionResponse);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        // Same guard as `login`: prevent the token-change-driven useEffect from
        // re-running checkAuthStatus against a half-settled session.
        skipNextAuthCheck.current = true;
        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await hydrateUserIdentity();
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Passkey login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, hydrateUserIdentity, setSession],
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

        skipNextAuthCheck.current = true;
        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, setSession],
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

        skipNextAuthCheck.current = true;
        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Invite acceptance error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, setSession],
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
      loginWithPasskey,
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
      loginWithPasskey,
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
