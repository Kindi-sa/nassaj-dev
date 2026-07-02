/**
 * ADR-053 §ج-1..ج-4 — the full supervisor gauntlet (processIntent), the
 * isolation --setenv computation, and the chat→intent bridge no-op.
 *
 * processIntent runs GATE2 (ownership) BEFORE concurrency BEFORE launch, so an
 * unauthorized intent never consumes a concurrency probe and NOTHING privileged
 * runs for it. All deps are injected — no DB, no systemd, no disk — so the order
 * and the fail-closed guarantees are asserted deterministically.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { processIntent, type ProcessIntentDeps } from '@/modules/workflow-supervisor/supervisor-core.js';
import { computeIsolationSetenv } from '@/modules/workflow-supervisor/systemd.js';
import { writeLaunchIntent } from '@/modules/workflow-supervisor/launch-intent.js';

function baseDeps(over: Partial<ProcessIntentDeps> = {}): {
  deps: ProcessIntentDeps;
  launched: Array<{ userId: number; wfLaunchId: string }>;
  concurrencyProbed: number[];
  written: string[];
} {
  const launched: Array<{ userId: number; wfLaunchId: string }> = [];
  const concurrencyProbed: number[] = [];
  const written: string[] = [];
  const deps: ProcessIntentDeps = {
    authorize: {
      isOwnedOrMembered: () => true, // owner by default
      resolveEnv: (userId) => ({ CLAUDE_CONFIG_DIR: `/home/nassaj/.nassaj-users/${userId}/.claude` }),
    },
    listActiveScopes: async (userId) => {
      concurrencyProbed.push(userId);
      return []; // under cap by default
    },
    launchScope: async ({ intent }) => {
      launched.push({ userId: intent.userId, wfLaunchId: intent.wfLaunchId });
      return `wf-${intent.wfLaunchId}.service`;
    },
    writeRecord: async (wfLaunchId) => {
      written.push(wfLaunchId);
    },
    ...over,
  };
  return { deps, launched, concurrencyProbed, written };
}

const goodIntent = {
  wfLaunchId: 'l-1',
  userId: 5,
  projectPath: '/tmp/proj',
  scriptOrPrompt: 'do it',
  requestedAt: new Date().toISOString(),
};

test('processIntent: happy path launches and writes supervisor.json at the moment of launch', async () => {
  const { deps, launched, written } = baseDeps();
  const out = await processIntent(goodIntent, deps);
  assert.equal(out.status, 'launched');
  assert.deepEqual(launched, [{ userId: 5, wfLaunchId: 'l-1' }]);
  assert.deepEqual(written, ['l-1'], 'record written on launch (not on completion)');
});

test('processIntent: a NON-OWNER is denied BEFORE the concurrency probe and BEFORE any launch (GATE2 first)', async () => {
  const { deps, launched, concurrencyProbed, written } = baseDeps({
    authorize: {
      isOwnedOrMembered: () => false, // NOT owner
      resolveEnv: () => {
        throw new Error('resolveEnv must not be called on a deny');
      },
    },
  });
  const out = await processIntent(goodIntent, deps);
  assert.equal(out.status, 'denied');
  assert.equal(concurrencyProbed.length, 0, 'ownership denial short-circuits BEFORE concurrency');
  assert.equal(launched.length, 0, 'nothing launched');
  assert.equal(written.length, 0, 'nothing recorded');
});

test('processIntent: a non-integer userId is denied (fail-closed), no launch', async () => {
  const { deps, launched } = baseDeps();
  const out = await processIntent({ ...goodIntent, userId: 'abc' }, deps);
  assert.equal(out.status, 'denied');
  assert.equal(launched.length, 0);
});

test('processIntent: over the concurrency cap => queued, NOT launched (intent left for a later tick)', async () => {
  const { deps, launched } = baseDeps({
    listActiveScopes: async () => ['a.service', 'b.service', 'c.service'], // == default cap 3
  });
  const out = await processIntent(goodIntent, { ...deps, env: {} });
  assert.equal(out.status, 'queued');
  assert.equal(launched.length, 0, 'a queued intent must not launch');
});

test('processIntent: a throwing launcher yields error (surfaced, not silently swallowed)', async () => {
  const { deps } = baseDeps({
    launchScope: async () => {
      throw new Error('systemd-run failed');
    },
  });
  const out = await processIntent(goodIntent, deps);
  assert.equal(out.status, 'error');
  if (out.status === 'error') assert.match(out.reason, /scope launch failed/);
});

// --- isolation --setenv computation (a transient unit inherits NOTHING) --------

test('computeIsolationSetenv: forwards CLAUDE_CONFIG_DIR even when it equals the base env (never dropped)', () => {
  const base = { CLAUDE_CONFIG_DIR: '/same/dir', PATH: '/usr/bin' };
  const resolved = { CLAUDE_CONFIG_DIR: '/same/dir', PATH: '/usr/bin' };
  const setenv = computeIsolationSetenv(resolved, base);
  assert.equal(
    setenv.CLAUDE_CONFIG_DIR,
    '/same/dir',
    'the ToS key is forwarded unconditionally — a transient unit inherits nothing, so an omitted key = wrong isolation',
  );
  assert.equal(setenv.PATH, undefined, 'a non-isolation key equal to base is NOT forwarded (no full-env leak)');
});

test('computeIsolationSetenv: forwards a changed isolation key and any other differing key, not the inherited bulk', () => {
  const base = { CLAUDE_CONFIG_DIR: '/owner/.claude', PATH: '/usr/bin', HOME: '/home/nassaj' };
  const resolved = { CLAUDE_CONFIG_DIR: '/home/nassaj/.nassaj-users/9/.claude', PATH: '/usr/bin', EXTRA: 'x' };
  const setenv = computeIsolationSetenv(resolved, base);
  assert.equal(setenv.CLAUDE_CONFIG_DIR, '/home/nassaj/.nassaj-users/9/.claude', 'per-user dir forwarded');
  assert.equal(setenv.EXTRA, 'x', 'a differing key is forwarded (future isolation key safety)');
  assert.equal(setenv.PATH, undefined, 'unchanged bulk env not forwarded');
  assert.equal('HOME' in setenv, false, 'base-only key not forwarded');
});

// --- chat → intent bridge no-op (master flag OFF) ------------------------------

test('writeLaunchIntent: HARD NO-OP when WORKFLOW_SUPERVISOR is off (writes nothing)', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-bridge-off-'));
  try {
    const res = await writeLaunchIntent({
      userId: 3,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'work',
      pendingWorkflows: 2,
      env: { WORKFLOW_SUPERVISOR_STATE_DIR: tempRoot }, // flag intentionally ABSENT => off
    });
    assert.equal(res.written, false);
    if (!res.written) assert.match(res.reason, /flag off/);
    // Nothing at all should have been created under the state dir.
    const entries = await readdir(tempRoot).catch(() => []);
    assert.deepEqual(entries, [], 'no intent file written while the flag is off');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('writeLaunchIntent: no-op when no workflow was requested this turn (pendingWorkflows=0) even with the flag ON', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-bridge-nowf-'));
  try {
    const res = await writeLaunchIntent({
      userId: 3,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'work',
      pendingWorkflows: 0,
      env: { WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_STATE_DIR: tempRoot },
    });
    assert.equal(res.written, false);
    if (!res.written) assert.match(res.reason, /no workflow requested/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('writeLaunchIntent: with the flag ON + a requested workflow, writes a VALID atomic intent', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-bridge-on-'));
  try {
    const res = await writeLaunchIntent({
      userId: 8,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'run the workflow',
      pendingWorkflows: 1,
      model: 'opus',
      env: { WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_STATE_DIR: tempRoot },
    });
    assert.equal(res.written, true);
    if (res.written) {
      const blob = JSON.parse(await readFile(res.path, 'utf8'));
      assert.equal(blob.userId, 8);
      assert.equal(blob.projectPath, '/tmp/proj');
      assert.equal(blob.model, 'opus');
      assert.equal(typeof blob.wfLaunchId, 'string');
      // The intent lives under intents/<userId>/.
      assert.match(res.path, /\/intents\/8\/.+\.json$/);
      // No leftover tmp file (atomic rename).
      const files = await readdir(path.dirname(res.path));
      assert.ok(files.every((f) => !f.includes('.tmp-')), 'no .tmp- file lingers after atomic write');
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('writeLaunchIntent: a non-integer userId is a no-op (fail-closed) even with the flag ON', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-bridge-badid-'));
  try {
    const res = await writeLaunchIntent({
      userId: undefined,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'work',
      pendingWorkflows: 1,
      env: { WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_STATE_DIR: tempRoot },
    });
    assert.equal(res.written, false);
    if (!res.written) assert.match(res.reason, /no authenticated integer userId/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
