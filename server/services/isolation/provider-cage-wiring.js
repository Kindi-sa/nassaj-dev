/**
 * provider-cage-wiring — the thin seam between the pure cage builder
 * (provider-cage.js) and the live per-provider launch sites (T-897 m2).
 *
 * Why a separate module: buildCagedLaunch is deliberately PURE (argv in →
 * argv out; its 15 unit tests feed it fictional paths). Real launches need
 * two on-disk facts first — where the per-user trees root lives and whether
 * the bind sources actually exist (bwrap --bind fails on a missing source).
 * This module owns exactly that impure glue, so every launcher wires the cage
 * with one call and zero per-file policy.
 *
 * Flag economics (NASSAJ_PROVIDER_CAGE, default OFF): with the flag off,
 * resolveCagedLaunch returns `{ cmd, args }` with the SAME references it was
 * given and touches no filesystem, and buildCagedSdkSpawn returns undefined
 * so the SDK option is never even set — the off path is byte-identical to the
 * pre-wiring behaviour at every launch site.
 *
 * NOTE: resolve-provider-env.js (the natural env seam) is intentionally NOT
 * involved — it is under parallel work (handoff 2026-07-14); this module
 * wires the launchers directly and independently of the env resolver.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCagedLaunch, cageEnabled } from './provider-cage.js';

/**
 * Root of the per-user isolated config trees, mirroring
 * provision-user-dirs.js (NOT imported: that module drags the database layer
 * in, and this seam must stay importable by pure launch code and tests).
 * Returns undefined when the root does not exist on disk — nothing to hide,
 * and bwrap must not be pointed at a missing tmpfs target.
 *
 * @param {{ homedir?: () => string, existsSync?: (p: string) => boolean }} [deps]
 * @returns {string|undefined}
 */
export function cageUsersRoot({ homedir = os.homedir, existsSync = fs.existsSync } = {}) {
  const root = path.join(homedir(), '.nassaj-users');
  return existsSync(root) ? root : undefined;
}

/**
 * Resolves the concrete `{ cmd, args }` a launcher must spawn for a provider
 * run — caged when (and only when) NASSAJ_PROVIDER_CAGE=true and the provider
 * is in scope (see cageEnabled: codex and the HTTP-hosted vendors are exempt).
 *
 * On-disk guards applied before delegating to the pure builder:
 *   - usersRoot: only passed when ~/.nassaj-users exists;
 *   - userId:    only passed when that user's own dir exists (bwrap --bind
 *                requires the source; a shared-provider user may have none —
 *                their tree simply stays hidden with everyone else's);
 *   - cwd:       only passed when it exists (launchers validate cwd anyway;
 *                this keeps a failed validation from becoming a bwrap error).
 *
 * @param {{ userId?: string|number|null, provider: string, cmd: string,
 *           args?: string[], cwd?: string|null }} spec
 * @param {{ homedir?: () => string, existsSync?: (p: string) => boolean,
 *           resolveBwrapPath?: () => (string|null) }} [deps] test seam
 * @returns {{ cmd: string, args: string[] }}
 */
export function resolveCagedLaunch({ userId, provider, cmd, args = [], cwd }, deps = {}) {
  // Hot-path short-circuit: flag off / exempt provider ⇒ untouched references,
  // no filesystem access at all.
  if (!cageEnabled(provider)) {
    return { cmd, args };
  }

  const existsSync = deps.existsSync ?? fs.existsSync;
  const usersRoot = cageUsersRoot(deps);

  const uid = userId === null || userId === undefined ? '' : String(userId).trim();
  const ownDirExists =
    usersRoot !== undefined && uid !== '' && existsSync(path.join(usersRoot, uid));

  return buildCagedLaunch(
    {
      userId: ownDirExists ? uid : null,
      provider,
      cmd,
      args,
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      usersRoot,
    },
    deps.resolveBwrapPath ? { resolveBwrapPath: deps.resolveBwrapPath } : undefined,
  );
}

/**
 * Builds the `spawnClaudeCodeProcess` hook for the Claude Agent SDK spawn
 * seams (live chat query, built-in-commands probe, catalog probe) — the SDK's
 * documented extension point for running Claude Code inside containers/VMs,
 * which is exactly what the cage is.
 *
 * Returns undefined when the cage is off/out of scope so callers simply never
 * set the option (the SDK keeps its stock spawn — byte-identical off path).
 * When on, the hook wraps the SDK's fully-composed `{ command, args }` in the
 * unified bwrap argv and spawns it with the SDK-provided cwd/env/signal.
 *
 * stderr is 'ignore' — mirroring the SDK default (no options.stderr is used
 * anywhere in nassaj); piping without a reader could deadlock the child. The
 * only observable difference vs stock, cage aside, is that
 * DEBUG_CLAUDE_AGENT_SDK stderr echoing is unavailable while the cage is on.
 *
 * The returned hook is typed to the SDK's `SpawnedProcess` contract: the child
 * is spawned with piped stdin/stdout, so the concrete ChildProcess satisfies
 * the interface's non-null stream types at runtime.
 *
 * @param {{ userId?: string|number|null, cwd?: string|null }} spec
 * @param {{ spawn?: typeof spawn, homedir?: () => string,
 *           existsSync?: (p: string) => boolean,
 *           resolveBwrapPath?: () => (string|null) }} [deps] test seam
 * @returns {((spec: { command: string, args: string[], cwd?: string,
 *            env?: Record<string, string|undefined>, signal?: AbortSignal }) =>
 *            import('@anthropic-ai/claude-agent-sdk').SpawnedProcess)|undefined}
 */
export function buildCagedSdkSpawn({ userId, cwd }, deps = {}) {
  if (!cageEnabled('claude')) {
    return undefined;
  }
  const spawnFn = deps.spawn ?? spawn;
  return (spec) => {
    const launch = resolveCagedLaunch(
      {
        userId,
        provider: 'claude',
        cmd: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ?? cwd,
      },
      deps,
    );
    return spawnFn(launch.cmd, launch.args, {
      cwd: spec.cwd,
      env: spec.env,
      signal: spec.signal,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  };
}
