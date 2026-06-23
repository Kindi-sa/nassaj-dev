/**
 * anthropic-base-url-guard — fail-closed enforcement of the vendor-resilience
 * iron rule for the Claude / Anthropic subprocess.
 *
 * IRON RULE: the Claude Code (Anthropic) execution path must NEVER be pointed at
 * a non-Anthropic / competitor endpoint, and a competitor must never be
 * masqueraded as Claude. Until now this was human discipline only. This module
 * makes it enforced code: before the host environment is forwarded into the
 * spawned Claude Code subprocess, every SDK-honored base-URL routing var
 * (ANTHROPIC_BASE_URL and its Bedrock/Vertex/Foundry siblings) is validated
 * against an allowlist. If any is set to a host that is not approved, we REFUSE to spawn
 * (throw) rather than silently route Claude traffic to an unknown vendor.
 *
 * Two surfaces are guarded, because the Claude CLI reads routing config from
 * BOTH:
 *   1. The PROCESS / spawn env (process.env, sdkOptions.env) — assertAnthropicBaseUrlAllowed.
 *   2. The per-user settings.json `env` block inside CLAUDE_CONFIG_DIR, which
 *      the CLI applies downstream of the spawn env (see
 *      claude-onboarding.service.js:12,56) — assertSettingsEnvAllowed. Without
 *      this second check a competitor base URL placed in a user's settings.json
 *      would reach the subprocess undetected, bypassing the OS-env guard.
 *
 * SCOPE: this guard governs ONLY the Anthropic/Claude subprocess env. It does
 * not touch other providers (agy/AntigravityProvider, codex, cursor, opencode),
 * which legitimately point at their own non-Anthropic endpoints through their
 * own env knobs.
 *
 * Fail-closed contract:
 *   - ANTHROPIC_BASE_URL UNSET   -> allowed (default Anthropic; common path,
 *                                   must never regress).
 *   - host on the allowlist      -> allowed.
 *   - host NOT on the allowlist  -> throw a clear, actionable Error.
 *
 * Allowlist (a host is approved if ANY of these hold):
 *   1. Official Anthropic hosts: exactly `anthropic.com` or any subdomain
 *      `*.anthropic.com` (e.g. api.anthropic.com).
 *   2. Official managed-cloud endpoints, ONLY when that mode is explicitly
 *      enabled in the same env:
 *        - AWS Bedrock  (CLAUDE_CODE_USE_BEDROCK truthy): `*.amazonaws.com`.
 *        - Google Vertex (CLAUDE_CODE_USE_VERTEX truthy): `*.googleapis.com`.
 *   3. Any host listed (comma-separated) in NASSAJ_ALLOWED_ANTHROPIC_HOSTS —
 *      the documented escape hatch for a legitimate corporate proxy / credit-
 *      pool gateway / multi-user routing layer. Matched exactly OR as a parent
 *      domain suffix (an entry `proxy.example.com` also allows
 *      `api.proxy.example.com`).
 *
 * NOTE: nassaj-dev does NOT currently set ANTHROPIC_BASE_URL (verified against
 * .env / .env.example / ecosystem.config.cjs). The default Anthropic path is
 * therefore the live path, and this guard is a no-op for it. If a legitimate
 * gateway is introduced later, add its host to NASSAJ_ALLOWED_ANTHROPIC_HOSTS
 * (see .env.example) rather than relaxing this code.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Official Anthropic apex domain; this apex and all subdomains are allowed. */
const ANTHROPIC_APEX = 'anthropic.com';

/**
 * SDK-honored base-URL routing vars. Each entry names the env var the Claude
 * CLI / Agent SDK reads, and the managed-cloud apex its host must fall under
 * (in addition to the universal Anthropic + operator-allowlist rules). The
 * generic ANTHROPIC_BASE_URL has no fixed managed-cloud apex (cloud is null) and
 * is gated only by the Anthropic apex / Bedrock-or-Vertex flags / operator list.
 *
 * ANTHROPIC_FOUNDRY_BASE_URL is treated like the generic base URL (cloud null):
 * there is NO sanctioned Foundry host pattern in this codebase and no
 * Foundry-mode flag, so its host is approved ONLY when it is an Anthropic host or
 * an operator-allowlisted host — fail-closed. (If a legitimate Foundry endpoint
 * is ever sanctioned, define its apex + mode flag here rather than relaxing this
 * rule; until then a Foundry override to a non-Anthropic host is refused.)
 *
 * Any *other* env var matching the ROUTING_VAR_PATTERN below is an UNKNOWN
 * routing var and is rejected outright (fail-closed) so a future/added proxy
 * knob cannot silently bypass the iron rule.
 */
const ROUTING_VARS = [
  { name: 'ANTHROPIC_BASE_URL', cloud: null },
  { name: 'ANTHROPIC_BEDROCK_BASE_URL', cloud: 'amazonaws.com' },
  { name: 'ANTHROPIC_VERTEX_BASE_URL', cloud: 'googleapis.com' },
  { name: 'ANTHROPIC_FOUNDRY_BASE_URL', cloud: null },
];

/** Set of routing var names we explicitly understand and validate above. */
const KNOWN_ROUTING_VARS = new Set(ROUTING_VARS.map((v) => v.name));

/**
 * Matches any env var that looks like an Anthropic/Claude endpoint-routing
 * override (a *_BASE_URL under the ANTHROPIC_/CLAUDE_ namespaces). Used to catch
 * unknown routing vars the SDK might honor that are not in ROUTING_VARS.
 */
const ROUTING_VAR_PATTERN = /^(ANTHROPIC|CLAUDE)_.*BASE_URL$/;

/**
 * Reads an env var as a trimmed non-empty string, or null.
 * @param {unknown} value
 * @returns {string|null}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Treats common truthy spellings ("1", "true", "yes", "on") as enabled. Mirrors
 * how the Claude CLI reads its CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX flags.
 * @param {unknown} value
 * @returns {boolean}
 */
function isFlagEnabled(value) {
  const v = nonEmpty(value);
  if (v === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Extracts the lowercased hostname from a base-URL string. Returns null when the
 * value cannot be parsed as a URL with a host (which the caller treats as
 * disallowed — fail closed, never guess).
 * @param {string} rawUrl
 * @returns {string|null}
 */
function parseHost(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname;
    if (!host) return null;
    // Normalize a fully-qualified trailing dot (anthropic.com.) to its rootless
    // form so a legit FQDN with the DNS-root dot still matches the allowlist.
    // Anchored dot-suffix matching is preserved (we only strip a SINGLE trailing
    // dot, never an internal one).
    return host.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * True when `host` equals `domain` or is a subdomain of it. Suffix matching is
 * anchored on a dot boundary so `evil-anthropic.com` does NOT match
 * `anthropic.com` and `notanthropic.com` does NOT match either.
 * @param {string} host
 * @param {string} domain
 * @returns {boolean}
 */
function hostMatchesDomain(host, domain) {
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Parses NASSAJ_ALLOWED_ANTHROPIC_HOSTS into a list of lowercased host entries.
 * Accepts either bare hosts ("proxy.example.com") or full URLs
 * ("https://proxy.example.com:8443"); a URL entry is reduced to its hostname.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseAllowedHosts(raw) {
  const value = nonEmpty(raw);
  if (value === null) return [];
  return value
    .split(',')
    .map((entry) => {
      const e = entry.trim();
      if (e === '') return null;
      // Allow operators to paste a full URL or a bare host.
      return parseHost(e) ?? e.toLowerCase();
    })
    .filter((e) => e !== null);
}

/**
 * Decides whether a base-URL host is approved under the allowlist for the given
 * environment. Pure and side-effect free (no throw) so it is independently
 * testable and reusable.
 *
 * @param {string} host lowercased hostname from a routing var
 * @param {NodeJS.ProcessEnv} env environment that will be handed to the subprocess
 * @param {string|null} [cloud] managed-cloud apex the host MUST fall under when
 *   the var is a dedicated cloud override (e.g. 'amazonaws.com' for
 *   ANTHROPIC_BEDROCK_BASE_URL). When provided, the host is approved only if it
 *   is an Anthropic host, an operator-allowlisted host, OR a subdomain of that
 *   specific managed-cloud apex (gated on the matching mode flag). When null
 *   (the generic ANTHROPIC_BASE_URL), the original both-clouds behavior applies.
 * @returns {boolean}
 */
export function isAnthropicHostAllowed(host, env, cloud = null) {
  if (!host) return false;

  // 1. Official Anthropic hosts (apex + any subdomain) — always allowed.
  if (hostMatchesDomain(host, ANTHROPIC_APEX)) return true;

  // 2. Managed-cloud endpoints, gated on the explicit mode flag being enabled.
  if (cloud === null) {
    // Generic ANTHROPIC_BASE_URL: either managed cloud is acceptable when its
    // flag is on.
    if (isFlagEnabled(env.CLAUDE_CODE_USE_BEDROCK) && hostMatchesDomain(host, 'amazonaws.com')) {
      return true;
    }
    if (isFlagEnabled(env.CLAUDE_CODE_USE_VERTEX) && hostMatchesDomain(host, 'googleapis.com')) {
      return true;
    }
  } else {
    // Dedicated cloud override (Bedrock/Vertex base URL): the host MUST match
    // that exact managed-cloud apex AND the corresponding mode flag must be on.
    const flagEnabled =
      cloud === 'amazonaws.com'
        ? isFlagEnabled(env.CLAUDE_CODE_USE_BEDROCK)
        : cloud === 'googleapis.com'
          ? isFlagEnabled(env.CLAUDE_CODE_USE_VERTEX)
          : false;
    if (flagEnabled && hostMatchesDomain(host, cloud)) return true;
  }

  // 3. Operator-approved hosts via NASSAJ_ALLOWED_ANTHROPIC_HOSTS.
  for (const allowed of parseAllowedHosts(env.NASSAJ_ALLOWED_ANTHROPIC_HOSTS)) {
    if (hostMatchesDomain(host, allowed)) return true;
  }

  return false;
}

/**
 * Builds the fail-closed Error thrown when a routing var points at a
 * non-approved host (or is unparseable, or is an unknown routing var).
 * @param {string} varName the offending env var name
 * @param {string} shown the offending host (or raw value when unparseable)
 * @param {string} [reason] optional extra clause appended to the message
 * @returns {Error}
 */
function notAllowedError(varName, shown, reason = '') {
  const error = new Error(
    `Refusing to spawn Claude Code: ${varName} points at a non-approved host "${shown}". ` +
      (reason ? `${reason} ` : '') +
      'The vendor-resilience iron rule forbids routing the Claude/Anthropic path to a non-Anthropic ' +
      'endpoint or masquerading another vendor as Claude. ' +
      'If this host is a legitimate Anthropic-backed proxy/gateway, add it to ' +
      'NASSAJ_ALLOWED_ANTHROPIC_HOSTS (comma-separated) — do NOT remove this guard.'
  );
  error.code = 'ANTHROPIC_BASE_URL_NOT_ALLOWED';
  return error;
}

/**
 * Validates an arbitrary env-like map (process env OR a settings.json `env`
 * block) against the iron rule: every known routing var must resolve to an
 * approved host, and any UNKNOWN routing var (a *_BASE_URL under the
 * ANTHROPIC_/CLAUDE_ namespace not in our known set) is rejected outright.
 *
 * Pure w.r.t. the caller's env (reads only), throws on the first violation.
 *
 * @param {Record<string, unknown>} env env-like map to validate
 * @param {NodeJS.ProcessEnv} flagEnv env consulted for the mode flags
 *   (CLAUDE_CODE_USE_BEDROCK/_VERTEX) and the operator allowlist. For the
 *   process path this is the same object as `env`; for a settings.json block it
 *   is the merged effective env so a flag set in the OS env still gates a cloud
 *   host declared in settings.json.
 * @param {string} [sourceLabel] human label for error context (e.g. a file path)
 * @throws {Error} code ANTHROPIC_BASE_URL_NOT_ALLOWED on any violation
 */
function assertRoutingVarsAllowed(env, flagEnv, sourceLabel = '') {
  const where = sourceLabel ? ` (in ${sourceLabel})` : '';

  // 1. Known routing vars: each must resolve to an approved host.
  for (const { name, cloud } of ROUTING_VARS) {
    const raw = nonEmpty(env[name]);
    if (raw === null) continue; // unset -> default path, no-op.

    const host = parseHost(raw);
    if (host !== null && isAnthropicHostAllowed(host, flagEnv, cloud)) continue;

    throw notAllowedError(`${name}${where}`, host ?? raw);
  }

  // 2. Unknown routing vars: any *_BASE_URL override we do not understand is a
  //    potential bypass surface -> reject (fail-closed) rather than pass through.
  for (const key of Object.keys(env)) {
    if (KNOWN_ROUTING_VARS.has(key)) continue;
    if (!ROUTING_VAR_PATTERN.test(key)) continue;
    if (nonEmpty(env[key]) === null) continue; // empty -> harmless.

    throw notAllowedError(
      `${key}${where}`,
      String(env[key]),
      'This is an unrecognized endpoint-routing override; the guard refuses unknown routing vars.'
    );
  }
}

/**
 * Fail-closed guard for the PROCESS / spawn env. Validates every SDK-honored
 * routing var (ANTHROPIC_BASE_URL and its Bedrock/Vertex/Foundry base-URL
 * siblings) and rejects any unknown routing var before the env is forwarded to the Claude Code
 * subprocess. No-op when every routing var is unset (default Anthropic). Throws a
 * clear, actionable Error when any host is not on the allowlist — so a
 * disallowed/competitor endpoint is NEVER silently forwarded.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] environment headed to the subprocess
 * @throws {Error} when any routing var points at a non-approved host
 */
export function assertAnthropicBaseUrlAllowed(env = process.env) {
  assertRoutingVarsAllowed(env, env);
}

/**
 * Fail-closed guard for the PER-USER settings.json `env` block that the Claude
 * CLI applies downstream of the spawn env. Reads the user's
 * CLAUDE_CONFIG_DIR/settings.json, and validates its `env` routing vars under the
 * SAME allowlist as the process env — closing the bypass where a competitor base
 * URL set in settings.json reaches the subprocess undetected.
 *
 * Mode flags / operator allowlist are read from the EFFECTIVE env: a flag in
 * settings.json OR in the spawn env enables the corresponding managed cloud.
 *
 * Fail-closed details:
 *   - settings.json missing / unreadable / not an object / no `env` block -> no-op
 *     (nothing to route, default Anthropic path).
 *   - settings.json present and PARSEABLE but a routing var is disallowed -> throw.
 *   - settings.json present but INVALID JSON -> throw (we cannot prove the absence
 *     of a competitor override, so fail closed).
 *
 * @param {string} claudeConfigDir absolute CLAUDE_CONFIG_DIR for the user (the
 *   dir containing settings.json). When falsy, this is a no-op (no per-user dir).
 * @param {NodeJS.ProcessEnv} [spawnEnv=process.env] the effective spawn env, used
 *   only to read the mode flags / operator allowlist (never mutated).
 * @throws {Error} code ANTHROPIC_BASE_URL_NOT_ALLOWED on any violation
 */
export function assertSettingsEnvAllowed(claudeConfigDir, spawnEnv = process.env) {
  if (!claudeConfigDir) return; // No per-user config dir -> nothing to read.

  const settingsPath = join(claudeConfigDir, 'settings.json');

  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch {
    return; // Missing / unreadable -> no settings env to honor. No-op.
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    // Unparseable settings.json -> we cannot rule out a hidden competitor
    // override. Fail closed.
    const error = new Error(
      `Refusing to spawn Claude Code: ${settingsPath} is not valid JSON, so its env ` +
        'routing overrides cannot be validated against the vendor-resilience iron rule. ' +
        'Fix the file or remove it.'
    );
    error.code = 'ANTHROPIC_BASE_URL_NOT_ALLOWED';
    throw error;
  }

  const settingsEnv =
    settings && typeof settings === 'object' && !Array.isArray(settings) &&
    settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
      ? settings.env
      : null;
  if (!settingsEnv) return; // No env block -> nothing to validate.

  // Effective env for flag/allowlist evaluation: a flag may live in either the
  // spawn env or the settings env. settings.json values take precedence (they are
  // what the CLI ultimately applies).
  const effectiveFlagEnv = { ...spawnEnv, ...settingsEnv };

  assertRoutingVarsAllowed(settingsEnv, effectiveFlagEnv, settingsPath);
}
