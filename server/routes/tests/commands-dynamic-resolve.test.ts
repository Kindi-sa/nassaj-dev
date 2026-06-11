/**
 * Tests for resolveDynamicBuiltIns (server/routes/commands.js) — the
 * stale-while-revalidate + cold-start-wait policy behind /api/commands/list
 * (T-75).
 *
 * Coverage:
 *  1. Non-Claude providers always get the static list (no probe).
 *  2. Cold cache + fast probe -> the FIRST request already returns the merged
 *     list (the UI fetches once per project selection, so "static now / full
 *     next time" left the menu incomplete — the original T-75 symptom).
 *  3. Cold cache + slow probe -> bounded wait, static fallback now, merged on
 *     the next request once the probe lands.
 *  4. Expired cache entry -> served STALE immediately (no regression to the
 *     static-only list) while a background refresh updates the cache.
 *  5. Single-flight: concurrent cold requests share one probe.
 *
 * The SDK probe (getClaudeBuiltInCommands in server/claude-sdk.js) is replaced
 * with node:test module mocking — registered BEFORE commands.js is imported —
 * so no Claude process is ever spawned. COMMANDS_COLD_PROBE_WAIT_MS is pinned
 * low via env (read at module load) to keep the timeout path fast.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

// Must be set before commands.js loads (the constant is read at module scope).
process.env.COMMANDS_COLD_PROBE_WAIT_MS = '120';

// Controllable stand-in for the SDK probe. Each test assigns probeImpl.
let probeImpl: () => Promise<unknown> = async () => null;
let probeCalls = 0;

const claudeSdkUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../claude-sdk.js')
).href;

// Register ONCE (node:test forbids re-mocking a specifier). Only the named
// export commands.js consumes needs a real implementation.
mock.module(claudeSdkUrl, {
  namedExports: {
    getClaudeBuiltInCommands: (..._args: unknown[]) => {
      probeCalls += 1;
      return probeImpl();
    },
  },
});

const commandsModule = await import('../commands.js');
const {
  resolveDynamicBuiltIns,
  builtInCommands,
  _resetDynamicBuiltInsForTests,
  _seedDynamicBuiltInsForTests,
} = commandsModule as unknown as {
  resolveDynamicBuiltIns: (
    provider: string,
    context: Record<string, unknown>
  ) => Promise<Array<{ name: string; metadata?: Record<string, unknown> }>>;
  builtInCommands: Array<{ name: string }>;
  _resetDynamicBuiltInsForTests: () => void;
  _seedDynamicBuiltInsForTests: (
    provider: string,
    commands: unknown[],
    expiresAt: number
  ) => void;
};

const CONTEXT = { userId: 1, cwd: '/tmp' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.beforeEach(() => {
  _resetDynamicBuiltInsForTests();
  probeCalls = 0;
  probeImpl = async () => null;
});

test('non-claude provider returns the static list and never probes', async () => {
  const list = await resolveDynamicBuiltIns('cursor', CONTEXT);
  assert.deepEqual(list, builtInCommands);
  assert.equal(probeCalls, 0);
});

test('cold cache + fast probe: FIRST request already includes dynamic commands', async () => {
  probeImpl = async () => [
    { name: 'context', description: 'Show current context usage' },
  ];

  const list = await resolveDynamicBuiltIns('claude', CONTEXT);

  const added = list.find((c) => c.name === '/context');
  assert.ok(added, 'dynamic /context must be present on the first request');
  assert.equal(added?.metadata?.hasHandler, false, 'dynamic commands are passthrough');
  // Static layer intact underneath.
  for (const staticCmd of builtInCommands) {
    assert.ok(list.some((c) => c.name === staticCmd.name));
  }
});

test('cold cache + slow probe: static fallback now, merged once the probe lands', async () => {
  // Probe resolves AFTER the 120ms cold wait.
  probeImpl = async () => {
    await sleep(300);
    return [{ name: 'insights', description: 'Generate a usage report' }];
  };

  const first = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.deepEqual(first, builtInCommands, 'cold overrun must fall back to static');

  // Let the in-flight probe finish populating the cache.
  await sleep(350);

  const second = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.ok(
    second.some((c) => c.name === '/insights'),
    'next request must see the cached dynamic command'
  );
  assert.equal(probeCalls, 1, 'the overrun probe must be reused, not re-spawned');
});

test('expired cache: serves the STALE merged list immediately, refreshes in background', async () => {
  _seedDynamicBuiltInsForTests(
    'claude',
    [{ name: 'goal', description: 'Set a goal' }],
    Date.now() - 1000 // already expired
  );
  // Background refresh is slow AND returns a different set.
  probeImpl = async () => {
    await sleep(150);
    return [{ name: 'usage-credits', description: 'Configure usage credits' }];
  };

  const stale = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.ok(
    stale.some((c) => c.name === '/goal'),
    'expired entry must still be served (no regression to static-only)'
  );
  assert.equal(probeCalls, 1, 'a background refresh must have been triggered');

  await sleep(250);

  const refreshed = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.ok(
    refreshed.some((c) => c.name === '/usage-credits'),
    'after the background refresh the new set must be served'
  );
  assert.ok(
    !refreshed.some((c) => c.name === '/goal'),
    'the stale set must have been replaced'
  );
});

test('single-flight: concurrent cold requests share one probe', async () => {
  probeImpl = async () => {
    await sleep(50);
    return [{ name: 'team-onboarding', description: 'Onboarding guide' }];
  };

  const [a, b, c] = await Promise.all([
    resolveDynamicBuiltIns('claude', CONTEXT),
    resolveDynamicBuiltIns('claude', CONTEXT),
    resolveDynamicBuiltIns('claude', CONTEXT),
  ]);

  assert.equal(probeCalls, 1, 'concurrent requests must coalesce into one probe');
  for (const list of [a, b, c]) {
    assert.ok(list.some((cmd) => cmd.name === '/team-onboarding'));
  }
});
