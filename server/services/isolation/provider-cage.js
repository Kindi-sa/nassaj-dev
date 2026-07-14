/**
 * provider-cage — unified bubblewrap (bwrap) sandbox for local provider spawns.
 *
 * Ultracode workshop decision (2026-07-14): every provider that runs a local
 * child CLI is isolated through ONE bwrap cage baked into nassaj's own code, so
 * the same hardening ships across the fleet instead of being reinvented per
 * provider. This module is the pure seam that decides WHETHER to cage and BUILDS
 * the caged `{ cmd, args }`. It is intentionally standalone: Phase 1 wires it to
 * no live spawn path (that follows a per-provider spike once resolve-provider-env
 * stabilizes).
 *
 * Cage shape (unprivileged, no root — verified on disk 2026-07-14):
 *   bwrap --unshare-user --unshare-pid --unshare-ipc \
 *         --ro-bind / / --dev /dev --proc /proc \
 *         --tmpfs /run --tmpfs /tmp \
 *         --tmpfs <usersRoot> --bind <usersRoot>/<userId> <usersRoot>/<userId> \
 *         --bind <cwd> <cwd> \
 *         -- <cmd> <args...>
 * Effect: another user's ~/.nassaj-users tree is hidden (tmpfs over the root,
 * only the caller's own dir re-bound rw), host runtime sockets like
 * /run/docker.sock disappear (tmpfs /run), /proc/<pid>/root is sealed by the new
 * user+pid namespace, while the child still boots normally (whole FS read-only).
 *
 * Scope: caging is opt-in behind NASSAJ_PROVIDER_CAGE=true and applies to the
 * local-CLI providers (claude/gemini/agy/opencode/cursor/hermes). Two exemption
 * classes never get wrapped — see CAGE_EXEMPT_PROVIDERS.
 *
 * @typedef {'claude'|'gemini'|'codex'|'agy'|'cursor'|'opencode'|'hermes'|'kimi'|'deepseek'|'glm'} ProviderName
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Hosted third-party providers reached purely over HTTP. The local nassaj
 * process only holds a `fetch`-based client for these (see
 * modules/providers/shared/vendor/vendor-runtime.js) — there is NO child CLI to
 * sandbox. Mirrors resolve-provider-env.js's "hosted third-party HTTP APIs".
 * @type {readonly string[]}
 */
export const HTTP_HOSTED_PROVIDERS = Object.freeze(['kimi', 'deepseek', 'glm']);

/**
 * Providers exempt from the unified cage:
 *  - `codex` already self-cages via config-injection (its own bwrap). Wrapping it
 *    again would nest bubblewrap inside bubblewrap — a fragile double sandbox — so
 *    it is left to cage itself.
 *  - the HTTP_HOSTED_PROVIDERS have no local process to wrap.
 * Everything else, when the flag is on, IS caged (secure default: cage-by-default,
 * exempt-by-explicit-list).
 * @type {ReadonlySet<string>}
 */
export const CAGE_EXEMPT_PROVIDERS = Object.freeze(
  new Set(['codex', ...HTTP_HOSTED_PROVIDERS]),
);

/** @param {unknown} provider @returns {string} */
function normalizeProvider(provider) {
  return String(provider ?? '')
    .trim()
    .toLowerCase();
}

/**
 * True only when the operator opted in (NASSAJ_PROVIDER_CAGE=true) AND the
 * provider is an in-scope local-CLI provider — i.e. not codex and not an
 * HTTP-hosted vendor. An empty/unset provider is never cageable.
 * @param {ProviderName|string} provider
 * @returns {boolean}
 */
export function cageEnabled(provider) {
  if (process.env.NASSAJ_PROVIDER_CAGE !== 'true') return false;
  const name = normalizeProvider(provider);
  if (name === '') return false;
  return !CAGE_EXEMPT_PROVIDERS.has(name);
}

// --- bwrap resolution -------------------------------------------------------

/** @param {string} candidate @returns {boolean} */
function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * npm publishes the Codex binary via arch-specific optional deps named
 * `@openai/codex-<os>-<arch>`, and the bwrap "built for Codex" is vendored
 * inside them. e.g. linux/x64 → `codex-linux-x64`.
 * @returns {string}
 */
function platformPackageBaseName() {
  return `codex-${process.platform}-${process.arch}`;
}

/**
 * Given a platform-package root, find `vendor/<triple>/codex-resources/bwrap`.
 * The arch triple is globbed (readdir) so this stays correct on any target.
 * @param {string} rootDir
 * @returns {string|null}
 */
function bwrapUnderPlatformRoot(rootDir) {
  const vendorDir = path.join(rootDir, 'vendor');
  let triples;
  try {
    triples = fs.readdirSync(vendorDir);
  } catch {
    return null;
  }
  for (const triple of triples) {
    const candidate = path.join(vendorDir, triple, 'codex-resources', 'bwrap');
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** @param {string} spec @returns {string|null} package root dir or null */
function tryResolvePackageRoot(spec) {
  try {
    return path.dirname(require.resolve(spec));
  } catch {
    return null;
  }
}

/**
 * Absolute fallbacks for the global npm layout used across the fleet (nested
 * platform package under the global @openai/codex install).
 * @type {readonly string[]}
 */
const KNOWN_BWRAP_PATHS = Object.freeze([
  '/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap',
]);

/** Yields executable bwrap paths bundled with @openai/codex, best-first. */
function* bundledBwrapCandidates() {
  const base = platformPackageBaseName();

  // (a) Resolve the arch-specific platform package directly (hoisted layout,
  //     as npm installs it locally: node_modules/@openai/codex-linux-x64).
  const direct = tryResolvePackageRoot(`@openai/${base}/package.json`);
  if (direct) {
    const b = bwrapUnderPlatformRoot(direct);
    if (b) yield b;
  }

  // (b) Resolve via @openai/codex, then probe both the hoisted-sibling and the
  //     nested (npm-global) layouts of the platform package.
  const codexRoot = tryResolvePackageRoot('@openai/codex/package.json');
  if (codexRoot) {
    const siblingRoot = path.resolve(codexRoot, '..', base);
    const nestedRoot = path.join(codexRoot, 'node_modules', '@openai', base);
    for (const root of [siblingRoot, nestedRoot]) {
      const b = bwrapUnderPlatformRoot(root);
      if (b) yield b;
    }
  }

  // (c) Known absolute fallbacks.
  for (const abs of KNOWN_BWRAP_PATHS) {
    if (isExecutableFile(abs)) yield abs;
  }
}

/** @returns {string|null} first executable bwrap on PATH, else null */
function systemBwrapOnPath() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bwrap');
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve an executable bwrap. Preference order:
 *   1. the bwrap bundled with @openai/codex (built for Codex, works unprivileged)
 *   2. a system `bwrap` on PATH
 *   3. null
 * Null makes buildCagedLaunch fail SAFE (run the provider unwrapped) rather than
 * fail open or crash — there is simply no cage available to apply.
 * @returns {string|null}
 */
export function resolveBwrapPath() {
  for (const candidate of bundledBwrapCandidates()) return candidate;
  return systemBwrapOnPath();
}

// --- caged launch builder ---------------------------------------------------

let warnedBwrapMissing = false;

/**
 * Test-only: reset the one-shot "bwrap missing" warning memo so the fail-safe
 * path can be asserted deterministically.
 * @internal
 */
export function __resetCageWarningsForTests() {
  warnedBwrapMissing = false;
}

/**
 * Build the concrete `{ cmd, args }` to spawn for a provider run.
 *
 *  - cage disabled OR provider exempt → passthrough `{ cmd, args }` unchanged.
 *  - cage enabled but no bwrap found  → passthrough + one-shot warning (FAIL-SAFE,
 *    never fail-open: a missing sandbox must not silently drop isolation AND
 *    must not block the spawn; we run unwrapped and shout once).
 *  - cage enabled and bwrap available → wrap cmd/args in bwrap with the unified
 *    flags, hiding other users' trees and host sockets.
 *
 * Pure (no filesystem side effects) apart from the injectable bwrap lookup; the
 * caller is responsible for having provisioned `<usersRoot>/<userId>` and `cwd`
 * (bwrap --bind requires the source to exist), exactly like provisionUserDirs.
 *
 * @param {{ userId?: string|number|null, provider: ProviderName|string,
 *           cmd: string, args?: string[], cwd?: string, usersRoot?: string }} spec
 * @param {{ resolveBwrapPath?: () => (string|null) }} [deps] injectable seam (tests)
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildCagedLaunch(
  { userId, provider, cmd, args = [], cwd, usersRoot },
  deps = {},
) {
  const passthrough = { cmd, args };
  if (!cageEnabled(provider)) return passthrough;

  const resolve = deps.resolveBwrapPath || resolveBwrapPath;
  const bwrap = resolve();
  if (!bwrap) {
    if (!warnedBwrapMissing) {
      warnedBwrapMissing = true;
      console.warn(
        '[provider-cage] NASSAJ_PROVIDER_CAGE=true but no bwrap found; running ' +
          'provider UNWRAPPED (fail-safe passthrough)',
        { provider: normalizeProvider(provider) },
      );
    }
    return passthrough;
  }

  const bwrapArgs = [
    // Fresh user / pid / ipc namespaces (unprivileged userns).
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    // Whole host FS read-only, then overlay the writable / virtual mounts on top.
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    // Empty /run hides host runtime sockets (e.g. /run/docker.sock).
    '--tmpfs',
    '/run',
    // Isolated scratch space.
    '--tmpfs',
    '/tmp',
  ];

  // Hide the entire per-user root, then re-expose ONLY this user's dir (rw) so a
  // caged provider can never read another user's sessions/credentials.
  if (usersRoot) {
    bwrapArgs.push('--tmpfs', usersRoot);
    const uid = userId === undefined || userId === null ? '' : String(userId);
    if (uid !== '') {
      const userDir = path.join(usersRoot, uid);
      bwrapArgs.push('--bind', userDir, userDir);
    }
  }

  // Writable project working dir (session output / edits land here).
  if (cwd) {
    bwrapArgs.push('--bind', cwd, cwd);
  }

  bwrapArgs.push('--', cmd, ...args);
  return { cmd: bwrap, args: bwrapArgs };
}
