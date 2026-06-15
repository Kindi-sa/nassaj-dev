import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPlatformFirstUserOwnsSubscription,
  assertSubscriptionOAuthOwnerOnly,
  isSubscriptionOAuthCredential,
} from './subscription-oauth-guard.js';

const OWNER = { id: 1, role: 'owner' };
const MEMBER = { id: 2, role: 'user' };
const ADMIN = { id: 3, role: 'admin' };

/** A bare OAuth-token env (subscription path) with no API key / cloud flags. */
const SUBSCRIPTION_ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-deadbeef' };

/** Creates a temp CLAUDE_CONFIG_DIR optionally seeded with .credentials.json. */
function makeConfigDir(credentialsContents) {
  const dir = mkdtempSync(join(tmpdir(), 'sub-oauth-guard-test-'));
  if (credentialsContents !== undefined) {
    writeFileSync(join(dir, '.credentials.json'), credentialsContents, 'utf8');
  }
  return dir;
}

// --- isSubscriptionOAuthCredential: detector contract ---

test('detector: explicit CLAUDE_CODE_OAUTH_TOKEN -> subscription (true)', () => {
  assert.equal(isSubscriptionOAuthCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }), true);
});

test('detector: ANTHROPIC_API_KEY=sk-ant-* -> NOT subscription (false), even with an OAuth token also set', () => {
  assert.equal(isSubscriptionOAuthCredential({ ANTHROPIC_API_KEY: 'sk-ant-api03-zzz' }), false);
  // API key wins precedence over an OAuth token, mirroring SDK/CLI resolution.
  assert.equal(
    isSubscriptionOAuthCredential({
      ANTHROPIC_API_KEY: 'sk-ant-api03-zzz',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-zzz',
    }),
    false
  );
});

test('detector: a non-sk-ant ANTHROPIC_API_KEY does NOT relax the gate (fail closed -> subscription)', () => {
  // An empty / malformed key is not a real API key; the gate stays on.
  assert.equal(isSubscriptionOAuthCredential({ ANTHROPIC_API_KEY: '' }), true);
  assert.equal(isSubscriptionOAuthCredential({ ANTHROPIC_API_KEY: 'not-a-real-key' }), true);
});

test('detector: Bedrock or Vertex mode -> NOT subscription (false)', () => {
  assert.equal(isSubscriptionOAuthCredential({ CLAUDE_CODE_USE_BEDROCK: '1' }), false);
  assert.equal(isSubscriptionOAuthCredential({ CLAUDE_CODE_USE_VERTEX: 'true' }), false);
  // A subscription token present but Bedrock on -> still cloud (false).
  assert.equal(
    isSubscriptionOAuthCredential({ CLAUDE_CODE_USE_BEDROCK: 'yes', CLAUDE_CODE_OAUTH_TOKEN: 'x' }),
    false
  );
});

test('detector: ambiguous env (no key, no cloud, no token) -> subscription (true, fail closed)', () => {
  // Use a HOME with no ~/.claude so the file probe is also negative, isolating
  // the ambiguous default. CLAUDE_CONFIG_DIR points at an empty temp dir.
  const emptyDir = makeConfigDir(); // no .credentials.json written
  assert.equal(isSubscriptionOAuthCredential({ CLAUDE_CONFIG_DIR: emptyDir }), true);
});

test('detector: OAuth .credentials.json present in CLAUDE_CONFIG_DIR -> subscription (true)', () => {
  const dir = makeConfigDir(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
  // No API key / cloud flags -> the file confirms the subscription positively.
  assert.equal(isSubscriptionOAuthCredential({ CLAUDE_CONFIG_DIR: dir }), true);
});

// --- assertSubscriptionOAuthOwnerOnly: owner-always-passes + fail-closed ---

test('owner + subscription -> doesNotThrow', () => {
  assert.doesNotThrow(() => assertSubscriptionOAuthOwnerOnly(SUBSCRIPTION_ENV, OWNER));
});

test('member + subscription -> throws SUBSCRIPTION_OAUTH_NON_OWNER (named, actionable)', () => {
  assert.throws(
    () => assertSubscriptionOAuthOwnerOnly(SUBSCRIPTION_ENV, MEMBER),
    (err) => {
      assert.equal(err.code, 'SUBSCRIPTION_OAUTH_NON_OWNER');
      assert.match(err.message, /subscription/i);
      assert.match(err.message, /ANTHROPIC_API_KEY|Bedrock|Vertex/);
      return true;
    }
  );
});

test('null / undefined user + subscription -> throws (unknown role treated as non-owner)', () => {
  assert.throws(
    () => assertSubscriptionOAuthOwnerOnly(SUBSCRIPTION_ENV, null),
    (err) => err.code === 'SUBSCRIPTION_OAUTH_NON_OWNER'
  );
  assert.throws(
    () => assertSubscriptionOAuthOwnerOnly(SUBSCRIPTION_ENV, undefined),
    (err) => err.code === 'SUBSCRIPTION_OAUTH_NON_OWNER'
  );
  // A user object with no/blank role is also non-owner.
  assert.throws(
    () => assertSubscriptionOAuthOwnerOnly(SUBSCRIPTION_ENV, { id: 9 }),
    (err) => err.code === 'SUBSCRIPTION_OAUTH_NON_OWNER'
  );
});

test('member + ANTHROPIC_API_KEY=sk-ant- -> doesNotThrow (API key is per-user licensable)', () => {
  assert.doesNotThrow(() =>
    assertSubscriptionOAuthOwnerOnly({ ANTHROPIC_API_KEY: 'sk-ant-api03-abc' }, MEMBER)
  );
});

test('member + CLAUDE_CODE_USE_BEDROCK=1 -> doesNotThrow (cloud credential)', () => {
  assert.doesNotThrow(() =>
    assertSubscriptionOAuthOwnerOnly({ CLAUDE_CODE_USE_BEDROCK: '1' }, MEMBER)
  );
});

test('member + CLAUDE_CODE_USE_VERTEX=true -> doesNotThrow (cloud credential)', () => {
  assert.doesNotThrow(() =>
    assertSubscriptionOAuthOwnerOnly({ CLAUDE_CODE_USE_VERTEX: 'true' }, MEMBER)
  );
});

test('ambiguous env + non-owner -> throws (fail closed)', () => {
  const emptyDir = makeConfigDir();
  assert.throws(
    () => assertSubscriptionOAuthOwnerOnly({ CLAUDE_CONFIG_DIR: emptyDir }, MEMBER),
    (err) => err.code === 'SUBSCRIPTION_OAUTH_NON_OWNER'
  );
});

test('admin (non-owner) + subscription -> throws (only the owner may use the seat)', () => {
  assert.throws(
    () => assertSubscriptionOAuthOwnerOnly(SUBSCRIPTION_ENV, ADMIN),
    (err) => err.code === 'SUBSCRIPTION_OAUTH_NON_OWNER'
  );
});

// --- Chokepoint test: platform-mode hardening (assertPlatformFirstUserOwnsSubscription) ---
// Mirrors the auth.js platform branches, where userDb.getFirstUser() is the sole
// deployment user and must own the subscription for Claude runs to be allowed.

test('chokepoint (platform): owner sole user + subscription -> doesNotThrow', () => {
  assert.doesNotThrow(() => assertPlatformFirstUserOwnsSubscription(OWNER, SUBSCRIPTION_ENV));
});

test('chokepoint (platform): non-owner sole user + subscription -> throws SUBSCRIPTION_OAUTH_NON_OWNER', () => {
  assert.throws(
    () => assertPlatformFirstUserOwnsSubscription(MEMBER, SUBSCRIPTION_ENV),
    (err) => err.code === 'SUBSCRIPTION_OAUTH_NON_OWNER'
  );
});

test('chokepoint (platform): non-owner sole user + API key -> doesNotThrow (per-user licensable)', () => {
  assert.doesNotThrow(() =>
    assertPlatformFirstUserOwnsSubscription(MEMBER, { ANTHROPIC_API_KEY: 'sk-ant-api03-abc' })
  );
});

test('chokepoint (platform): no user resolved -> doesNotThrow (caller handles missing user)', () => {
  assert.doesNotThrow(() => assertPlatformFirstUserOwnsSubscription(null, SUBSCRIPTION_ENV));
  assert.doesNotThrow(() => assertPlatformFirstUserOwnsSubscription(undefined, SUBSCRIPTION_ENV));
});
