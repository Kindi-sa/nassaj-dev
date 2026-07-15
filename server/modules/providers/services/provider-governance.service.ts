/**
 * provider-governance.service — the honest engine-governance descriptor behind the
 * T-900 governance badge (design: docs/plans/GOVERNANCE-BADGE-DESIGN-2026-07-15.md).
 *
 * WHAT IT ANSWERS
 * ---------------
 * "Is the engine that runs THIS (user, provider) actually running under nassaj
 * governance right now, on disk?" — expressed as { status, enforced, mechanism }.
 * The governing principle (T-883, commit d0f97941): "governed" is an IDENTITY claim
 * (a sha256 that matches the neutral source), never mere file existence. A badge that
 * lies is worse than no badge, so this service reports only what the disk attests.
 *
 * READ-ONLY, NO SELF-HEAL (design §2 + §5, constraint 1)
 * ------------------------------------------------------
 * The check reads the CURRENT disk state and NEVER writes: it must not materialize,
 * repair, or provision. That rules out resolveProviderEnv / resolveCodexHomeForUser
 * for path resolution — both call provisionUserDirs → materializeGovernanceCopy (the
 * fail-closed spawn-time repair), which would rewrite a planted symlink/drift and turn
 * every first-touch query into a silent write that reports a freshly-repaired
 * "governed". So this module re-derives each provider's effective home read-only from
 * the SAME isolation map the spawn path uses (isProviderIsolated + userConfigDir /
 * operatorCodexHome), then inspects the material with pure reads. If a later spawn
 * repairs governance, a re-fetch simply flips the verdict — the badge is only ever the
 * truth at read time (design §2). materializeGovernanceCopy / ensureCodexGovernance are
 * NEVER called from here.
 *
 * PER (USER, PROVIDER), NOT PER SESSION: governance is a property of the user's
 * resolved provider home, so every session of the same provider for a user shares one
 * verdict (design §1).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { operatorCodexHome } from '@/modules/providers/list/codex/codex-home.js';
import {
  CODEX_AGENTS_FILENAME,
  governanceMatchesSource,
  readNeutralGovernance,
} from '@/services/isolation/codex-governance-material.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import type { LLMProvider } from '@/shared/types.js';
import { readOptionalString } from '@/shared/utils.js';

/** On-disk verdict. There is no third value: an unknown engine is 'ungoverned'; a
 *  server too old to answer is expressed as the ABSENCE of the response (404), which
 *  the client hides — this service never fabricates a value it cannot attest. */
export type ProviderGovernanceStatus = 'governed' | 'ungoverned';

/** The governance mechanism a provider HAS (static per provider), not the verdict. */
export type ProviderGovernanceMechanism =
  | 'codex-fingerprint'
  | 'claude-md'
  | 'opencode-agents'
  | 'none';

export interface ProviderGovernanceDescriptor {
  /** Current on-disk verdict for the caller's resolved provider home. */
  status: ProviderGovernanceStatus;
  /**
   * Whether nassaj HARD-enforces this engine's governance fail-closed at spawn — a
   * static property of the mechanism (true only for codex, whose spawn guard blocks
   * an ungoverned launch), NOT a function of the current status. claude/opencode are
   * present-but-not-enforced (no guard); everything else has no mechanism.
   */
  enforced: boolean;
  /** The mechanism this provider is governed by (or 'none'). */
  mechanism: ProviderGovernanceMechanism;
}

/**
 * The isolated user id to resolve a per-user home for `provider`, or null to use the
 * operator (shared) home. Mirrors resolveProviderEnv's gate exactly: isolation applies
 * only to an authenticated (non-empty) id AND only when the admin policy marks the
 * provider isolated; anonymous/null callers and shared providers use the operator home.
 */
function isolatedUserId(
  userId: string | number | null,
  provider: LLMProvider,
): string | number | null {
  if (userId === null || userId === undefined || userId === '') {
    return null;
  }
  return isProviderIsolated(provider) ? userId : null;
}

/**
 * The caller's effective CODEX_HOME, resolved READ-ONLY (byte-identical to what
 * resolveProviderEnv would set, minus the provisioning side effect).
 */
function codexHomeFor(userId: string | number | null): string {
  const isolated = isolatedUserId(userId, 'codex');
  return isolated !== null ? userConfigDir(isolated, '.codex') : operatorCodexHome();
}

/** The caller's effective CLAUDE_CONFIG_DIR, resolved READ-ONLY. */
function claudeConfigDirFor(userId: string | number | null): string {
  const isolated = isolatedUserId(userId, 'claude');
  return isolated !== null
    ? userConfigDir(isolated, '.claude')
    : path.join(os.homedir(), '.claude');
}

/**
 * The caller's effective XDG_CONFIG_HOME for opencode, resolved READ-ONLY. In shared
 * mode opencode reads a server-level XDG_CONFIG_HOME when present, else ~/.config
 * (mirrors resolveProviderEnv's opencode case and opencode's own default).
 */
function opencodeConfigHomeFor(userId: string | number | null): string {
  const isolated = isolatedUserId(userId, 'opencode');
  if (isolated !== null) {
    return userConfigDir(isolated, '.config');
  }
  return readOptionalString(process.env.XDG_CONFIG_HOME) ?? path.join(os.homedir(), '.config');
}

/** sha256 hex of a buffer (same identity primitive the neutral source is keyed by). */
function fingerprintOf(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * claude "governed" = CLAUDE.md is a real, non-empty file the CLI will ingest. Read
 * FOLLOWING the link (CLAUDE.md is normally a symlink to NASSAJ.md): a present,
 * non-empty followed target ⇒ governed; missing, empty, or a non-file (EISDIR) ⇒
 * ungoverned. There is no neutral fingerprint to enforce here — the claude source
 * (full NASSAJ.md) is intentionally variable — so this is present-not-enforced
 * (design §8 م-3), weaker than codex but honest.
 */
function claudeInstructionsPresent(claudeMdPath: string): boolean {
  try {
    // readFileSync follows symlinks; throws on ENOENT / EISDIR / etc.
    return fs.readFileSync(claudeMdPath).length > 0;
  } catch {
    return false;
  }
}

/**
 * opencode "governed" = its AGENTS.md resolves (FOLLOWING the link) to content whose
 * fingerprint matches the neutral source. opencode's AGENTS.md is a LEGITIMATE symlink
 * to the shared source, so governanceMatchesSource is deliberately NOT reused (it
 * lstat-rejects links, by design, as the codex write-through vector). We follow the
 * link and compare the fingerprint of the real content instead. No guard exists for
 * opencode, so a match is present-not-enforced (design §1, §8 م-1).
 */
function opencodeGovernanceMatches(agentsPath: string): boolean {
  const src = readNeutralGovernance();
  if (!src) {
    return false;
  }
  try {
    const content = fs.readFileSync(agentsPath); // follows the symlink chain
    return content.length > 0 && fingerprintOf(content) === src.fingerprint;
  } catch {
    return false;
  }
}

export const providerGovernanceService = {
  /**
   * Computes the honest governance descriptor for one (provider, user) from the
   * CURRENT disk state. Pure read — never materializes, provisions, or repairs.
   *
   * @param provider the LLM provider to describe
   * @param userId authenticated caller id (null = anonymous/operator/shared home)
   */
  getGovernance(
    provider: LLMProvider,
    userId: string | number | null,
  ): ProviderGovernanceDescriptor {
    switch (provider) {
      case 'codex': {
        // Identity check via the EXACT primitive the fail-closed guard reads at spawn
        // (governanceMatchesSource): a real, non-empty, non-symlink 0444 copy whose
        // sha256 matches the neutral source. Pure read — a symlink or drift is
        // reported ungoverned and left on disk untouched (no self-heal).
        const agentsPath = path.join(codexHomeFor(userId), CODEX_AGENTS_FILENAME);
        return {
          status: governanceMatchesSource(agentsPath) ? 'governed' : 'ungoverned',
          enforced: true,
          mechanism: 'codex-fingerprint',
        };
      }
      case 'claude': {
        const claudeMdPath = path.join(claudeConfigDirFor(userId), 'CLAUDE.md');
        return {
          status: claudeInstructionsPresent(claudeMdPath) ? 'governed' : 'ungoverned',
          enforced: false,
          mechanism: 'claude-md',
        };
      }
      case 'opencode': {
        const agentsPath = path.join(
          opencodeConfigHomeFor(userId),
          'opencode',
          CODEX_AGENTS_FILENAME,
        );
        return {
          status: opencodeGovernanceMatches(agentsPath) ? 'governed' : 'ungoverned',
          enforced: false,
          mechanism: 'opencode-agents',
        };
      }
      default:
        // cursor / gemini / antigravity / hermes / kimi / deepseek / glm / sakana:
        // no governance mechanism in the code ⇒ always honestly ungoverned. This is
        // the total default, so a provider added to the union later is ungoverned
        // (never accidentally inherits another engine's badge) until wired here.
        return { status: 'ungoverned', enforced: false, mechanism: 'none' };
    }
  },
};
