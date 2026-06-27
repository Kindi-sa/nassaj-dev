/**
 * shell-websocket.pty-isolation.test.ts — PHASE-MU م1, B-MU-PTY-TEST.
 *
 * Proves the two PTY vulnerabilities sealed by B-MU-PTY-ENV and B-MU-PTY-KEY are
 * actually closed by driving the real `handleShellConnection` dispatcher:
 *
 *   1. B-MU-PTY-ENV — the spawned terminal inherits the per-user isolated env
 *      built by the central seam `resolveProviderEnv(userId, provider, ...)`
 *      (same resolver as claude-sdk.js:784), NOT the operator's raw process.env.
 *      We mock the resolver to stamp a per-user marker and assert pty.spawn
 *      received it, and assert the JWT userId + the init payload's provider were
 *      passed through verbatim.
 *
 *   2. B-MU-PTY-KEY — the session key is namespaced per authenticated user, so
 *      user B initialising the SAME projectPath + sessionId as user A spawns a
 *      FRESH pty instead of reattaching to (hijacking) user A's live process.
 *
 * node-pty (native) and resolveProviderEnv (real fs/DB) are module-mocked so the
 * test stays a pure dispatch unit test inside the websocket module boundary.
 * Runner: Node built-in test runner with --experimental-test-module-mocks (see
 * the project `test` script). No Jest/Vitest.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// --- Module mocks (must be registered before importing the service) ----------

// Capture every pty.spawn call: the env it was handed and a controllable fake
// child so the handler can register onData/onExit without a real terminal.
const spawnCalls: { env: Record<string, string | undefined> }[] = [];
function makeFakePty() {
  return {
    onData(_cb: (c: string) => void) {},
    onExit(_cb: (e: { exitCode: number; signal?: number }) => void) {},
    write(_d: string) {},
    resize(_c: number, _r: number) {},
    kill() {},
  };
}

// NB: this @types/node only types the (runtime-deprecated) defaultExport/
// namedExports option keys; the newer `exports` form is accepted at runtime but
// not yet in the type defs, so we use the typed keys to keep tsc clean.
mock.module('node-pty', {
  defaultExport: {
    spawn: (_shell: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
      spawnCalls.push({ env: opts.env });
      return makeFakePty();
    },
  },
});

// Stub the isolation seam: echo back the userId + provider so the test can prove
// the handler forwarded the JWT userId and payload provider, and that the
// resolver's output (not raw process.env) reached pty.spawn.
//
// `isolatedHomeByUser` lets the PATH-priority tests (B-90) make the seam scope a
// per-user HOME, mirroring how an isolated provider (e.g. agy) places HOME inside
// the user's tree. The default resolver behavior leaves HOME untouched, so the
// pre-existing B-MU-PTY-ENV/KEY tests are unaffected.
const resolveCalls: { userId: unknown; provider: string }[] = [];
const isolatedHomeByUser = new Map<string, string>();
mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (userId: unknown, provider: string, baseEnv: Record<string, string>) => {
      resolveCalls.push({ userId, provider });
      const isolatedHome = isolatedHomeByUser.get(String(userId));
      return {
        ...baseEnv,
        ...(isolatedHome ? { HOME: isolatedHome } : {}),
        CLAUDE_CONFIG_DIR: `/isolated/${String(userId)}/.claude`,
        __ISOLATED_FOR__: String(userId),
        __ISOLATION_PROVIDER__: provider,
      };
    },
  },
});

const { handleShellConnection } = await import('./shell-websocket.service.js');

// --- Test doubles ------------------------------------------------------------

const WS_OPEN_STATE = 1;

function makeFakeWs() {
  const sent: unknown[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN_STATE,
    sent,
    closes,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
    on(event: string, cb: (arg: unknown) => void) {
      (listeners[event] ||= []).push(cb);
    },
    emit(event: string, arg: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
    },
  };
}

const deps = {
  getSessionById: () => null,
  stripAnsiSequences: (s: string) => s,
  normalizeDetectedUrl: () => null,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
} as unknown as Parameters<typeof handleShellConnection>[2];

// A plain-shell init avoids resolving a real CLI binary while still exercising
// the full spawn path (env build + session key + map insert).
function initMessage(projectPath: string) {
  return JSON.stringify({
    type: 'init',
    projectPath,
    provider: 'claude',
    isPlainShell: true,
    initialCommand: 'true',
    cols: 80,
    rows: 24,
  });
}

// Use the real cwd as projectPath: the handler statSyncs it and requires a dir.
const PROJECT_PATH = process.cwd();

test('B-MU-PTY-ENV: PTY env comes from resolveProviderEnv(userId, provider) — not raw process.env', () => {
  spawnCalls.length = 0;
  resolveCalls.length = 0;

  const ws = makeFakeWs();
  handleShellConnection(ws as never, { user: { id: 7 } } as never, deps);
  ws.emit('message', initMessage(PROJECT_PATH));

  assert.equal(resolveCalls.length, 1, 'resolver consulted exactly once');
  assert.equal(resolveCalls[0].userId, 7, 'JWT userId forwarded to the seam');
  assert.equal(resolveCalls[0].provider, 'claude', 'payload provider forwarded to the seam');

  assert.equal(spawnCalls.length, 1, 'one pty spawned');
  const env = spawnCalls[0].env;
  assert.equal(
    env.__ISOLATED_FOR__,
    '7',
    'spawn env carries the per-user isolated marker (resolver output reached pty.spawn)'
  );
  assert.equal(
    env.CLAUDE_CONFIG_DIR,
    '/isolated/7/.claude',
    'spawn env carries the per-user CLAUDE_CONFIG_DIR'
  );
  // Terminal vars still layered on top of the isolated env.
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
});

test('B-MU-PTY-KEY: same projectPath+sessionId across two users spawns separate PTYs (no hijack)', () => {
  spawnCalls.length = 0;
  resolveCalls.length = 0;

  // User A connects and spawns.
  const wsA = makeFakeWs();
  handleShellConnection(wsA as never, { user: { id: 'alice' } } as never, deps);
  wsA.emit('message', initMessage(PROJECT_PATH));
  assert.equal(spawnCalls.length, 1, 'user A spawned a pty');

  // User B connects with the IDENTICAL init (same projectPath, default session).
  const wsB = makeFakeWs();
  handleShellConnection(wsB as never, { user: { id: 'bob' } } as never, deps);
  wsB.emit('message', initMessage(PROJECT_PATH));

  // If the key were NOT user-namespaced, B would reattach to A's session and no
  // second spawn would occur. A fresh spawn proves the keys are disjoint.
  assert.equal(spawnCalls.length, 2, 'user B got its OWN pty, never reattached to user A');
  assert.equal(resolveCalls[1].userId, 'bob', 'user B env resolved under bob, not alice');

  // And B must not have received the "Reconnected to existing session" banner.
  const reconnected = wsB.sent.some(
    (m) => typeof m === 'object' && m !== null && 'data' in m
      && typeof (m as { data: unknown }).data === 'string'
      && (m as { data: string }).data.includes('Reconnected')
  );
  assert.equal(reconnected, false, 'user B was not reconnected into another session');
});

test('B-MU-PTY-KEY (fail-closed): PTY init with no authenticated user is refused — no spawn, no shared key', () => {
  spawnCalls.length = 0;
  resolveCalls.length = 0;

  // A connection that somehow reaches the handler without request.user (i.e. the
  // verifyClient invariant was bypassed by a future change). The fail-closed gate
  // must refuse it outright rather than fall back to a shared 'anon' session key.
  const ws = makeFakeWs();
  handleShellConnection(ws as never, {} as never, deps);
  ws.emit('message', initMessage(PROJECT_PATH));

  assert.equal(spawnCalls.length, 0, 'no pty spawned for a userId-less connection');
  assert.equal(resolveCalls.length, 0, 'env resolver never consulted (no spawn path entered)');

  // The client is told auth is required and the socket is closed (policy code).
  const sentError = ws.sent.some(
    (m) => typeof m === 'object' && m !== null
      && (m as { type?: unknown }).type === 'error'
  );
  assert.equal(sentError, true, 'an error frame was sent to the client');
  assert.equal(ws.closes.length, 1, 'the connection was closed');
  assert.equal(ws.closes[0].code, 4401, 'closed with the auth-required policy code');
});

test('B-MU-PTY-KEY (fail-closed): two no-user connections never collide on a shared session key', () => {
  spawnCalls.length = 0;
  resolveCalls.length = 0;

  // Two distinct anonymous connections with the IDENTICAL init. Under the old
  // `userId ?? 'anon'` fallback they would have shared `anon_<path>_default` and
  // the second could hijack the first. Fail-closed: both are refused, neither
  // spawns, so there is no shared key to collide on.
  const wsA = makeFakeWs();
  handleShellConnection(wsA as never, {} as never, deps);
  wsA.emit('message', initMessage(PROJECT_PATH));

  const wsB = makeFakeWs();
  handleShellConnection(wsB as never, {} as never, deps);
  wsB.emit('message', initMessage(PROJECT_PATH));

  assert.equal(spawnCalls.length, 0, 'neither anonymous connection spawned a pty');
  assert.equal(wsA.closes.length, 1, 'connection A was closed');
  assert.equal(wsB.closes.length, 1, 'connection B was closed');

  // Neither got the "Reconnected" banner — there is no live session to attach to.
  const reconnected = [...wsA.sent, ...wsB.sent].some(
    (m) => typeof m === 'object' && m !== null && 'data' in m
      && typeof (m as { data: unknown }).data === 'string'
      && (m as { data: string }).data.includes('Reconnected')
  );
  assert.equal(reconnected, false, 'no anonymous reconnection/hijack occurred');
});

// --- B-90: user npm-global binaries are surfaced in the PTY PATH --------------

/**
 * Builds a throwaway project dir + a per-user isolated HOME whose
 * `.npm-global/bin` exists on disk, and registers that HOME with the mocked
 * isolation seam. Returns the paths and a single-use cleanup.
 */
function makeIsolatedUserFixture(userId: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pty-b90-${userId}-`));
  const projectDir = path.join(root, 'project');
  const isolatedHome = path.join(root, 'home');
  const npmGlobalBin = path.join(isolatedHome, '.npm-global', 'bin');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(npmGlobalBin, { recursive: true });
  isolatedHomeByUser.set(userId, isolatedHome);
  return {
    projectDir,
    isolatedHome,
    npmGlobalBin,
    cleanup() {
      isolatedHomeByUser.delete(userId);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function initForProject(projectPath: string) {
  return JSON.stringify({
    type: 'init',
    projectPath,
    provider: 'claude',
    isPlainShell: true,
    initialCommand: 'true',
    cols: 80,
    rows: 24,
  });
}

function pathEntriesOf(env: Record<string, string | undefined>): string[] {
  return String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

test("B-90: the user's npm-global bin is hoisted to the FRONT of the PTY PATH", () => {
  spawnCalls.length = 0;
  resolveCalls.length = 0;
  const fx = makeIsolatedUserFixture('npmuser');
  try {
    const ws = makeFakeWs();
    handleShellConnection(ws as never, { user: { id: 'npmuser' } } as never, deps);
    ws.emit('message', initForProject(fx.projectDir));

    assert.equal(spawnCalls.length, 1, 'one pty spawned');
    const entries = pathEntriesOf(spawnCalls[0].env);

    assert.equal(
      entries[0],
      fx.npmGlobalBin,
      "the user's <isolatedHome>/.npm-global/bin is the very first PATH entry"
    );
    // The pre-existing system PATH (from process.env, carried through the seam)
    // is preserved AFTER the hoisted user dir — never dropped, never ahead of it.
    const systemEntry = String(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .find((p) => p.startsWith('/usr') || p === '/bin' || p === '/sbin');
    if (systemEntry) {
      const userIdx = entries.indexOf(fx.npmGlobalBin);
      const sysIdx = entries.indexOf(systemEntry);
      assert.ok(sysIdx > userIdx, 'a system PATH dir sorts AFTER the user npm-global bin');
      assert.ok(entries.includes(systemEntry), 'existing system PATH entries are preserved');
    }
  } finally {
    fx.cleanup();
  }
});

test('B-90 (isolation): user A npm-global path never leaks into user B PTY PATH', () => {
  spawnCalls.length = 0;
  resolveCalls.length = 0;
  const fxA = makeIsolatedUserFixture('alice-npm');
  const fxB = makeIsolatedUserFixture('bob-npm');
  try {
    const wsA = makeFakeWs();
    handleShellConnection(wsA as never, { user: { id: 'alice-npm' } } as never, deps);
    wsA.emit('message', initForProject(fxA.projectDir));

    const wsB = makeFakeWs();
    handleShellConnection(wsB as never, { user: { id: 'bob-npm' } } as never, deps);
    wsB.emit('message', initForProject(fxB.projectDir));

    assert.equal(spawnCalls.length, 2, 'both users spawned a pty');
    const entriesA = pathEntriesOf(spawnCalls[0].env);
    const entriesB = pathEntriesOf(spawnCalls[1].env);

    // Each terminal leads with its OWN user's npm-global bin.
    assert.equal(entriesA[0], fxA.npmGlobalBin, "A's PATH leads with A's npm-global bin");
    assert.equal(entriesB[0], fxB.npmGlobalBin, "B's PATH leads with B's npm-global bin");

    // And crucially, neither user's npm-global bin appears ANYWHERE in the
    // other's PATH — isolation is preserved because the candidate is derived
    // from each user's isolated HOME, not a shared/operator home.
    assert.ok(
      !entriesB.includes(fxA.npmGlobalBin),
      "A's npm-global bin must NOT appear in B's PTY PATH"
    );
    assert.ok(
      !entriesA.includes(fxB.npmGlobalBin),
      "B's npm-global bin must NOT appear in A's PTY PATH"
    );
  } finally {
    fxA.cleanup();
    fxB.cleanup();
  }
});
