/**
 * اختبارات T-900 — GovernanceBadge
 *
 * يغطّي:
 *   - null ⇒ لا عرض (fail-HIDDEN)
 *   - governed+enforced ⇒ pill زمردي، نص governed، tooltip enforced
 *   - governed+unenforced ⇒ pill زمردي مخفّف، نص governed، tooltip present
 *   - ungoverned ⇒ pill كهرماني، نص ungoverned، tooltip none
 *   - aria-label يضمّ النص والـtooltip معاً
 *
 * الـhook مُحاكى (مُغلَّف) — سلوكه مختبَر بشكل مستقل
 * في useProviderGovernance.test.ts.
 *
 * Run: npm run test:client -- src/shared/view/GovernanceBadge.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// i18n stub — يُرجع المفتاح كاملاً لتسهيل التحقق.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Hook مُحاكى — لا نريد اختبار fetch هنا.
vi.mock('../../components/chat/hooks/useProviderGovernance', () => ({
  useProviderGovernance: vi.fn(),
}));

import { useProviderGovernance } from '../../components/chat/hooks/useProviderGovernance';
import type { GovernanceDescriptor } from '../../components/chat/hooks/useProviderGovernance';
import GovernanceBadge from './GovernanceBadge';

const mockHook = vi.mocked(useProviderGovernance);

afterEach(() => {
  cleanup();
  mockHook.mockReset();
});

// ---------------------------------------------------------------------------

describe('GovernanceBadge', () => {
  it('renders nothing when descriptor is null (unknown / absent endpoint)', () => {
    mockHook.mockReturnValue(null);
    const { container } = render(<GovernanceBadge provider="claude" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders governed pill with enforced tooltip for governed+enforced', () => {
    const desc: GovernanceDescriptor = {
      provider: 'codex',
      status: 'governed',
      enforced: true,
      mechanism: 'codex-fingerprint',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="codex" />);

    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    // Label text
    expect(badge.textContent).toContain('governanceBadge.governed');
    // Tooltip (title attribute)
    expect(badge.getAttribute('title')).toBe('governanceBadge.tooltip.enforced');
  });

  it('renders governed pill with present tooltip for governed+unenforced', () => {
    const desc: GovernanceDescriptor = {
      provider: 'claude',
      status: 'governed',
      enforced: false,
      mechanism: 'claude-md',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="claude" />);

    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('governanceBadge.governed');
    expect(badge.getAttribute('title')).toBe('governanceBadge.tooltip.present');
  });

  it('renders ungoverned pill with ShieldOff text and none tooltip', () => {
    const desc: GovernanceDescriptor = {
      provider: 'hermes',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="hermes" />);

    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('governanceBadge.ungoverned');
    expect(badge.getAttribute('title')).toBe('governanceBadge.tooltip.none');
  });

  it('aria-label contains both label and tooltip text for governed+enforced', () => {
    const desc: GovernanceDescriptor = {
      provider: 'codex',
      status: 'governed',
      enforced: true,
      mechanism: 'codex-fingerprint',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="codex" />);

    const badge = screen.getByRole('status');
    const ariaLabel = badge.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('governanceBadge.governed');
    expect(ariaLabel).toContain('governanceBadge.tooltip.enforced');
  });

  it('aria-label contains both label and tooltip text for ungoverned', () => {
    const desc: GovernanceDescriptor = {
      provider: 'hermes',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="hermes" />);

    const badge = screen.getByRole('status');
    const ariaLabel = badge.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('governanceBadge.ungoverned');
    expect(ariaLabel).toContain('governanceBadge.tooltip.none');
  });

  it('renders nothing for undefined provider (no fetch)', () => {
    mockHook.mockReturnValue(null);
    const { container } = render(<GovernanceBadge provider={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
