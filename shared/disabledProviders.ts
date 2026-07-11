/**
 * disabledProviders.ts — the single source of truth for globally disabled
 * providers (T-864, owner decision 2026-07-11).
 *
 * المصدر الوحيد لقائمة المزوّدات المعطَّلة على مستوى التطبيق كله: تُخفى من
 * الواجهة (شاشة اختيار المزوّد، شريط إعدادات الوكلاء، جلب النماذج، أي CTA
 * مصادقة) ويرفض السيرفر إطلاق تشغيلات جديدة لها. الجلسات التاريخية تبقى
 * مقروءة — التعطيل يمنع الجديد ولا يمحو القديم.
 *
 * This file lives in the top-level `shared/` directory on purpose: it is the
 * only tree compiled into BOTH bundles (the server tsconfig includes
 * `../shared/**` and emits it into `dist-server/shared/`; the Vite root is the
 * project root so the client imports it directly). Disabling — not deleting —
 * keeps upstream sync and reversibility: to re-enable a provider, remove its
 * id from this list. The provider implementations, `resolve-provider-env`
 * cases and `<provider>-cli.js` files stay in place as dormant code.
 *
 * Rationale per id: `gemini` is superseded by Antigravity (agy, which stays
 * enabled); `kimi`/`deepseek`/`glm` are plain API vendors, not agent
 * environments. Untouched: claude, opencode, antigravity, cursor, codex,
 * hermes.
 *
 * NOTE: the provider registry itself is NOT filtered — `resolveProvider` must
 * keep returning disabled providers so historical sessions stay listable and
 * readable (sessions.service fetchHistory/normalizeMessage, synchronizers).
 * Enforcement happens at the spawn/dispatch seam only.
 */
export const DISABLED_PROVIDERS = ['gemini', 'kimi', 'deepseek', 'glm'] as const;

export type DisabledProviderId = (typeof DISABLED_PROVIDERS)[number];

/** True when the provider id is globally disabled (hidden + spawn-blocked). */
export function isProviderGloballyDisabled(provider: string): boolean {
  return (DISABLED_PROVIDERS as readonly string[]).includes(provider);
}

/** Returns the list without the globally disabled providers (order preserved). */
export function filterDisabledProviders<T extends string>(providers: readonly T[]): T[] {
  return providers.filter((provider) => !isProviderGloballyDisabled(provider));
}
