/**
 * codex-governance.test.ts — fail-closed Codex governance gate (ADR-057 §5,
 * owner decision 2026-07-12: Codex — like any agent engine — must NEVER run
 * outside nassaj governance).
 *
 * Real path, SDK boundary mocked (same pattern as codex-spawn-isolation.test.ts):
 * real provisionUserDirs, real resolveProviderEnv / per-user CODEX_HOME
 * resolution, real fs symlink resolution, the real ensureCodexGovernance guard and
 * the real queryCodex spawn path. Only @openai/codex-sdk is mocked, so no `codex`
 * binary or network runs and the test can assert whether a turn was EVER spawned.
 *
 * Proves:
 *  - guard: a governed home (AGENTS.md resolves) passes with no repair.
 *  - guard: no neutral source ⇒ blocked (ok:false).
 *  - guard: link vanished but source present ⇒ self-heals (ok:true, repaired).
 *  - launch WITHOUT governance ⇒ structural `governance_missing` + the Arabic
 *    message, and NO Codex spawn (constructor never called).
 *  - launch WITH governance ⇒ clears the gate (no governance_missing) and spawns.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- Bootstrap: sandbox HOME + DB BEFORE importing any project module. ---
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-gov-guard-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
const sandboxCwd = path.join(sandbox, 'project'); // a real cwd so checkCwdExists passes
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });

// Seed the neutral governance content from the REAL operator source when present,
// so the "neutral source" under test is the genuine build-agents output; fall back
// to a representative neutral marker on a bare CI node.
let neutralContent: string;
try {
  neutralContent = fs.readFileSync(path.join(String(ORIGINAL_HOME), '.claude', 'AGENTS.md'), 'utf8');
} catch {
  neutralContent =
    '<!-- GENERATED — DO NOT EDIT -->\n# AGENTS.md — دليل وكلاء نسّاج\nملف تعليمات محايد المنصّة.\n';
}

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Neutralize module-level setInterval (openai-codex.js's session-cleanup timer) so
// the runner is not held alive after assertions complete.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  timer.unref();
  return timer;
} as unknown as typeof globalThis.setInterval;

// --- Mock the Codex SDK: record constructions so "was a turn spawned?" is
// observable, and return an empty event stream so a governed spawn runs cleanly to
// completion without a real subprocess. ---
type CodexCtorOptions = { env?: Record<string, string | undefined> } | undefined;
const codexConstructions: CodexCtorOptions[] = [];

class FakeThread {
  async runStreamed(): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> {
    async function* noEvents(): AsyncGenerator<unknown, void, unknown> {
      // intentionally empty
    }
    return { events: noEvents() };
  }
}

class FakeCodex {
  constructor(options?: { env?: Record<string, string | undefined> }) {
    codexConstructions.push(options);
  }

  startThread(): FakeThread {
    return new FakeThread();
  }

  resumeThread(): FakeThread {
    return new FakeThread();
  }
}

mock.module('@openai/codex-sdk', { namedExports: { Codex: FakeCodex } });

// Now safe to import the modules under test.
const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { setProviderSharingConfig, _resetProviderSharingCache } = await import(
  '@/services/provider-sharing.js'
);
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { ensureCodexGovernance, GOVERNANCE_MISSING_CODE } = await import(
  '@/modules/providers/list/codex/codex-governance.js'
);
// eslint-disable-next-line boundaries/no-unknown
const { queryCodex } = await import('@/openai-codex.js');

globalThis.setInterval = realSetInterval;

await initializeDatabase();

// Seed users (FK for the provisioning audit row).
const IDS = [9101, 9102, 9103, 9104, 9105] as const;
{
  const db = getConnection();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, 'x')",
  );
  for (const id of IDS) insert.run(id, `codex-gov-guard-${id}`);
}

const NEUTRAL_SOURCE = path.join(sandboxHome, '.claude', 'AGENTS.md');
/** Create or remove the neutral governance source (~/.claude/AGENTS.md). */
function setNeutralSource(present: boolean): void {
  if (present) {
    fs.writeFileSync(NEUTRAL_SOURCE, neutralContent);
  } else {
    fs.rmSync(NEUTRAL_SOURCE, { force: true });
  }
}

/** Forces the codex sharing policy to isolated so CODEX_HOME is per-user. */
function setCodexIsolated(): void {
  _resetProviderSharingCache();
  setProviderSharingConfig({
    claude: 'isolated',
    gemini: 'isolated',
    codex: 'isolated',
    agy: 'shared',
    cursor: 'shared',
  });
}

/** Minimal ws stub: records sent frames and carries the spawner's userId. */
function makeWs(userId: number | null): { userId: number | null; sent: unknown[]; send: (m: unknown) => void } {
  const sent: unknown[] = [];
  return { userId, sent, send: (m: unknown) => sent.push(m) };
}

/** The per-user isolated CODEX_HOME AGENTS.md link. */
function codexAgentsLink(userId: number): string {
  return userConfigDir(userId, path.join('.codex', 'AGENTS.md'));
}

/** True if any sent frame mentions the given token (searches the serialized frame). */
function framesInclude(sent: unknown[], token: string): boolean {
  return sent.some((f) => JSON.stringify(f).includes(token));
}

after(() => {
  globalThis.setInterval = realSetInterval;
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('ensureCodexGovernance — fail-closed gate (ADR-057 §5)', () => {
  it('passes for a governed user (AGENTS.md resolves to the neutral source), no repair', () => {
    setCodexIsolated();
    setNeutralSource(true);
    const userId = 9101;

    const result = ensureCodexGovernance(userId);

    assert.equal(result.ok, true, 'governed user must pass the gate');
    assert.equal(result.repaired ?? false, false, 'a governed user needs no repair');
    assert.equal(
      fs.realpathSync(codexAgentsLink(userId)),
      fs.realpathSync(NEUTRAL_SOURCE),
      'the per-user link must resolve to the neutral source',
    );
  });

  it('BLOCKS (ok:false) when no neutral source exists on the node', () => {
    setCodexIsolated();
    setNeutralSource(false); // no ~/.claude/AGENTS.md — governance cannot be established
    const userId = 9102;

    const result = ensureCodexGovernance(userId);

    assert.equal(result.ok, false, 'a launch without any neutral source must be blocked');
    assert.equal(result.reason, 'neutral_source_absent');
    assert.equal(
      fs.existsSync(codexAgentsLink(userId)) && governanceResolvesForTest(codexAgentsLink(userId)),
      false,
      'no resolving governance link may exist when the source is absent',
    );

    setNeutralSource(true); // restore for later cases
  });

  it('self-heals (ok:true, repaired) when the link vanished but the source is present', () => {
    setCodexIsolated();
    setNeutralSource(true);
    const userId = 9103;

    // First pass provisions a valid link.
    assert.equal(ensureCodexGovernance(userId).ok, true);
    const link = codexAgentsLink(userId);
    assert.equal(fs.existsSync(link), true, 'link exists after first pass');

    // Simulate the link vanishing AFTER the user was already provisioned this
    // lifetime (the in-process guard would otherwise no-op the repair).
    fs.rmSync(link, { force: true });
    assert.equal(governanceResolvesForTest(link), false, 'link is gone before re-check');

    const result = ensureCodexGovernance(userId);
    assert.equal(result.ok, true, 'the gate must self-heal a vanished link');
    assert.equal(result.repaired, true, 'repair must be flagged');
    assert.equal(
      fs.realpathSync(link),
      fs.realpathSync(NEUTRAL_SOURCE),
      'the healed link must resolve to the neutral source',
    );
  });
});

describe('queryCodex spawn path — fail-closed governance enforcement', () => {
  it('REFUSES to launch without governance: governance_missing + Arabic message, NO spawn', async () => {
    setCodexIsolated();
    setNeutralSource(false); // governance impossible to establish
    const userId = 9104;
    const ws = makeWs(userId);

    const before = codexConstructions.length;
    await queryCodex('ping', { cwd: sandboxCwd }, ws);

    // No turn was spawned: the Codex constructor was never called.
    assert.equal(
      codexConstructions.length,
      before,
      'a governance-blocked launch must NOT construct Codex (no spawn)',
    );
    // A structural governance error with the Arabic message was surfaced.
    assert.equal(framesInclude(ws.sent, GOVERNANCE_MISSING_CODE), true, 'must emit governance_missing');
    assert.equal(
      framesInclude(ws.sent, 'جلسة Codex محجوبة: حوكمة نسّاج غير مُهيّأة'),
      true,
      'must carry the Arabic block message',
    );
    // It must not have produced a normal session lifecycle.
    assert.equal(framesInclude(ws.sent, 'session_created'), false, 'no session may be created');

    setNeutralSource(true);
  });

  it('clears the gate WITH governance present: no governance_missing, and it spawns', async () => {
    setCodexIsolated();
    setNeutralSource(true);
    const userId = 9105;
    const ws = makeWs(userId);

    const before = codexConstructions.length;
    await queryCodex('ping', { cwd: sandboxCwd }, ws);

    assert.equal(
      codexConstructions.length,
      before + 1,
      'a governed launch must proceed past the gate and construct Codex exactly once',
    );
    assert.equal(
      framesInclude(ws.sent, GOVERNANCE_MISSING_CODE),
      false,
      'a governed launch must NOT be blocked',
    );
  });
});

// Local mirror of the module-private resolver, for assertions only.
function governanceResolvesForTest(agentsPath: string): boolean {
  try {
    const real = fs.realpathSync(agentsPath);
    const st = fs.statSync(real);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}
