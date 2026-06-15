/**
 * subscription-oauth-guard — fail-closed enforcement that a PERSONAL Claude
 * subscription credential (Claude Pro/Max OAuth) is used to spawn the Claude
 * Code subprocess ONLY on behalf of the owner.
 *
 * WHY THIS EXISTS (the ToS boundary):
 *   A personal Claude subscription (logged in via `claude` OAuth, i.e.
 *   CLAUDE_CODE_OAUTH_TOKEN / an OAuth token in the personal CLAUDE_CONFIG_DIR)
 *   is licensed to ONE human — the subscriber/owner. nassaj-dev is multi-user:
 *   if a non-owner member's run reaches the subprocess while the only available
 *   Claude credential is the owner's personal subscription, the platform would
 *   be lending one human's subscription to another human. That is exactly the
 *   Anthropic-ToS line the multi-user isolation work flagged as the highest-risk
 *   gate (see memory: project_multiuser_claude_isolation). Until now this was
 *   human discipline; this module makes it enforced code.
 *
 * Distinct from anthropic-base-url-guard.js (the IRON RULE guard): that one
 * forbids pointing Claude at a NON-Anthropic vendor. This one forbids lending
 * the OWNER's personal Anthropic SUBSCRIPTION to a non-owner. They are
 * orthogonal and both run before spawn.
 *
 * WHAT IS (and is NOT) a subscription credential:
 *   - Subscription (gated)      : a Claude Pro/Max OAuth login. Signalled by
 *                                 CLAUDE_CODE_OAUTH_TOKEN being set, OR an OAuth
 *                                 `.credentials.json` present in the personal
 *                                 CLAUDE_CONFIG_DIR (default ~/.claude).
 *   - API key (NOT gated)       : ANTHROPIC_API_KEY=sk-ant-*  — a pay-as-you-go
 *                                 org/workspace key, which is licensed for
 *                                 programmatic multi-user use. The API key wins
 *                                 precedence over an OAuth profile (matches how
 *                                 the SDK/CLI resolve credentials), so its
 *                                 presence means the run is NOT on the personal
 *                                 subscription.
 *   - Bedrock / Vertex (NOT)    : CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX truthy —
 *                                 the credential is the cloud provider's
 *                                 (AWS/GCP), not a personal subscription.
 *
 * FAIL-CLOSED contract for the detector:
 *   - API key (sk-ant-*) set          -> NOT subscription (false).
 *   - Bedrock or Vertex mode on       -> NOT subscription (false).
 *   - clear OAuth-subscription signal  -> subscription (true).
 *   - AMBIGUOUS (no API key, no cloud,
 *     no clear token/file either way)  -> subscription (true)  [fail closed].
 *
 *   Rationale for the ambiguous default: when isolation has already rewritten
 *   CLAUDE_CONFIG_DIR to a per-user dir, the personal OAuth file is no longer at
 *   the env path we can see, yet the underlying operator login (which the env was
 *   spread from) may still be a subscription. Treating "can't prove it's an API
 *   key / cloud" as subscription keeps the guard from silently lending the
 *   owner's seat. A real API-key/Bedrock/Vertex deployment sets one of the
 *   explicit signals above and is never caught by the ambiguous branch.
 *
 * OWNER-ALWAYS-PASSES contract for the assertion:
 *   - assertSubscriptionOAuthOwnerOnly NEVER throws when the credential is an API
 *     key or Bedrock/Vertex (any user passes), and NEVER throws for the owner
 *     (the subscriber using their own seat). It throws SUBSCRIPTION_OAUTH_NON_OWNER
 *     ONLY when the credential is the personal subscription AND the requesting
 *     user is not the owner (null/unknown role is treated as non-owner — fail
 *     closed).
 *
 * SCOPE: governs ONLY the Anthropic/Claude subprocess. Other providers
 * (agy/codex/cursor/gemini/opencode) carry their own credentials and are
 * untouched.
 *
 * This module is intentionally DEPENDENCY-FREE (no DB import) so it stays pure
 * and unit-testable. Callers resolve the user/role (e.g. via userDb) and pass a
 * plain `{ role }` object in.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Role that owns the personal subscription. Only this role may use it. */
const OWNER_ROLE = 'owner';

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
 * how the Claude CLI reads its CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX flags
 * (kept consistent with anthropic-base-url-guard.js).
 * @param {unknown} value
 * @returns {boolean}
 */
function isFlagEnabled(value) {
  const v = nonEmpty(value);
  if (v === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * True when an Anthropic API key is configured (and looks like one). The Claude
 * CLI/SDK prefer an API key over an OAuth profile, so a present `sk-ant-*` key
 * means the run is on the API key, not the personal subscription.
 *
 * We require the `sk-ant-` prefix per the task contract: only a real Anthropic
 * API key disables the subscription gate. An empty or malformed value does NOT
 * count as an API key (and therefore does not relax the gate) — fail closed.
 * @param {Record<string, unknown>} env
 * @returns {boolean}
 */
function hasAnthropicApiKey(env) {
  const key = nonEmpty(env.ANTHROPIC_API_KEY);
  return key !== null && key.startsWith('sk-ant-');
}

/**
 * True when the run targets a managed cloud (AWS Bedrock or Google Vertex). In
 * that mode the credential is the cloud provider's, not a personal subscription.
 * @param {Record<string, unknown>} env
 * @returns {boolean}
 */
function usesBedrockOrVertex(env) {
  return isFlagEnabled(env.CLAUDE_CODE_USE_BEDROCK) || isFlagEnabled(env.CLAUDE_CODE_USE_VERTEX);
}

/**
 * True when an OAuth `.credentials.json` (the Claude Pro/Max login store) is
 * present in the given config dir. Best-effort and fail-quiet: a missing file or
 * any read/parse error returns false (no positive proof of a subscription file).
 * The broader detector still defaults ambiguous cases to subscription, so a
 * false here never relaxes the gate on its own.
 * @param {string|null} configDir directory that would contain .credentials.json
 * @returns {boolean}
 */
function hasOAuthCredentialsFile(configDir) {
  if (!configDir) return false;
  const credPath = join(configDir, '.credentials.json');
  try {
    if (!existsSync(credPath)) return false;
    const raw = readFileSync(credPath, 'utf8');
    const parsed = JSON.parse(raw);
    // The Claude CLI stores the subscription login under claudeAiOauth. Accept
    // either that explicit shape or any object that carries an OAuth-ish token
    // field — but a present, parseable credentials.json is itself a strong
    // subscription signal, so we treat a readable object as sufficient.
    if (parsed && typeof parsed === 'object') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Decides whether the Claude credential that would be handed to the subprocess
 * is the PERSONAL SUBSCRIPTION (OAuth) rather than an API key or a managed-cloud
 * (Bedrock/Vertex) credential. Pure and side-effect free (only reads env + may
 * stat/read a credentials file) so it is independently testable.
 *
 * Decision order (first match wins):
 *   1. API key (sk-ant-*) present            -> false (not subscription).
 *   2. Bedrock/Vertex mode enabled           -> false (not subscription).
 *   3. CLAUDE_CODE_OAUTH_TOKEN present        -> true  (explicit subscription).
 *   4. OAuth .credentials.json in the env's
 *      CLAUDE_CONFIG_DIR, or the default
 *      ~/.claude (personal login store)       -> true.
 *   5. Otherwise (ambiguous)                  -> true  (fail closed).
 *
 * @param {Record<string, unknown>} [env=process.env] environment headed to the
 *   subprocess (after any per-user isolation rewrite).
 * @returns {boolean} true if the credential is a personal subscription OAuth.
 */
export function isSubscriptionOAuthCredential(env = process.env) {
  // 1 & 2: explicit non-subscription credentials always win — never gate these.
  if (hasAnthropicApiKey(env)) return false;
  if (usesBedrockOrVertex(env)) return false;

  // 3: an explicit OAuth bearer token is a definitive subscription signal.
  if (nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN) !== null) return true;

  // 4: a personal OAuth login store. Check the env's config dir first (the
  // operator/owner's dir is the one the env was spread from), then the default
  // ~/.claude. Note: when isolation has rewritten CLAUDE_CONFIG_DIR to a per-user
  // dir this may not find the personal store — step 5 still fails closed.
  const envConfigDir = nonEmpty(env.CLAUDE_CONFIG_DIR);
  if (hasOAuthCredentialsFile(envConfigDir)) return true;
  if (hasOAuthCredentialsFile(join(homedir(), '.claude'))) return true;

  // 5: ambiguous — no API key, no cloud, no provable token/file. Fail closed:
  // assume the personal subscription so a non-owner cannot borrow the seat.
  return true;
}

/**
 * Builds the fail-closed Error thrown when a non-owner would spawn Claude on the
 * owner's personal subscription.
 * @param {{ role?: unknown, id?: unknown }|null|undefined} user the requesting user
 * @returns {Error}
 */
function nonOwnerError(user) {
  const role = user && typeof user === 'object' ? user.role : undefined;
  const shownRole = nonEmpty(role) ?? 'unknown';
  const error = new Error(
    'Refusing to spawn Claude Code: the configured Claude credential is a personal ' +
      `subscription (OAuth) login, which is licensed to the owner only, but this run is for a ` +
      `non-owner user (role="${shownRole}"). Lending the owner's personal Claude subscription to ` +
      'another user violates the Anthropic subscription terms. To let this user run Claude, give the ' +
      'deployment an Anthropic API key (ANTHROPIC_API_KEY=sk-ant-...) or enable Bedrock/Vertex ' +
      '(CLAUDE_CODE_USE_BEDROCK/_USE_VERTEX) — a per-user-licensable credential — instead of the ' +
      'owner subscription. Do NOT remove this guard.'
  );
  error.code = 'SUBSCRIPTION_OAUTH_NON_OWNER';
  return error;
}

/**
 * True when the resolved user is the owner. A null/undefined user, or a user
 * with any role other than 'owner', is treated as a non-owner (fail closed).
 * @param {{ role?: unknown }|null|undefined} user
 * @returns {boolean}
 */
function isOwner(user) {
  return Boolean(user) && typeof user === 'object' && user.role === OWNER_ROLE;
}

/**
 * Fail-closed guard: refuse to spawn Claude Code on the owner's PERSONAL
 * SUBSCRIPTION on behalf of anyone but the owner.
 *
 * Contract (see module header):
 *   - credential is API key / Bedrock / Vertex  -> NEVER throws (any user passes).
 *   - credential is the personal subscription    -> throws SUBSCRIPTION_OAUTH_NON_OWNER
 *     UNLESS the user is the owner. The OWNER ALWAYS PASSES.
 *   - user is null/undefined/unknown-role + subscription -> throws (non-owner).
 *
 * NOTE on single-user / system context: when there is NO authenticated user
 * (userId absent), the caller passes `user = null`. In that case the credential
 * is being used by the host/operator themselves — but this guard cannot tell a
 * deliberate single-user/system spawn from a stray non-owner run, so it treats a
 * null user as non-owner and throws on a subscription credential. Callers that
 * legitimately spawn in a pure single-user context where the sole user IS the
 * owner should resolve and pass that owner (e.g. userDb.getFirstUser()) rather
 * than null, so the owner-always-passes branch applies. (G4's caller does this:
 * it resolves the row for ws.userId; platform mode asserts the first user is the
 * owner — see auth.js.)
 *
 * @param {Record<string, unknown>} env environment headed to the subprocess.
 * @param {{ role?: unknown, id?: unknown }|null|undefined} user requesting user.
 * @throws {Error} code SUBSCRIPTION_OAUTH_NON_OWNER when a non-owner would use
 *   the owner's personal subscription.
 */
export function assertSubscriptionOAuthOwnerOnly(env, user) {
  // The owner may always use their own subscription — short-circuit before any
  // detection so the owner path can never regress.
  if (isOwner(user)) return;

  // Not the owner: only gate when the credential is actually the personal
  // subscription. API key / Bedrock / Vertex are licensable per-user -> allow.
  if (!isSubscriptionOAuthCredential(env)) return;

  throw nonOwnerError(user);
}

/**
 * Platform-mode hardening (G5): in platform mode the WHOLE deployment runs as a
 * single database user (auth.js resolves it via userDb.getFirstUser()). If that
 * sole user is NOT the owner while the Claude credential is the personal
 * subscription, every Claude run would lend the owner's seat to a non-owner —
 * so we fail closed at auth time rather than at spawn time.
 *
 * No-op (returns silently) when: not in platform mode, no user resolved (auth
 * surfaces its own error for that), the credential is an API key / Bedrock /
 * Vertex, OR the sole user already IS the owner. Throws SUBSCRIPTION_OAUTH_NON_OWNER
 * only for the genuine misconfiguration (subscription credential + non-owner sole
 * user).
 *
 * @param {{ role?: unknown, id?: unknown }|null|undefined} firstUser the platform
 *   single user (userDb.getFirstUser()).
 * @param {Record<string, unknown>} [env=process.env] environment the Claude
 *   subprocess would inherit (read-only).
 * @throws {Error} code SUBSCRIPTION_OAUTH_NON_OWNER on the subscription+non-owner
 *   misconfiguration.
 */
export function assertPlatformFirstUserOwnsSubscription(firstUser, env = process.env) {
  // No user yet -> nothing to assert here; the caller handles the missing-user case.
  if (!firstUser) return;
  // Owner / non-subscription credential -> allowed. Reuse the same fail-closed
  // detector + owner check as the spawn-time assertion.
  assertSubscriptionOAuthOwnerOnly(env, firstUser);
}
