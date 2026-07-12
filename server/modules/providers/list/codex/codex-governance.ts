/**
 * codex-governance — fail-closed governance gate for Codex spawns (ADR-057 §5,
 * owner decision 2026-07-12).
 *
 * Principle: Codex — like any agent engine — must NEVER run outside nassaj
 * governance. Before a turn is spawned, the caller (server/openai-codex.js)
 * verifies that the user's effective $CODEX_HOME/AGENTS.md resolves to non-empty
 * neutral governance. If it does not, this module attempts a single self-heal
 * (re-provision the per-user tree, then a direct relink into the resolved home)
 * and re-checks. If governance still cannot be established, the launch is refused
 * — no thread is started — and the caller returns a structural `governance_missing`
 * error.
 *
 * The neutral source is the SAME base the Claude CLAUDE.md/NASSAJ.md links use —
 * ~/.claude/AGENTS.md — which bootstrap-node.sh points at nassaj-core/AGENTS.md
 * (the build-agents neutral output). Using the operator-home base (not a hardcoded
 * nassaj-core path) keeps this portable across fleet nodes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  provisionUserDirs,
  invalidateProvisioned,
} from '@/services/isolation/provision-user-dirs.js';

import { resolveCodexHomeForUser } from './codex-home.js';

/** The governance filename Codex/opencode ingest from $CODEX_HOME. */
export const CODEX_AGENTS_FILENAME = 'AGENTS.md';

/** Structural error code emitted when a Codex launch is refused for lack of governance. */
export const GOVERNANCE_MISSING_CODE = 'governance_missing';

/** User-facing (Arabic) message for a governance-blocked Codex launch. */
export const GOVERNANCE_MISSING_MESSAGE = 'جلسة Codex محجوبة: حوكمة نسّاج غير مُهيّأة.';

export type GovernanceResult = {
  ok: boolean;
  codexHome: string;
  agentsPath: string;
  repaired?: boolean;
  reason?: string;
};

/**
 * The neutral governance source: ~/.claude/AGENTS.md — the same operator-home base
 * the Claude CLAUDE.md/NASSAJ.md provisioning links use. Resolves (via the
 * ~/.claude -> nassaj-core bootstrap symlink) to nassaj-core/AGENTS.md.
 */
export function neutralGovernanceSource(): string {
  return path.join(os.homedir(), '.claude', CODEX_AGENTS_FILENAME);
}

/**
 * True iff `agentsPath` resolves (realpath, following the symlink chain) to a
 * non-empty regular file — i.e. real governance content, not a missing, dangling
 * or empty link.
 */
function governanceResolves(agentsPath: string): boolean {
  try {
    const real = fs.realpathSync(agentsPath);
    const st = fs.statSync(real);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort direct relink of the neutral governance into `codexHome`. Covers the
 * operator/anonymous/shared CODEX_HOME (which provisionUserDirs does not manage)
 * and any residual per-user gap. Replaces a dangling/broken link; leaves a
 * resolving one intact. Never throws.
 *
 * @returns whether the governance link resolves after the attempt
 */
function linkGovernanceInto(codexHome: string): boolean {
  const agentsPath = path.join(codexHome, CODEX_AGENTS_FILENAME);
  const source = neutralGovernanceSource();
  try {
    if (governanceResolves(agentsPath)) {
      return true;
    }
    if (!fs.existsSync(source)) {
      // No neutral source on this node (e.g. build-agents output absent) — cannot
      // govern; the caller blocks the launch.
      return false;
    }
    // Clear a stale/dangling entry, then (re)create the link.
    try {
      fs.rmSync(agentsPath, { force: true });
    } catch {
      /* non-fatal — the symlink create below will surface a real problem */
    }
    fs.mkdirSync(codexHome, { recursive: true });
    fs.symlinkSync(source, agentsPath);
  } catch (err) {
    console.error('[Codex] governance relink failed', {
      codexHome,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return governanceResolves(agentsPath);
}

/**
 * Fail-closed governance gate. Verifies (and self-heals once) that the user's
 * effective $CODEX_HOME/AGENTS.md resolves to non-empty neutral governance.
 *
 * Repair order when missing:
 *   1. For an authenticated user, FORCE a full re-provision (invalidate the
 *      in-process guard first — resolveProviderEnv already provisioned this
 *      lifetime, so a plain call would no-op and never recreate a vanished link).
 *   2. Backstop: relink governance directly into the resolved home — covers the
 *      operator/anonymous/shared home and any residual per-user gap.
 *
 * @param userId authenticated spawner id (null = anonymous/system)
 * @returns whether the launch is governed; the caller BLOCKS the spawn on ok=false
 */
export function ensureCodexGovernance(userId: string | number | null): GovernanceResult {
  const uid = userId === undefined || userId === '' ? null : userId;
  const codexHome = resolveCodexHomeForUser(uid);
  const agentsPath = path.join(codexHome, CODEX_AGENTS_FILENAME);

  if (governanceResolves(agentsPath)) {
    return { ok: true, codexHome, agentsPath };
  }

  // Repair (1): force a full re-provision for a real user.
  if (uid !== null) {
    try {
      invalidateProvisioned(uid);
      provisionUserDirs(uid);
    } catch (err) {
      console.error('[Codex] governance repair provisioning failed', {
        userId: uid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Repair (2): direct relink backstop (also governs operator/anonymous/shared).
  const governed = governanceResolves(agentsPath) || linkGovernanceInto(codexHome);

  return governed
    ? { ok: true, codexHome, agentsPath, repaired: true }
    : { ok: false, codexHome, agentsPath, reason: 'neutral_source_absent' };
}
