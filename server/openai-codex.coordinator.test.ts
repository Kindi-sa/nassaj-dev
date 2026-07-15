/**
 * openai-codex.coordinator.test.ts — T-886: proves the OPT-IN coordinator role at the
 * single Codex launch chokepoint. @openai/codex-sdk is mocked at the module boundary
 * (no real codex binary, no network, NO ChatGPT quota — R2 live verification is the
 * coordinator's job, separately). queryCodex is driven end-to-end and the ACTUAL launch
 * surface is asserted for a coordinator vs a default (regression) spawn:
 *   - sandbox:  coordinator ⇒ read-only / never;  default ⇒ workspace-write / untrusted (R1).
 *   - Gate 2:   coordinator ⇒ config carries agents.max_depth=1;  default ⇒ it is absent.
 *   - D3:       coordinator ⇒ the ROOT turn input is prepended with the delegate-only
 *               contract;  default ⇒ the input is the raw command (no prepend).
 *   - delegates: a coordinator spawn materializes architect.toml + qa-critic.toml into
 *               $CODEX_HOME/agents (REAL fs), bound to the resolved model, read-only, no @.
 *   - FAIL-CLOSED: a coordinator spawn with a missing delegate card is REFUSED — no thread
 *               starts and a structural coordinator_agents_missing error is emitted.
 *
 * REAL filesystem for HOME / CODEX_HOME / cards (no fs mocks — synthetic-fixtures lesson).
 * Runner: node:test + node:assert/strict via
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Bootstrap — before importing any project module (mirrors the ceiling test): the DB
// singleton resolves DATABASE_PATH on first use, and the governance gate + the delegate
// generator read os.homedir()/.claude/{AGENTS.md,agents/*.md}.
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-coord-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
const sandboxCwd = path.join(sandbox, 'project'); // a real cwd so checkCwdExists passes
const CARDS_DIR = path.join(sandboxHome, '.claude', 'agents');
fs.mkdirSync(CARDS_DIR, { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });

// Neutral governance so the fail-closed Codex governance gate passes and the spawn
// proceeds to the coordinator materialization + thread build.
fs.writeFileSync(
  path.join(sandboxHome, '.claude', 'AGENTS.md'),
  '# AGENTS.md — neutral nassaj governance\nplatform-agnostic instructions.\n',
);

const card = (name: string, nameAr: string): string => `---
name: ${name}
model: claude-opus-4-8
name_ar: ${nameAr}
description: ${name} role.
role: ${name} role boundary
scope: engineering
---

## الدور
بوابة الرفض: خارج التخصص → أعد للمنسّق.
`;
function seedCards(): void {
  fs.writeFileSync(path.join(CARDS_DIR, 'architect.md'), card('architect', 'المِعمار'));
  fs.writeFileSync(path.join(CARDS_DIR, 'qa-critic.md'), card('qa-critic', 'الناقد'));
}
seedCards();

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Neutralize openai-codex.js's module-level session-cleanup setInterval so the runner is
// not held alive after assertions complete.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  timer.unref();
  return timer;
} as unknown as typeof globalThis.setInterval;

// --- Mock the Codex SDK: capture the constructor options (config → agents.max_depth),
// the startThread/resumeThread options (sandbox floor) and the runStreamed input (the
// D3 contract prepend). The event stream is empty so queryCodex runs to completion. ---
type ThreadOptions = { sandboxMode?: string; approvalPolicy?: string; model?: string; [k: string]: unknown };
type CodexConstruct = { config?: Record<string, unknown>; [k: string]: unknown };

const threadStarts: { method: 'start' | 'resume'; options: ThreadOptions | undefined }[] = [];
const codexConstructions: CodexConstruct[] = [];
const runInputs: unknown[] = [];

class FakeThread {
  async runStreamed(input: unknown): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> {
    runInputs.push(input);
    async function* noEvents(): AsyncGenerator<unknown, void, unknown> {
      // intentionally empty — the assertion targets are the captured launch options.
    }
    return { events: noEvents() };
  }
}

class FakeCodex {
  constructor(options?: CodexConstruct) {
    codexConstructions.push(options ?? {});
  }

  startThread(options?: ThreadOptions): FakeThread {
    threadStarts.push({ method: 'start', options });
    return new FakeThread();
  }

  resumeThread(_id: string, options?: ThreadOptions): FakeThread {
    threadStarts.push({ method: 'resume', options });
    return new FakeThread();
  }
}

mock.module('@openai/codex-sdk', { namedExports: { Codex: FakeCodex } });

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
// eslint-disable-next-line boundaries/no-unknown
const codexModule = await import('@/openai-codex.js');
const { queryCodex, mapPermissionModeToCodexOptions } = codexModule as unknown as {
  queryCodex: (command: string, options: unknown, ws: unknown) => Promise<void>;
  mapPermissionModeToCodexOptions: (
    mode: string | undefined,
    env?: Record<string, string | undefined>,
  ) => { sandboxMode: string; approvalPolicy: string };
};
const { COORDINATOR_ROOT_CONTRACT } = await import('@/services/isolation/codex-coordinator-agents.js');

// Restore the real setInterval now that the import graph's timers are unref'd.
globalThis.setInterval = realSetInterval;

await initializeDatabase();

after(() => {
  globalThis.setInterval = realSetInterval;
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type SentMsg = Record<string, unknown>;
function makeWs(userId: number | null): { userId: number | null; send: (m: unknown) => void; sent: SentMsg[] } {
  const sent: SentMsg[] = [];
  return { userId, send: (m: unknown) => { sent.push(m as SentMsg); }, sent };
}

/** Drives queryCodex once (anonymous) and returns the ws stub + how many threads started. */
async function spawn(
  options: Record<string, unknown>,
): Promise<{ ws: ReturnType<typeof makeWs>; threadsStarted: number }> {
  const ws = makeWs(null);
  const before = threadStarts.length;
  await queryCodex('ping', { cwd: sandboxCwd, model: 'gpt-5-codex', ...options }, ws);
  return { ws, threadsStarted: threadStarts.length - before };
}

// The operator (anonymous) CODEX_HOME under the sandboxed HOME — where a coordinator
// spawn materializes its delegates.
const CODEX_AGENTS = path.join(sandboxHome, '.codex', 'agents');

// ===========================================================================
// Part 1 — parser: the coordinator branch + the default regression.
// ===========================================================================
describe('mapPermissionModeToCodexOptions — coordinator branch (T-886)', () => {
  it('coordinator ⇒ read-only / never, env-independent', () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('coordinator', {}), {
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });
    assert.deepEqual(
      mapPermissionModeToCodexOptions('coordinator', { CODEX_ALLOW_FULL_ACCESS: 'true' }),
      { sandboxMode: 'read-only', approvalPolicy: 'never' },
    );
  });

  it('default stays workspace-write / untrusted (R1 regression)', () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('default', {}), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'untrusted',
    });
  });
});

// ===========================================================================
// Part 2 — live spawn: the coordinator floor vs the untouched default.
// ===========================================================================
describe('queryCodex coordinator launch — structural floor (T-886)', () => {
  it('coordinator ⇒ read-only thread, agents.max_depth=1, contract prepend, delegates materialized', async () => {
    const beforeConstructs = codexConstructions.length;
    const beforeInputs = runInputs.length;

    const { threadsStarted } = await spawn({ permissionMode: 'coordinator' });
    assert.equal(threadsStarted, 1, 'coordinator spawn must start exactly one thread');

    // Sandbox floor.
    const opts = threadStarts[threadStarts.length - 1].options;
    assert.equal(opts?.sandboxMode, 'read-only');
    assert.equal(opts?.approvalPolicy, 'never');

    // Gate 2 — recursion cap present alongside the governance byte-cap.
    const construct = codexConstructions[codexConstructions.length - 1];
    assert.equal(construct.config?.['agents.max_depth'], 1, 'Gate 2: agents.max_depth=1');
    assert.equal(construct.config?.project_doc_max_bytes, 0, 'governance byte-cap preserved');

    // D3 — root turn input carries the delegate-only contract, prepended to the command.
    const input = runInputs[runInputs.length - 1];
    assert.equal(typeof input, 'string', 'no images ⇒ raw string turn input');
    assert.ok((input as string).startsWith(COORDINATOR_ROOT_CONTRACT), 'contract prepended at the root');
    assert.ok((input as string).includes('ping'), 'the original command survives the prepend');

    // Delegates materialized into $CODEX_HOME/agents (real fs), read-only, no @.
    for (const name of ['architect', 'qa-critic']) {
      const p = path.join(CODEX_AGENTS, `${name}.toml`);
      assert.equal(fs.existsSync(p), true, `${name}.toml must be materialized`);
      const toml = fs.readFileSync(p, 'utf8');
      assert.match(toml, new RegExp(`^name = "${name}"$`, 'm'));
      assert.match(toml, /^sandbox_mode = "read-only"$/m);
      assert.match(toml, /^model = "gpt-5-codex"$/m);
      assert.equal(toml.includes(`@${name}`), false, 'no @-prefixed delegate name');
    }

    assert.equal(codexConstructions.length, beforeConstructs + 1);
    assert.equal(runInputs.length, beforeInputs + 1);
  });

  it('default (non-coordinator) spawn is byte-for-byte unchanged (R1)', async () => {
    const { threadsStarted } = await spawn({ permissionMode: 'default' });
    assert.equal(threadsStarted, 1);

    const opts = threadStarts[threadStarts.length - 1].options;
    assert.equal(opts?.sandboxMode, 'workspace-write');
    assert.equal(opts?.approvalPolicy, 'untrusted');

    const construct = codexConstructions[codexConstructions.length - 1];
    assert.equal(construct.config?.['agents.max_depth'], undefined, 'no max_depth on a default spawn');
    assert.deepEqual(construct.config, { project_doc_max_bytes: 0 }, 'default config unchanged');

    const input = runInputs[runInputs.length - 1];
    assert.equal(input, 'ping', 'no contract prepend on a default spawn');
  });

  it('FAIL-CLOSED: coordinator spawn with a missing delegate card is REFUSED (no thread)', async () => {
    const qaPath = path.join(CARDS_DIR, 'qa-critic.md');
    const saved = fs.readFileSync(qaPath, 'utf8');
    fs.rmSync(qaPath, { force: true });
    try {
      const before = threadStarts.length;
      const ws = makeWs(null);
      await queryCodex(
        'ping',
        { cwd: sandboxCwd, model: 'gpt-5-codex', permissionMode: 'coordinator' },
        ws,
      );
      assert.equal(
        threadStarts.length,
        before,
        'no thread may start when delegates cannot be prepared',
      );
      assert.ok(
        ws.sent.some((m) => JSON.stringify(m).includes('coordinator_agents_missing')),
        'a structural coordinator_agents_missing error must be emitted',
      );
    } finally {
      fs.writeFileSync(qaPath, saved);
    }
  });
});
