/**
 * resolveProviderEnv(userId, provider) — central credential-isolation seam.
 *
 * Per ADR-014, this is the SOLE source of truth for isolating provider
 * credentials per user. Every provider spawn (claude/gemini/codex/agy) builds
 * its child-process environment through this function and no other path.
 *
 * Isolation model (Phase-MU):
 *   - claude:  CLAUDE_CONFIG_DIR=~/.nassaj-users/<userId>/.claude   (B-ISO-CLAUDE)
 *   - gemini:  GEMINI_CLI_HOME=~/.nassaj-users/<userId>/.gemini     (B-ISO-GEMINI)
 *   - codex:   CODEX_HOME=~/.nassaj-users/<userId>/.codex           (B-ISO-CODEX, wired)
 *   - agy:     HOME=~/.nassaj-users/<userId> so its brain store under
 *              ~/.gemini/antigravity-cli resolves into the isolated tree
 *   - cursor:  no env knob yet — shared
 *
 * Whether a given provider is isolated at all is now an admin-configurable
 * policy (see services/provider-sharing.js). resolveProviderEnv consults
 * isProviderIsolated(provider) on every call: when a provider is marked
 * 'shared' the base (operator) environment is returned unchanged even for
 * claude/gemini/codex; when marked 'isolated' the per-user override is applied.
 * The default policy mirrors the original behavior (claude/gemini/codex
 * isolated, agy/cursor shared — ADR-016) so an install with no stored config is
 * unchanged.
 *
 * Conversations/instructions stay SHARED: provisionUserDirs symlinks each
 * per-user config dir's `projects/` and CLAUDE.md/NASSAJ.md back to the shared
 * root, so isolating credentials never forks the chat history or instructions.
 *
 * When userId is null/undefined (system/anonymous/platform-mode), no isolation
 * is applied and the base environment is returned unchanged — preserving the
 * single-user behavior the app had before multi-user.
 *
 * @typedef {'claude'|'gemini'|'codex'|'agy'|'cursor'} ProviderName
 */

import { isProviderIsolated } from '../provider-sharing.js';

import { provisionUserDirs, userConfigDir } from './provision-user-dirs.js';

/**
 * Resolves the environment for spawning a provider CLI on behalf of a user.
 *
 * @param {string|number|null} userId authenticated user id (null = system/anon)
 * @param {ProviderName} provider provider identifier
 * @param {NodeJS.ProcessEnv} [baseEnv] base environment to extend (defaults to process.env)
 * @returns {NodeJS.ProcessEnv} env to pass to child_process spawn
 */
export function resolveProviderEnv(userId, provider, baseEnv = process.env) {
  const env = { ...baseEnv };

  // No authenticated user: return the base (shared) environment unchanged.
  if (userId === null || userId === undefined || userId === '') {
    return env;
  }

  // Admin policy gate: a provider marked 'shared' uses the operator's
  // credentials regardless of its case below — return base env unchanged.
  if (!isProviderIsolated(provider)) {
    return env;
  }

  switch (provider) {
    case 'claude': {
      // Ensure per-user config dir + shared symlinks exist before spawn.
      provisionUserDirs(userId);
      env.CLAUDE_CONFIG_DIR = userConfigDir(userId, '.claude');
      return env;
    }
    case 'gemini': {
      provisionUserDirs(userId);
      // gemini-cli resolves ~/.gemini relative to GEMINI_CLI_HOME (see
      // server/gemini-cli.js:83). Point it at the per-user home root so the
      // CLI's own ~/.gemini lands inside the isolated tree.
      env.GEMINI_CLI_HOME = userConfigDir(userId, '');
      return env;
    }
    case 'codex': {
      provisionUserDirs(userId);
      env.CODEX_HOME = userConfigDir(userId, '.codex');
      return env;
    }
    case 'agy': {
      // agy has no dedicated env knob: it resolves its brain store under
      // ~/.gemini/antigravity-cli relative to HOME. Overriding HOME to the
      // per-user root isolates the brain (and anything else agy keys off the
      // home dir) into the user's tree. agy-cli.js mirrors this by computing
      // its BRAIN_DIR from the same per-user home when isolated.
      provisionUserDirs(userId);
      env.HOME = userConfigDir(userId, '');
      return env;
    }
    default:
      // cursor and any future providers: shared until explicitly isolated.
      return env;
  }
}
