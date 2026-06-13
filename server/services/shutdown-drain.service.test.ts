import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShutdownDrain,
  resolveDrainTimeoutMs,
  DEFAULT_DRAIN_TIMEOUT_MS,
  WS_CLOSE_GOING_AWAY,
  type ShutdownDrainDeps,
} from './shutdown-drain.service.js';

// ---- test harness ---------------------------------------------------------

type Call = { name: string; args: unknown[] };

function buildHarness(overrides: Partial<ShutdownDrainDeps> & {
  /** Sequence of per-provider counts returned on successive polls. */
  countsSequence?: Record<string, number>[];
} = {}) {
  const calls: Call[] = [];
  const wsClients = [
    { close: (code?: number, reason?: string) => calls.push({ name: 'ws.close', args: [code, reason] }) },
    { close: (code?: number, reason?: string) => calls.push({ name: 'ws.close', args: [code, reason] }) },
  ];

  const countsSequence = overrides.countsSequence ?? [{ claude: 0 }];
  let pollIndex = 0;
  const countActiveSessionsByProvider = () => {
    const counts = countsSequence[Math.min(pollIndex, countsSequence.length - 1)];
    pollIndex += 1;
    return counts;
  };

  let clock = 0;
  const deps: ShutdownDrainDeps = {
    server: {
      close: () => calls.push({ name: 'server.close', args: [] }),
      closeIdleConnections: () => calls.push({ name: 'server.closeIdleConnections', args: [] }),
    },
    wss: { clients: wsClients },
    countActiveSessionsByProvider,
    stopAllPlugins: async () => { calls.push({ name: 'stopAllPlugins', args: [] }); },
    exit: (code: number) => calls.push({ name: 'exit', args: [code] }),
    pollMs: 10,
    logger: { log: () => {}, warn: () => {} },
    sleep: async (ms: number) => { clock += ms; calls.push({ name: 'sleep', args: [ms] }); },
    now: () => clock,
    ...overrides,
  };
  return { deps, calls, names: () => calls.map((c) => c.name) };
}

// ---- resolveDrainTimeoutMs -------------------------------------------------

test('resolveDrainTimeoutMs (B-41): bounded default unless an explicit value is given', () => {
  // Explicit positive integer is honoured.
  assert.equal(resolveDrainTimeoutMs('300000'), 300000);
  // Explicit "0" is an opt-in to the old no-deadline behaviour.
  assert.equal(resolveDrainTimeoutMs('0'), 0);
  // Everything invalid/unset now falls back to the SAFE bounded default,
  // never to an unbounded drain (the root of B-41).
  assert.equal(resolveDrainTimeoutMs('-5'), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(resolveDrainTimeoutMs('abc'), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(resolveDrainTimeoutMs(undefined), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(resolveDrainTimeoutMs(''), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(resolveDrainTimeoutMs('   '), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.ok(DEFAULT_DRAIN_TIMEOUT_MS > 0, 'the default must be a finite positive bound');
});

// ---- port release (B-23) ---------------------------------------------------

test('first signal releases the listener BEFORE any waiting: server.close, ws clients closed with 1001, idle connections dropped', async () => {
  const { deps, calls, names } = buildHarness({ countsSequence: [{ claude: 0 }] });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  // Release steps come first, in order, then shutdown.
  assert.deepEqual(names(), [
    'server.close',
    'ws.close',
    'ws.close',
    'server.closeIdleConnections',
    'stopAllPlugins',
    'exit',
  ]);
  const wsCloses = calls.filter((c) => c.name === 'ws.close');
  for (const c of wsCloses) {
    assert.equal(c.args[0], WS_CLOSE_GOING_AWAY);
  }
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

test('port is released immediately even when sessions are still active (the drain waits AFTER closing the listener)', async () => {
  const { deps, names } = buildHarness({
    countsSequence: [{ claude: 2 }, { claude: 1 }, { claude: 0 }],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGTERM');

  const order = names();
  assert.equal(order[0], 'server.close', 'listener must be closed before any drain wait');
  assert.ok(order.indexOf('server.close') < order.indexOf('sleep'));
  assert.deepEqual(order.at(-1), 'exit');
});

test('server.close throwing does not prevent the drain from completing', async () => {
  const { deps, names } = buildHarness({
    server: {
      close: () => { throw new Error('already closed'); },
    },
    countsSequence: [{ claude: 0 }],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  assert.ok(names().includes('exit'));
});

// ---- drain semantics (unchanged from B-N-DRAIN) ----------------------------

test('waits until all sessions finish, then stops plugins and exits 0', async () => {
  const { deps, calls } = buildHarness({
    countsSequence: [
      { claude: 2, codex: 1 },
      { claude: 1, codex: 0 },
      { claude: 0, codex: 0 },
    ],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  const sleeps = calls.filter((c) => c.name === 'sleep').length;
  assert.equal(sleeps, 2, 'one poll per non-zero count after the initial check');
  assert.deepEqual(calls.at(-2), { name: 'stopAllPlugins', args: [] });
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

test('with a deadline, exits anyway when sessions never finish', async () => {
  const { deps, calls } = buildHarness({
    countsSequence: [{ claude: 1 }],
    drainTimeoutMs: 25,
    pollMs: 10,
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGTERM');

  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
  const sleeps = calls.filter((c) => c.name === 'sleep').length;
  assert.ok(sleeps >= 2 && sleeps <= 3, `expected ~3 polls within the deadline, got ${sleeps}`);
});

test('second signal forces an immediate exit without re-running the drain', async () => {
  const { deps, calls } = buildHarness({
    countsSequence: [{ claude: 1 }, { claude: 0 }],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');
  const callsAfterFirst = calls.length;

  await drain('SIGINT');

  const extra = calls.slice(callsAfterFirst);
  assert.deepEqual(extra, [{ name: 'exit', args: [0] }], 'second signal must only exit');
});
