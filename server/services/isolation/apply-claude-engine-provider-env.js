/**
 * apply-claude-engine-provider-env — points the Claude Agent SDK at a vendor's
 * Anthropic-compatible endpoint for the "Claude engine on a vendor" path (ADR-037,
 * B-ENG-2).
 *
 * This is the one place that may set ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN to
 * a non-official host, and it does so under tight constraints:
 *
 *   - Only for a provider in ENGINE_PROVIDERS; anything else is a no-op (null).
 *   - Only when a per-user key actually exists; with no key we inject NOTHING and
 *     return null, so we never produce a half-injected env (base URL set but no
 *     token, or vice-versa) that could silently break or leak.
 *   - It mutates ONLY the env object handed to it. It never reads or writes
 *     process.env — the caller owns the (already-cloned) spawn env.
 *
 * On success it returns the set of hostnames it authorized, which the caller
 * passes to assertAnthropicBaseUrlAllowed as ctx.engineProviderHosts so the guard
 * accepts exactly this endpoint and nothing else.
 *
 * @typedef {import('./provider-anthropic-endpoints.js').EngineProvider} EngineProvider
 */

import { getProviderKey } from './provider-secrets-store.js';
import { ENGINE_PROVIDERS, PROVIDER_ANTHROPIC_ENDPOINT } from './provider-anthropic-endpoints.js';

/**
 * Conditionally rewrites `env` to drive the Claude engine through a vendor's
 * Anthropic-compatible endpoint on behalf of a user.
 *
 * @param {NodeJS.ProcessEnv} env spawn env to mutate IN PLACE (already cloned by the caller)
 * @param {string|number|null} userId authenticated user id (null = shared single-user store)
 * @param {string|null|undefined} provider engine provider id (kimi/deepseek/glm)
 * @returns {Set<string>|null} the authorized hostname set, or null when nothing was injected
 */
export function applyClaudeEngineProviderEnv(env, userId, provider) {
  // (a) Not an engine provider (or unset): leave env untouched.
  if (!provider || !ENGINE_PROVIDERS.has(provider)) {
    return null;
  }

  // (b) No per-user key: inject nothing. Returning null here is what prevents a
  // half-injected env (base URL without a matching token) — both values are set
  // together below or not at all.
  const token = getProviderKey(userId, provider);
  if (!token) {
    return null;
  }

  // (c) Inject BOTH the endpoint and the token, on the passed env object only.
  // process.env is never touched.
  const endpoint = PROVIDER_ANTHROPIC_ENDPOINT[provider];
  env.ANTHROPIC_BASE_URL = endpoint;
  env.ANTHROPIC_AUTH_TOKEN = token;

  // (d) Report the single hostname we authorized so the guard can fence to it.
  return new Set([new URL(endpoint).hostname]);
}
