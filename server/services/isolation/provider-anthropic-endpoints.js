/**
 * provider-anthropic-endpoints — the Anthropic-compatible base URLs for the
 * "Claude engine on a vendor endpoint" path (ADR-037).
 *
 * Distinct from the hosted-vendor RUN seam (kimi/deepseek/glm independent HTTP
 * clients, ADR-036): here the Claude Agent SDK itself is pointed at a vendor's
 * Anthropic-compatible endpoint by setting ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 * on the spawn env. That is the OPPOSITE of the iron rule's default posture, so it
 * is only ever done for an explicit, per-user-keyed engine provider and is fenced
 * by anthropic-base-url-guard.js.
 *
 * This module is intentionally a pure data/constants module with no I/O and no
 * dependency on the vendor RUN seam — it is NOT part of SEAM_FILES in
 * iron-rule-guard.test.ts. It only declares which hostnames are legitimate for
 * each engine provider and which host is the official Anthropic API.
 *
 * The endpoints mirror the vendor RUN seam's base URLs (vendor-config.ts:36-38)
 * so a provider routed through either path reaches the same vendor host.
 *
 * @typedef {'kimi'|'deepseek'|'glm'} EngineProvider
 */

/**
 * Maps each engine provider to its Anthropic-compatible base URL. The Claude
 * Agent SDK reads ANTHROPIC_BASE_URL to choose the endpoint; these are the only
 * non-official hosts the guard will accept when the provider is engaged.
 * @type {Readonly<Record<EngineProvider, string>>}
 */
export const PROVIDER_ANTHROPIC_ENDPOINT = Object.freeze({
  kimi: 'https://api.moonshot.ai/anthropic',
  deepseek: 'https://api.deepseek.com/anthropic',
  glm: 'https://api.z.ai/api/anthropic',
});

/**
 * The set of provider ids that can drive the Claude engine over a vendor
 * endpoint. Derived from PROVIDER_ANTHROPIC_ENDPOINT so the two never drift.
 * @type {ReadonlySet<string>}
 */
export const ENGINE_PROVIDERS = new Set(Object.keys(PROVIDER_ANTHROPIC_ENDPOINT));

/**
 * The hostnames that are always allowed for any *_BASE_URL: the official
 * Anthropic API. Any other host must be explicitly justified (an engaged engine
 * provider, a Bedrock/Vertex escape hatch, or the operator allow-list) or the
 * guard rejects it fail-closed.
 * @type {ReadonlySet<string>}
 */
export const OFFICIAL_ANTHROPIC_HOSTS = new Set(['api.anthropic.com']);
