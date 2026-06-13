import type { ProviderAuthStatus } from './types';

/**
 * Returns true when the provider should be shown in the UI.
 * Fail-open: only hide when we have a confirmed installed===false
 * with no active error and not currently loading.
 */
export function isProviderVisible(status: ProviderAuthStatus): boolean {
  const isDefinitelyNotInstalled =
    status.installed === false && !status.loading && status.error == null;
  return !isDefinitelyNotInstalled;
}

/**
 * Returns true when the provider is visible but not authenticated
 * (show CTA, no models selectable).
 * Only fires when installed===true, auth===false, no error, not loading.
 */
export function isProviderDisabled(status: ProviderAuthStatus): boolean {
  return (
    status.installed === true &&
    !status.authenticated &&
    status.error == null &&
    !status.loading
  );
}

/**
 * Returns true when the currently selected provider should be reset
 * to a fallback because it is definitively not installed.
 * Same conditions as isProviderVisible===false.
 * Fail-open: never reset during loading or on error.
 */
export function shouldResetProvider(status: ProviderAuthStatus): boolean {
  return status.installed === false && !status.loading && status.error == null;
}
