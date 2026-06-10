import assert from 'node:assert/strict';
import test from 'node:test';

import { createChallengeStore } from './webauthn-challenge.store.js';

test('challenge store: consume returns the stored userId once, then null (single use)', () => {
  const store = createChallengeStore();
  store.store('chal-1', 42);

  assert.deepEqual(store.consume('chal-1'), { userId: 42 });
  assert.equal(store.consume('chal-1'), null, 'second consume (replay) rejected');
});

test('challenge store: anonymous challenges carry userId null', () => {
  const store = createChallengeStore();
  store.store('anon-1');

  assert.deepEqual(store.consume('anon-1'), { userId: null });
});

test('challenge store: unknown or invalid challenge returns null', () => {
  const store = createChallengeStore();
  assert.equal(store.consume('never-stored'), null);
  assert.equal(store.consume(''), null);
  // @ts-expect-error deliberately wrong type
  assert.equal(store.consume(undefined), null);
});

test('challenge store: expired challenge is rejected and removed', async () => {
  const store = createChallengeStore({ ttlMs: 5 });
  store.store('soon-stale', 7);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(store.consume('soon-stale'), null, 'expired challenge rejected');
  assert.equal(store.size, 0, 'expired entry removed on consume');
});

test('challenge store: lazy prune evicts expired entries once the map is large', async () => {
  const store = createChallengeStore({ ttlMs: 5 });
  for (let i = 0; i < 1000; i += 1) {
    store.store(`stale-${i}`, i);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  // This store() crosses the prune threshold and sweeps the expired entries.
  store.store('fresh', 1);

  assert.equal(store.size, 1, 'only the fresh challenge survives the sweep');
  assert.deepEqual(store.consume('fresh'), { userId: 1 });
});
