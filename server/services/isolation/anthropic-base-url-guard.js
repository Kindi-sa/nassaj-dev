/**
 * anthropic-base-url-guard — fail-closed gate over every *_BASE_URL the Claude
 * Agent SDK will see at spawn (ADR-037, B-ENG-3).
 *
 * The iron rule says a Claude client must never be silently pointed at a
 * competitor host. The "Claude engine on a vendor" path (B-ENG-2) deliberately
 * DOES point ANTHROPIC_BASE_URL at a vendor, but only for an explicit, per-user
 * keyed engine provider. This guard is what keeps that the ONLY way an off-Anthropic
 * base URL can reach a spawn: it inspects the final env (and any settings.json
 * base URLs the caller collected) and throws unless every base URL is explicitly
 * justified.
 *
 * Allow logic, per *_BASE_URL value (and per ctx.extraValues entry):
 *   1. The value must parse as a URL — an unparseable *_BASE_URL is rejected
 *      outright (a malformed value could be coerced into an unexpected host).
 *   2. Its hostname must be one of:
 *        - OFFICIAL_ANTHROPIC_HOSTS (api.anthropic.com), or
 *        - ctx.engineProviderHosts (the hostnames applyClaudeEngineProviderEnv
 *          authorized for THIS spawn), or
 *        - the operator escape hatch: when CLAUDE_CODE_USE_BEDROCK or
 *          CLAUDE_CODE_USE_VERTEX is truthy in env, OR the host appears in the
 *          comma/space-separated NASSAJ_ALLOWED_ANTHROPIC_HOSTS env list.
 *   Otherwise it throws.
 *
 * The escape hatch exists so legitimate Claude Code setups — Bedrock/Vertex
 * routing and operator-pinned proxies — keep working; it is read from env, never
 * hard-coded, so the default install (no flags, no list) stays fail-closed.
 *
 * With no ctx.engineProviderHosts passed, the guard still runs: any *_BASE_URL
 * that is not official and not covered by the escape hatch fails closed.
 *
 * This module reads ONLY the env/ctx it is given; it never mutates env and never
 * touches process.env.
 *
 * @typedef {Object} BaseUrlGuardCtx
 * @property {Set<string>|undefined} [engineProviderHosts] hostnames authorized for this spawn
 * @property {string[]|undefined} [extraValues] extra base-URL string values (e.g. from settings.json)
 */

import { OFFICIAL_ANTHROPIC_HOSTS } from './provider-anthropic-endpoints.js';

const BASE_URL_SUFFIX = '_BASE_URL';

/** Env var carrying an operator allow-list of extra Anthropic hostnames. */
const ALLOWED_HOSTS_ENV = 'NASSAJ_ALLOWED_ANTHROPIC_HOSTS';

/**
 * Treats a Claude Code feature flag as enabled for any non-empty, non-"0",
 * non-"false" value — matching how such flags are conventionally read.
 * @param {unknown} value
 * @returns {boolean}
 */
function isFlagEnabled(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/**
 * Parses the operator host allow-list (comma or whitespace separated) into a Set.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Set<string>}
 */
function operatorAllowedHosts(env) {
  const raw = env[ALLOWED_HOSTS_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return new Set();
  }
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter((h) => h !== ''),
  );
}

/**
 * Validates a single base-URL value against the allow logic, throwing on any
 * unparseable or disallowed host.
 *
 * @param {string} value the *_BASE_URL value
 * @param {string} label source label for error messages (env key or "settings.json")
 * @param {Set<string>} allowedHosts the union of official + engine + operator hosts
 * @param {boolean} cloudEscape whether Bedrock/Vertex routing is enabled (host check skipped)
 */
function assertOneBaseUrl(value, label, allowedHosts, cloudEscape) {
  // When Bedrock/Vertex routing is on, base URLs legitimately point at AWS/GCP
  // regional hosts that we don't enumerate — honor the operator's explicit flag.
  if (cloudEscape) {
    return;
  }

  let hostname;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(
      `Refusing to spawn: ${label} is not a parseable URL (${String(value)}). ` +
        'Every *_BASE_URL must be a valid URL pointing at an allowed host.',
    );
  }

  if (!allowedHosts.has(hostname)) {
    throw new Error(
      `Refusing to spawn: ${label} points at a disallowed host "${hostname}". ` +
        'Allowed: the official Anthropic API, an engaged per-user engine provider, ' +
        `or a host in ${ALLOWED_HOSTS_ENV} (or set CLAUDE_CODE_USE_BEDROCK/VERTEX).`,
    );
  }
}

/**
 * Asserts that every base URL the SDK will see (env *_BASE_URL keys plus any
 * collected settings.json base URLs) is allowed; throws otherwise. Returns
 * nothing on success.
 *
 * @param {NodeJS.ProcessEnv} env the final spawn env
 * @param {BaseUrlGuardCtx} [ctx]
 */
export function assertAnthropicBaseUrlAllowed(env, ctx = {}) {
  const cloudEscape =
    isFlagEnabled(env.CLAUDE_CODE_USE_BEDROCK) || isFlagEnabled(env.CLAUDE_CODE_USE_VERTEX);

  // Union of always-allowed official hosts, this-spawn engine hosts, and the
  // operator allow-list. Built once and shared across all values.
  const allowedHosts = new Set(OFFICIAL_ANTHROPIC_HOSTS);
  if (ctx.engineProviderHosts instanceof Set) {
    for (const h of ctx.engineProviderHosts) {
      allowedHosts.add(h);
    }
  }
  for (const h of operatorAllowedHosts(env)) {
    allowedHosts.add(h);
  }

  // 1. Every env key ending in _BASE_URL whose value is a string.
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith(BASE_URL_SUFFIX) && typeof value === 'string' && value.trim() !== '') {
      assertOneBaseUrl(value, key, allowedHosts, cloudEscape);
    }
  }

  // 2. Extra base-URL values supplied by the caller (e.g. settings.json env),
  //    which Claude Code reads on its own at spawn and which the env scan above
  //    would otherwise miss.
  if (Array.isArray(ctx.extraValues)) {
    for (const value of ctx.extraValues) {
      if (typeof value === 'string' && value.trim() !== '') {
        assertOneBaseUrl(value, 'settings.json *_BASE_URL', allowedHosts, cloudEscape);
      }
    }
  }
}
