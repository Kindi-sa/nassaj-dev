/**
 * provisionUserDirs(userId) — per-user credential directory provisioning.
 *
 * Implements B-ISO-PROVISION (ADR-014): each user gets an isolated config tree
 * under ~/.nassaj-users/<userId>/ for Claude/Gemini/Codex credentials, while
 * conversations and instructions stay SHARED via symlinks back to the operator
 * root (~/.claude, ~/.gemini, ~/.codex).
 *
 * Layout created per user (mode 0750):
 *   ~/.nassaj-users/<userId>/
 *     .claude/                         (isolated credentials)
 *       projects   -> ~/.claude/projects        (shared conversations)
 *       CLAUDE.md  -> ~/.claude/CLAUDE.md        (shared instructions, if present)
 *       NASSAJ.md  -> ~/.claude/NASSAJ.md        (shared instructions, if present)
 *     .gemini/
 *       projects   -> ~/.gemini/projects         (shared, if present)
 *     .codex/
 *       (isolated; no shared subtree symlinked yet)
 *
 * Idempotent: safe to call on every spawn. Existing dirs/symlinks are left
 * untouched. The first creation per user is recorded once in audit_log.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { auditLogDb } from '../../modules/database/index.js';

const DIR_MODE = 0o750;

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

    // --- Gemini (isolated; shared conversations if the root has them) ---
    const geminiDir = path.join(userRoot, '.gemini');
    ensureDir(geminiDir);
    ensureSymlink(path.join(home, '.gemini', 'projects'), path.join(geminiDir, 'projects'));

    // --- Codex (isolated; no shared subtree mirrored yet) ---
    ensureDir(path.join(userRoot, '.codex'));

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
