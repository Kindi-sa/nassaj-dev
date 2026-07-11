/**
 * provision-codex-governance.test.ts — Codex governance decoupling (ADR-057 / T-819).
 *
 * Proves provisionUserDirs injects the NEUTRAL nassaj governance into each user's
 * isolated CODEX_HOME as a symlink (never a copy):
 *   ~/.nassaj-users/<id>/.codex/AGENTS.md  ->  ~/.claude/AGENTS.md
 * and, because ~/.claude is a whole-dir symlink to nassaj-core on every fleet node
 * (bootstrap-node.sh), that link resolves to nassaj-core/AGENTS.md — the
 * build-agents neutral output a spawned Codex session reads from $CODEX_HOME/AGENTS.md.
 *
 * Real path, not a synthetic fixture: the sandbox reproduces the exact production
 * topology (the double hop ~/.claude -> nassaj-core -> AGENTS.md), the neutral
 * source is seeded from the REAL operator nassaj-core/AGENTS.md content when it is
 * present on this machine (so "the neutral source" is the genuine governance, not a
 * stub), and every assertion exercises real fs symlink resolution through the real
 * provisionUserDirs code.
 *
 * HOME + DATABASE_PATH are sandboxed before importing any project module so the DB
 * singleton and userConfigDir never touch real state. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-gov-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });

// Seed the neutral source from the REAL operator governance BEFORE overriding HOME,
// so "the neutral source" under test is the genuine build-agents output. Falls back
// to a representative neutral marker on a bare CI node without nassaj-core.
let neutralContent: string;
try {
  neutralContent = fs.readFileSync(
    path.join(String(ORIGINAL_HOME), '.claude', 'AGENTS.md'),
    'utf8',
  );
} catch {
  neutralContent =
    '<!-- GENERATED — DO NOT EDIT -->\n# AGENTS.md — دليل وكلاء نسّاج (تعليمات مشتركة)\n' +
    'ملف تعليمات محايد المنصّة.\n';
}

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Reproduce the production governance topology faithfully:
//   sandboxHome/.claude  ->  sandboxHome/nassaj-core   (whole-dir symlink, as bootstrap wires it)
//   sandboxHome/nassaj-core/AGENTS.md                  (build-agents neutral output)
const NASSAJ_CORE = path.join(sandboxHome, 'nassaj-core');
fs.mkdirSync(NASSAJ_CORE, { recursive: true });
const NEUTRAL_AGENTS = path.join(NASSAJ_CORE, 'AGENTS.md');
fs.writeFileSync(NEUTRAL_AGENTS, neutralContent);
fs.symlinkSync(NASSAJ_CORE, path.join(sandboxHome, '.claude'));

const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');

await initializeDatabase();

// Seed an owner and a regular user.
const OWNER_ID = 8001;
const USER_ID = 8002;
{
  const db = getConnection();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'owner')"
  ).run(OWNER_ID, 'codex-gov-owner');
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')"
  ).run(USER_ID, 'codex-gov-user');
}

/** Path to a user's isolated CODEX_HOME AGENTS.md link. */
function codexAgents(userId: number): string {
  return userConfigDir(userId, path.join('.codex', 'AGENTS.md'));
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('provisionUserDirs — Codex neutral governance injection (ADR-057)', () => {
  it('symlinks AGENTS.md into the owner isolated CODEX_HOME, resolving to the neutral source', () => {
    provisionUserDirs(OWNER_ID);
    const link = codexAgents(OWNER_ID);

    assert.equal(fs.existsSync(link), true, 'AGENTS.md must exist in the isolated CODEX_HOME');
    assert.equal(
      fs.lstatSync(link).isSymbolicLink(),
      true,
      'AGENTS.md must be a symlink (never a copy — single source, no owner-secret leak)'
    );
    assert.equal(
      fs.realpathSync(link),
      fs.realpathSync(NEUTRAL_AGENTS),
      'the link must resolve through ~/.claude -> nassaj-core to nassaj-core/AGENTS.md'
    );
  });

  it('targets the ~/.claude governance base (absolute), matching the CLAUDE.md/NASSAJ.md pattern', () => {
    const target = fs.readlinkSync(codexAgents(OWNER_ID));
    assert.equal(
      target,
      path.join(sandboxHome, '.claude', 'AGENTS.md'),
      'symlink target must be the ~/.claude governance base — not a hardcoded absolute nassaj-core path'
    );
    assert.equal(path.isAbsolute(target), true, 'target must be absolute (ADR-057 decision)');
  });

  it('serves the exact neutral content through the link, with NO Claude-only mechanics', () => {
    const served = fs.readFileSync(codexAgents(OWNER_ID), 'utf8');
    assert.equal(
      served,
      neutralContent,
      'content read through the link must equal the neutral source byte-for-byte'
    );
    for (const token of ['/compact', 'ultracode', 'CLAUDE_CONFIG_DIR', 'safe-restart']) {
      assert.equal(
        served.includes(token),
        false,
        `neutral governance served to Codex must not contain the Claude-only token "${token}"`
      );
    }
  });

  it('injects the SAME neutral source for a non-owner user (shared governance, no per-user drift)', () => {
    provisionUserDirs(USER_ID);
    const link = codexAgents(USER_ID);

    assert.equal(
      fs.lstatSync(link).isSymbolicLink(),
      true,
      'non-owner AGENTS.md must also be a symlink'
    );
    assert.equal(
      fs.realpathSync(link),
      fs.realpathSync(codexAgents(OWNER_ID)),
      'owner and non-owner must resolve to the SAME single neutral source (shared, no drift)'
    );
  });

  it('is idempotent: re-provisioning a fresh user leaves a valid link intact', () => {
    const FRESH = 8003;
    const db = getConnection();
    db.prepare(
      "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')"
    ).run(FRESH, 'codex-gov-fresh');

    provisionUserDirs(FRESH);
    const link = codexAgents(FRESH);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'link created on first pass');

    // A repeat pass must be a no-op (never throw, never replace the link).
    provisionUserDirs(FRESH);
    assert.equal(
      fs.realpathSync(link),
      fs.realpathSync(NEUTRAL_AGENTS),
      'link still resolves to the neutral source after a repeat pass'
    );
  });
});
