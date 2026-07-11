/**
 * Tests for the globally-disabled-providers seam (T-864,
 * shared/disabledProviders.ts — the single source of truth):
 * - the disabled set is exactly gemini/kimi/deepseek/glm (owner decision);
 * - the enabled set (claude/opencode/antigravity/cursor/codex/hermes) is intact;
 * - CLI_PROVIDERS (auth-status probe fan-out) contains no disabled provider;
 * - ENABLED_VENDOR_PROVIDERS is empty while all three vendors are disabled,
 *   and VENDOR_PROVIDERS itself stays complete (historical session rendering
 *   and type guards must keep recognizing the ids);
 * - sanitizeStoredProvider never revives a persisted disabled selection;
 * - filterDisabledProviders preserves order and does not mutate its input.
 */
import { describe, it, expect } from 'vitest';

import {
  DISABLED_PROVIDERS,
  filterDisabledProviders,
  isProviderGloballyDisabled,
} from '../../../shared/disabledProviders';
import { DEFAULT_PROVIDER, sanitizeStoredProvider } from '../../constants/providerModelFallbacks';

import { CLI_PROVIDERS } from './types';
import { ENABLED_VENDOR_PROVIDERS, VENDOR_PROVIDERS, isVendorProvider } from './vendorProviders';

describe('shared/disabledProviders — single source of truth', () => {
  it('disables exactly gemini, kimi, deepseek and glm', () => {
    expect([...DISABLED_PROVIDERS].sort()).toEqual(['deepseek', 'gemini', 'glm', 'kimi']);
  });

  it('keeps the six enabled providers untouched', () => {
    for (const provider of ['claude', 'opencode', 'antigravity', 'cursor', 'codex', 'hermes']) {
      expect(isProviderGloballyDisabled(provider)).toBe(false);
    }
  });

  it('filterDisabledProviders preserves order and does not mutate its input', () => {
    const input = ['claude', 'gemini', 'cursor', 'kimi', 'hermes'];
    const output = filterDisabledProviders(input);
    expect(output).toEqual(['claude', 'cursor', 'hermes']);
    expect(input).toHaveLength(5);
  });
});

describe('CLI_PROVIDERS — auth-status probe fan-out', () => {
  it('contains no globally disabled provider (no probe, no login CTA)', () => {
    for (const provider of DISABLED_PROVIDERS) {
      expect(CLI_PROVIDERS).not.toContain(provider);
    }
  });

  it('still probes the enabled providers', () => {
    expect(CLI_PROVIDERS).toEqual([
      'claude',
      'cursor',
      'codex',
      'antigravity',
      'opencode',
      'hermes',
    ]);
  });
});

describe('vendor providers — engine groups and key-status fan-out', () => {
  it('ENABLED_VENDOR_PROVIDERS is empty while all three vendors are disabled', () => {
    expect(ENABLED_VENDOR_PROVIDERS).toEqual([]);
  });

  it('VENDOR_PROVIDERS stays complete so historical ids keep resolving', () => {
    expect([...VENDOR_PROVIDERS]).toEqual(['kimi', 'deepseek', 'glm']);
    expect(isVendorProvider('kimi')).toBe(true);
  });
});

describe('sanitizeStoredProvider — persisted selection of a disabled provider', () => {
  it('falls back to the default provider for every disabled id', () => {
    for (const provider of DISABLED_PROVIDERS) {
      expect(sanitizeStoredProvider(provider)).toBe(DEFAULT_PROVIDER);
    }
  });

  it('keeps a persisted enabled provider as-is', () => {
    expect(sanitizeStoredProvider('opencode')).toBe('opencode');
    expect(sanitizeStoredProvider('hermes')).toBe('hermes');
  });
});
