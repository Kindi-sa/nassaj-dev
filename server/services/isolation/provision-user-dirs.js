/**
 * provisionUserDirs(userId) — per-user credential directory provisioning.
 *
 * Implements B-ISO-PROVISION (ADR-014): each user gets an isolated config tree
 * under ~/.nassaj-users/<userId>/ for Claude/Gemini/Codex credentials, while
 * conversations and instructions stay SHARED via symlinks back to the operator
 * root (~/.claude, ~/.gemini, ~/.codex).
 *
 * Layout created per user (dir mode 0700, sensitive files 0600):
 *   ~/.nassaj-users/<userId>/
 *     .claude/                         (isolated credentials)
 *       projects   -> ~/.claude/projects        (shared conversations)
 *       CLAUDE.md  -> ~/.claude/CLAUDE.md        (shared instructions, if present)
 *       NASSAJ.md  -> ~/.claude/NASSAJ.md        (shared instructions, if present)
 *       agents     -> ~/.claude/agents           (shared agent cards, if present —
 *                  ALL users; ADR-023 Decision 3: MCP/tools/files fully shared)
 *       skills     -> ~/.claude/skills           (shared skills, if present — ALL users)
 *       settings.json stays PER-USER on purpose (personal prefs, e.g. theme) —
 *                  intentionally NOT symlinked.
 *       .credentials.json -> ~/.claude/.credentials.json  (OWNER ONLY: the
 *                  bootstrap owner reuses the operator credential so an isolated
 *                  owner never has to re-login. Non-owner users get no link and
 *                  must `claude login` separately.)
 *     .gemini/
 *       projects   -> ~/.gemini/projects         (shared, if present)
 *       antigravity-cli/                          (agy isolated credentials)
 *         brain            -> ~/.gemini/antigravity-cli/brain
 *                  (SHARED for ALL users — every user sees the same agy
 *                  conversations, mirroring .claude/projects. getBrainDir(userId)
 *                  resolves to exactly this path under isolation — agy-cli.js:99.)
 *         antigravity-oauth-token -> ~/.gemini/antigravity-cli/antigravity-oauth-token
 *                  (OWNER ONLY: the bootstrap owner reuses the operator agy token
 *                  so an isolated owner never re-authenticates. Non-owner users get
 *                  no link and must run `agy` to authenticate. installation_id and
 *                  settings.json are linked too for the owner when present.)
 *     .codex/
 *       (isolated; no shared subtree symlinked yet)
 *
 * Idempotent: safe to call on every spawn. Existing dirs/symlinks are left
 * untouched. The first creation per user is recorded once in audit_log.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { auditLogDb, userDb } from '../../modules/database/index.js';

// Per-user isolated config trees are owner-only (0700): under a shared system
// uid this prevents any other local reader from listing another user's tree.
// (B-MU-OS-PERM, ADR-023 Decision 2.) `nassaj` itself owns every path so its
// own read/write is unaffected.
const DIR_MODE = 0o700;

// Sensitive credential files (the Claude OAuth/credentials JSON and any token
// file) are owner read/write only.
const FILE_MODE = 0o600;

// Credential filenames inside a user's .claude/ dir that must be 0600 whenever
// present (real files; symlinks are skipped — see chmodIfPresent).
const CLAUDE_CREDENTIAL_FILES = ['.credentials.json', '.claude.json'];

// agy (antigravity) keeps its state under ~/.gemini/antigravity-cli relative to
// HOME. Under isolation resolveProviderEnv overrides HOME to the per-user root,
// so agy materializes its token here. These are the relative subpaths inside a
// user's .gemini/ dir.
const AGY_DIR = path.join('.gemini', 'antigravity-cli');
const AGY_BRAIN_SUBDIR = 'brain';

// Sensitive agy credential filenames inside the antigravity-cli dir that must be
// 0600 whenever present as a REAL file (symlinks skipped — the owner's token is a
// symlink to the operator file and must not be re-chmod-ed).
const AGY_CREDENTIAL_FILES = ['antigravity-oauth-token'];

// Owner-only artifacts symlinked from the operator's agy dir so the bootstrap
// owner never re-authenticates. The token is the credential; installation_id and
// settings.json are reused for continuity when present.
const AGY_OWNER_LINKED_FILES = ['antigravity-oauth-token', 'installation_id', 'settings.json'];

// In-process guard so the (cheap) filesystem checks and the audit write only
// run once per user per server lifetime, even under concurrent spawns.
const provisioned = new Set();

/** Root of all per-user isolated config trees. */
function usersRoot() {
  return path.join(os.homedir(), '.nassaj-users');
}

/**
 * Absolute path to a user's isolated config subtree.
 * @param {string|number} userId
 * @param {string} [sub] subdirectory under the user root (e.g. '.claude'); ''
 *   returns the user root itself.
 * @returns {string}
 */
export function userConfigDir(userId, sub = '') {
  const base = path.join(usersRoot(), String(userId));
  return sub ? path.join(base, sub) : base;
}

/** Creates a directory (recursive) with restrictive mode if it does not exist. */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return true;
  }
  return false;
}

/**
 * Creates a symlink target<-link if `target` exists and `link` is not already
 * present. Never throws on a pre-existing link or a missing target — shared
 * resources are optional and must not block provisioning.
 */
function ensureSymlink(target, link) {
  try {
    if (!fs.existsSync(target)) {
      return;
    }
    if (fs.existsSync(link) || isSymlink(link)) {
      return;
    }
    fs.symlinkSync(target, link);
  } catch (err) {
    // A pre-existing dangling link or race is non-fatal; log and continue.
    console.error('[provision] symlink failed', {
      link,
      error: err?.message || String(err),
    });
  }
}

/** True if `p` is a symlink (even if dangling). */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Tightens permissions on `p` to `mode` if it exists as a REAL file/dir.
 * Symlinks are skipped on purpose: the owner's `.credentials.json` is a symlink
 * back to the operator's shared credential, and chmod-ing through it would
 * rewrite the operator file's mode. Never throws — hardening must not block
 * provisioning.
 */
function chmodIfPresent(p, mode) {
  try {
    if (isSymlink(p)) {
      return;
    }
    if (!fs.existsSync(p)) {
      return;
    }
    fs.chmodSync(p, mode);
  } catch (err) {
    console.error('[provision] chmod failed', {
      path: p,
      mode: mode.toString(8),
      error: err?.message || String(err),
    });
  }
}

/**
 * Applies restrictive permissions across a user's isolated tree: the user root
 * and every config subdir to 0700, and any present credential file to 0600.
 * Idempotent and safe to call on every provisioning pass; tolerant of missing
 * paths. Symlinked credentials are intentionally skipped (see chmodIfPresent).
 *
 * @param {string} userRoot absolute path to the user's isolated config root
 */
function hardenUserTree(userRoot) {
  chmodIfPresent(userRoot, DIR_MODE);

  for (const sub of ['.claude', '.gemini', '.codex']) {
    chmodIfPresent(path.join(userRoot, sub), DIR_MODE);
  }

  // agy lives under .gemini/antigravity-cli; tighten that dir too (0700) so a
  // non-owner's freshly-written token dir is never group/world-listable.
  chmodIfPresent(path.join(userRoot, AGY_DIR), DIR_MODE);

  const claudeDir = path.join(userRoot, '.claude');
  for (const name of CLAUDE_CREDENTIAL_FILES) {
    chmodIfPresent(path.join(claudeDir, name), FILE_MODE);
  }

  // agy token: 0600 when a REAL file (a non-owner who ran `agy` and wrote their
  // own token). The owner's token is a symlink to the operator file and is
  // skipped by chmodIfPresent's isSymlink guard, so the shared file's mode is
  // never rewritten. (B-MU-OS-PERM, ADR-023.)
  const agyDir = path.join(userRoot, AGY_DIR);
  for (const name of AGY_CREDENTIAL_FILES) {
    chmodIfPresent(path.join(agyDir, name), FILE_MODE);
  }
}

/**
 * True if `userId` is the bootstrap owner. The owner's isolated tree links back
 * to the operator's real Claude credential so the owner keeps working without a
 * separate login (the operator credential lives in ~/.claude/.credentials.json).
 * Defensive: any DB error is treated as "not owner" and never blocks
 * provisioning — credentials are optional, exactly like the other symlinks.
 *
 * @param {string|number} userId
 * @returns {boolean}
 */
function isOwnerUser(userId) {
  try {
    const numericId = Number(userId);
    if (!Number.isInteger(numericId)) {
      return false;
    }
    const user = userDb.getUserById(numericId);
    return user?.role === 'owner';
  } catch {
    return false;
  }
}

/**
 * Ensures the isolated config tree + shared symlinks exist for a user.
 * Idempotent and safe under concurrency.
 *
 * @param {string|number} userId authenticated user id
 */
export function provisionUserDirs(userId) {
  if (userId === null || userId === undefined || userId === '') {
    return;
  }

  const key = String(userId);
  if (provisioned.has(key)) {
    return;
  }

  const home = os.homedir();
  const userRoot = userConfigDir(userId, '');
  let createdRoot = false;

  try {
    createdRoot = ensureDir(userRoot);

    // --- Claude (isolated credentials + shared conversations/instructions) ---
    const claudeDir = path.join(userRoot, '.claude');
    ensureDir(claudeDir);
    ensureSymlink(path.join(home, '.claude', 'projects'), path.join(claudeDir, 'projects'));
    ensureSymlink(path.join(home, '.claude', 'CLAUDE.md'), path.join(claudeDir, 'CLAUDE.md'));
    ensureSymlink(path.join(home, '.claude', 'NASSAJ.md'), path.join(claudeDir, 'NASSAJ.md'));

    // Agent cards and skills are SHARED for ALL users (ADR-023 Decision 3:
    // MCP/tools/files are fully shared) — without these links a per-user
    // CLAUDE_CONFIG_DIR session cannot resolve the operator's custom agents
    // ("Agent type 'X' not found") or skills. settings.json is deliberately
    // NOT linked: each user keeps a personal settings file (theme prefs).
    ensureSymlink(path.join(home, '.claude', 'agents'), path.join(claudeDir, 'agents'));
    ensureSymlink(path.join(home, '.claude', 'skills'), path.join(claudeDir, 'skills'));

    // The bootstrap owner reuses the operator's real Claude credential even when
    // isolated, so the owner never has to re-login. Non-owner isolated users get
    // NO credential here on purpose: each must run their own `claude login`
    // (separate feature). ensureSymlink is a no-op if the target is missing.
    if (isOwnerUser(userId)) {
      ensureSymlink(
        path.join(home, '.claude', '.credentials.json'),
        path.join(claudeDir, '.credentials.json'),
      );
    }

    // --- Gemini (isolated; shared conversations if the root has them) ---
    const geminiDir = path.join(userRoot, '.gemini');
    ensureDir(geminiDir);
    ensureSymlink(path.join(home, '.gemini', 'projects'), path.join(geminiDir, 'projects'));

    // --- agy / antigravity (isolated credentials + SHARED brain) ---
    // agy resolves its store under ~/.gemini/antigravity-cli relative to HOME;
    // under isolation resolveProviderEnv sets HOME to userRoot, so this dir is
    // exactly where agy reads/writes its token (and getBrainDir(userId) resolves
    // its brain — agy-cli.js:99-104). It lives alongside gemini's projects/ under
    // the shared .gemini dir without collision (different subdir).
    const operatorAgyDir = path.join(home, AGY_DIR);
    const userAgyDir = path.join(userRoot, AGY_DIR);
    ensureDir(userAgyDir);

    // brain is SHARED for EVERY user (owner and non-owner) — the mirror of
    // .claude/projects: a symlink to the operator's single brain store so all
    // users see the same agy conversations. getBrainDir(userId) computes
    // userRoot/.gemini/antigravity-cli/brain under isolation, which IS this link,
    // so the share is honored on read/write/discovery.
    ensureSymlink(
      path.join(operatorAgyDir, AGY_BRAIN_SUBDIR),
      path.join(userAgyDir, AGY_BRAIN_SUBDIR),
    );

    // The bootstrap owner reuses the operator's real agy token (+ installation_id
    // / settings.json when present) so the isolated owner never re-authenticates.
    // Non-owner users get NO token here on purpose: each runs `agy` to OAuth their
    // own. ensureSymlink is a no-op when a target is missing.
    if (isOwnerUser(userId)) {
      for (const name of AGY_OWNER_LINKED_FILES) {
        ensureSymlink(path.join(operatorAgyDir, name), path.join(userAgyDir, name));
      }
    }

    // --- Codex (isolated; no shared subtree mirrored yet) ---
    ensureDir(path.join(userRoot, '.codex'));

    // Tighten permissions every pass: mkdir's `mode` is masked by the process
    // umask, so enforce 0700 dirs / 0600 credential files explicitly. Idempotent
    // and cheap. (B-MU-OS-PERM, ADR-023 Decision 2.)
    hardenUserTree(userRoot);

    // Record provisioning once, on first creation of the user root.
    if (createdRoot) {
      auditLogDb.record('user_dirs_provisioned', {
        userId: Number.isInteger(Number(userId)) ? Number(userId) : null,
        metadata: { root: userRoot },
      });
    }

    provisioned.add(key);
  } catch (err) {
    // Do not mark as provisioned so a later spawn can retry.
    console.error('[provision] provisionUserDirs failed', {
      userId: key,
      error: err?.message || String(err),
    });
  }
}
