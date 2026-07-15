/**
 * T-886 — اختبارات وضع coordinator لـCodex
 *
 * يغطّي:
 *   - ظهور 'coordinator' في قائمة أوضاع codex
 *   - غياب 'coordinator' عن قوائم المزوّدين الآخرين (claude / gemini / cursor / opencode)
 *   - تسلسل الدوران يشمل coordinator لـcodex
 *
 * الدالة مُصدَّرة لأغراض الاختبار: getPermissionModesForProvider
 *
 * Run: npm run test:client -- src/components/chat/hooks/useChatProviderState.coordinator.test.ts
 */

import { describe, it, expect } from 'vitest';
import { getPermissionModesForProvider } from './useChatProviderState';

describe('getPermissionModesForProvider — coordinator mode (T-886)', () => {
  it('includes coordinator in the codex cycle', () => {
    const modes = getPermissionModesForProvider('codex');
    expect(modes).toContain('coordinator');
  });

  it('excludes coordinator from the claude cycle', () => {
    const modes = getPermissionModesForProvider('claude');
    expect(modes).not.toContain('coordinator');
  });

  it('excludes coordinator from the gemini cycle', () => {
    const modes = getPermissionModesForProvider('gemini');
    expect(modes).not.toContain('coordinator');
  });

  it('excludes coordinator from the cursor cycle', () => {
    const modes = getPermissionModesForProvider('cursor');
    expect(modes).not.toContain('coordinator');
  });

  it('excludes coordinator from the opencode cycle', () => {
    const modes = getPermissionModesForProvider('opencode');
    expect(modes).not.toContain('coordinator');
  });

  it('codex cycle contains exactly the expected modes', () => {
    const modes = getPermissionModesForProvider('codex');
    expect(modes).toEqual(['default', 'acceptEdits', 'bypassPermissions', 'coordinator']);
  });
});
