import assert from 'node:assert/strict';
import test from 'node:test';

import { pickAgyModelLabel, resolveAgyModelLabel } from './agy-cli.js';

// Mirrors the shape of the dynamic antigravity catalog OPTIONS: each model
// carries the `value` (modelId the UI sends) and the `label` (display name agy's
// --model flag expects). See antigravity-catalog.client.ts.
const CATALOG_OPTIONS = [
  { value: 'auto', label: 'agy default' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Low)' },
  { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro (High)' },
  { value: 'claude-opus-4.6', label: 'Claude Opus 4.6 (Thinking)' },
];

// ---- pickAgyModelLabel: pure value -> label conversion -------------------

test('pickAgyModelLabel maps a catalog value (modelId) to its display label', () => {
  assert.deepEqual(
    pickAgyModelLabel('gemini-3.5-flash', CATALOG_OPTIONS),
    { label: 'Gemini 3.5 Flash (Low)', matched: true },
  );
  assert.deepEqual(
    pickAgyModelLabel('claude-opus-4.6', CATALOG_OPTIONS),
    { label: 'Claude Opus 4.6 (Thinking)', matched: true },
  );
});

test('pickAgyModelLabel accepts a value that is already a known label', () => {
  assert.deepEqual(
    pickAgyModelLabel('Gemini 3.1 Pro (High)', CATALOG_OPTIONS),
    { label: 'Gemini 3.1 Pro (High)', matched: true },
  );
});

test('pickAgyModelLabel returns null label for auto / empty / whitespace (omit --model)', () => {
  for (const input of ['auto', 'AUTO', ' Auto ', '', '   ']) {
    assert.deepEqual(
      pickAgyModelLabel(input, CATALOG_OPTIONS),
      { label: null, matched: false },
      `input ${JSON.stringify(input)} must omit --model`,
    );
  }
});

test('pickAgyModelLabel returns null label for non-string model', () => {
  assert.deepEqual(pickAgyModelLabel(undefined, CATALOG_OPTIONS), { label: null, matched: false });
  assert.deepEqual(pickAgyModelLabel(null, CATALOG_OPTIONS), { label: null, matched: false });
});

test('pickAgyModelLabel passes an unknown model through as-is, flagged unmatched', () => {
  assert.deepEqual(
    pickAgyModelLabel('brand-new-model-x', CATALOG_OPTIONS),
    { label: 'brand-new-model-x', matched: false },
  );
});

test('pickAgyModelLabel best-effort passes through when the catalog is empty/missing', () => {
  assert.deepEqual(pickAgyModelLabel('gemini-3.5-flash', []), { label: 'gemini-3.5-flash', matched: false });
  assert.deepEqual(pickAgyModelLabel('gemini-3.5-flash', undefined), { label: 'gemini-3.5-flash', matched: false });
});

// ---- resolveAgyModelLabel: auto/empty short-circuit (no catalog touch) ----

test('resolveAgyModelLabel short-circuits to null for auto / empty without touching the catalog', async () => {
  for (const input of ['auto', '', '   ', 'AUTO']) {
    assert.equal(await resolveAgyModelLabel(input), null, `input ${JSON.stringify(input)} must resolve to null`);
  }
  // Non-string inputs also short-circuit to null.
  assert.equal(await resolveAgyModelLabel(undefined), null);
  assert.equal(await resolveAgyModelLabel(null), null);
});
