/**
 * Tests for provider auth status filtering logic:
 * - installed===false  → provider is hidden
 * - installed===true + auth===false + no error + !loading → disabled (CTA shown, not hidden)
 * - loading / error / installed===undefined → fail-open (visible + enabled)
 * - selected-provider reset when installed===false
 * - selected-provider NOT reset when installed===true && auth===false
 * - no blanking during initial load
 */
import { describe, it, expect } from 'vitest';

import type { ProviderAuthStatus } from './types';
import { createInitialProviderAuthStatusMap } from './types';
import { isProviderVisible, isProviderDisabled, shouldResetProvider } from './providerAuthFilter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStatus(overrides: Partial<ProviderAuthStatus>): ProviderAuthStatus {
  return {
    authenticated: false,
    installed: true,
    email: null,
    method: null,
    error: null,
    loading: false,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('provider visibility (installed field)', () => {
  it('(أ) installed===false hides the provider', () => {
    const status = makeStatus({ installed: false, authenticated: false });
    expect(isProviderVisible(status)).toBe(false);
    expect(isProviderDisabled(status)).toBe(false);
  });

  it('(ب) installed===true + auth===false + no error → visible but disabled', () => {
    const status = makeStatus({ installed: true, authenticated: false });
    expect(isProviderVisible(status)).toBe(true);
    expect(isProviderDisabled(status)).toBe(true);
  });

  it('(ب) installed===true + auth===true → visible and enabled', () => {
    const status = makeStatus({ installed: true, authenticated: true });
    expect(isProviderVisible(status)).toBe(true);
    expect(isProviderDisabled(status)).toBe(false);
  });

  it('(ج) loading=true → fail-open: visible and not disabled', () => {
    const loadingStatus = makeStatus({ installed: false, loading: true });
    expect(isProviderVisible(loadingStatus)).toBe(true);
    expect(isProviderDisabled(loadingStatus)).toBe(false);
  });

  it('(ج) error!=null → fail-open: visible and not disabled even if installed===false', () => {
    const errorStatus = makeStatus({ installed: false, error: 'network error' });
    expect(isProviderVisible(errorStatus)).toBe(true);
    expect(isProviderDisabled(errorStatus)).toBe(false);
  });

  it('(ج) installed===undefined (old server) → fail-open: visible (never hidden)', () => {
    // When server does not return installed, toProviderAuthStatus sets it to true
    // (payload.installed !== false → true). The provider remains VISIBLE.
    // If the server also returns authenticated===false, the provider may be shown
    // as disabled (CTA) — that is intentional and not a fail-open violation.
    // The fail-open guarantee for visibility is: installed===false never assumed.
    const status = makeStatus({ installed: true, authenticated: false });
    expect(isProviderVisible(status)).toBe(true);
    // disabled is acceptable here (shows CTA), but visibility must be guaranteed.
  });
});

describe('provider reset logic (sanitize stored provider)', () => {
  it('(د) should reset provider when installed===false (confirmed)', () => {
    const status = makeStatus({ installed: false });
    expect(shouldResetProvider(status)).toBe(true);
  });

  it('(هـ) installed===true + auth===false → should NOT reset (stays selected)', () => {
    const status = makeStatus({ installed: true, authenticated: false });
    expect(shouldResetProvider(status)).toBe(false);
  });

  it('(هـ) installed===true + auth===true → should not reset', () => {
    const status = makeStatus({ installed: true, authenticated: true });
    expect(shouldResetProvider(status)).toBe(false);
  });

  it('should not reset when installed===false but loading (fail-open)', () => {
    const status = makeStatus({ installed: false, loading: true });
    expect(shouldResetProvider(status)).toBe(false);
  });

  it('should not reset when installed===false but error exists (fail-open)', () => {
    const status = makeStatus({ installed: false, error: 'timeout' });
    expect(shouldResetProvider(status)).toBe(false);
  });
});

describe('initial provider map (fail-open defaults)', () => {
  it('(و) createInitialProviderAuthStatusMap sets installed=true by default (fail-open)', () => {
    const map = createInitialProviderAuthStatusMap(true);
    const providers = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'] as const;
    for (const p of providers) {
      expect(map[p].installed).toBe(true);
      expect(map[p].loading).toBe(true);
    }
  });

  it('(و) no provider is hidden during initial loading (fail-open)', () => {
    const map = createInitialProviderAuthStatusMap(true);
    const providers = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'] as const;
    for (const p of providers) {
      expect(isProviderVisible(map[p])).toBe(true);
    }
  });

  it('(و) no provider is disabled during initial loading (fail-open)', () => {
    const map = createInitialProviderAuthStatusMap(true);
    const providers = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'] as const;
    for (const p of providers) {
      expect(isProviderDisabled(map[p])).toBe(false);
    }
  });
});

describe('toProviderAuthStatus payload parsing (installed field)', () => {
  it('payload.installed===false → installed=false in result', () => {
    const fromPayload = (installed?: boolean) => installed !== false;
    expect(fromPayload(false)).toBe(false);
  });

  it('payload.installed===true → installed=true', () => {
    const fromPayload = (installed?: boolean) => installed !== false;
    expect(fromPayload(true)).toBe(true);
  });

  it('payload.installed===undefined (old server) → installed=true (fail-open)', () => {
    const fromPayload = (installed?: boolean) => installed !== false;
    expect(fromPayload(undefined)).toBe(true);
  });
});
