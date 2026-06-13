import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listenWithGuard,
  resolveBindWindowMs,
  type ListenWithGuardDeps,
} from './listen-with-guard.service.js';

type Call = { name: string; args: unknown[] };

/**
 * Builds a fake http.Server whose listen() outcome is scripted per attempt.
 * `outcomes[i]` controls attempt i: 'ok' -> calls the listening callback;
 * 'inuse' -> emits an EADDRINUSE error; 'fatal' -> emits a generic error.
 */
function buildHarness(
  outcomes: Array<'ok' | 'inuse' | 'fatal'>,
  overrides: Partial<ListenWithGuardDeps> = {},
) {
  const calls: Call[] = [];
  let attemptIndex = 0;
  let errorListener: ((err: NodeJS.ErrnoException) => void) | null = null;

  const server: ListenWithGuardDeps['server'] = {
    once: (_event, listener) => {
      errorListener = listener;
      return server;
    },
    removeListener: () => {
      errorListener = null;
      calls.push({ name: 'removeListener', args: [] });
      return server;
    },
    listen: (port, host, callback) => {
      const outcome = outcomes[Math.min(attemptIndex, outcomes.length - 1)];
      attemptIndex += 1;
      calls.push({ name: 'listen', args: [port, host] });
      // Resolve asynchronously, mirroring net.Server semantics.
      queueMicrotask(() => {
        if (outcome === 'ok') {
          callback();
        } else if (outcome === 'inuse') {
          const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          errorListener?.(err);
        } else {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          errorListener?.(err);
        }
      });
      return server;
    },
  };

  let clock = 0;
  const deps: ListenWithGuardDeps = {
    server,
    port: 3004,
    host: '0.0.0.0',
    onListening: () => calls.push({ name: 'onListening', args: [] }),
    exit: (code: number) => calls.push({ name: 'exit', args: [code] }),
    bindWindowMs: 2000,
    retryDelayMs: 500,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    sleep: async (ms: number) => { clock += ms; calls.push({ name: 'sleep', args: [ms] }); },
    now: () => clock,
    ...overrides,
  };

  return { deps, calls, names: () => calls.map((c) => c.name) };
}

test('resolveBindWindowMs: honours non-negative integers, falls back otherwise', () => {
  assert.equal(resolveBindWindowMs('12000'), 12000);
  assert.equal(resolveBindWindowMs('0'), 0);
  assert.equal(resolveBindWindowMs('-1'), 8000);
  assert.equal(resolveBindWindowMs('abc'), 8000);
  assert.equal(resolveBindWindowMs(undefined), 8000);
  assert.equal(resolveBindWindowMs('', 5000), 5000);
});

test('binds on first attempt: calls onListening, never exits, drops the transient error listener', async () => {
  const { deps, calls, names } = buildHarness(['ok']);

  await listenWithGuard(deps);

  assert.ok(names().includes('onListening'), 'onListening must fire');
  assert.ok(names().includes('removeListener'), 'transient error listener removed after bind');
  assert.ok(!names().includes('exit'), 'a clean first bind must not exit');
  assert.equal(calls.filter((c) => c.name === 'listen').length, 1);
});

test('tolerates a brief EADDRINUSE overlap then binds (healthy drain handoff)', async () => {
  // Two in-use attempts (predecessor still draining) then success.
  const { deps, calls, names } = buildHarness(['inuse', 'inuse', 'ok']);

  await listenWithGuard(deps);

  assert.equal(calls.filter((c) => c.name === 'listen').length, 3, 'retried until bound');
  assert.equal(calls.filter((c) => c.name === 'sleep').length, 2, 'backed off between retries');
  assert.ok(names().includes('onListening'));
  assert.ok(!names().includes('exit'), 'a successful late bind must not exit');
});

test('wedged predecessor: exits cleanly with 0 after the bind window (no crash-loop)', async () => {
  // Always in use; window 2000ms / retry 500ms -> ~4 retries then give up.
  const { deps, calls } = buildHarness(['inuse'], { bindWindowMs: 2000, retryDelayMs: 500 });

  await listenWithGuard(deps);

  // The decisive B-41 guarantee: a held port yields a CLEAN exit, never code 1.
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
  assert.ok(
    !calls.some((c) => c.name === 'exit' && c.args[0] === 1),
    'EADDRINUSE must never produce a crash exit (code 1)',
  );
});

test('a non-EADDRINUSE bind error is fatal: exits 1', async () => {
  const { deps, calls } = buildHarness(['fatal']);

  await listenWithGuard(deps);

  assert.deepEqual(calls.at(-1), { name: 'exit', args: [1] });
  assert.ok(!calls.some((c) => c.name === 'onListening'));
});

test('bindWindowMs=0 gives exactly one attempt before a clean give-up', async () => {
  const { deps, calls } = buildHarness(['inuse'], { bindWindowMs: 0 });

  await listenWithGuard(deps);

  assert.equal(calls.filter((c) => c.name === 'listen').length, 1, 'single bounded attempt');
  assert.equal(calls.filter((c) => c.name === 'sleep').length, 0, 'no backoff sleep when window is 0');
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});
