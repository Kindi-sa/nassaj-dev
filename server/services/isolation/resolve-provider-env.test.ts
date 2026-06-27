/**
 * resolve-provider-env.test.ts — vendor (kimi/deepseek/glm) key injection + the
 * IRON RULE positive assertions (B-VR-2B / C-VR-7).
 *
 * This complements isolation.e2e.test.ts (which covers the first-party CLI
 * CONFIG_DIR/HOME overrides). Here we prove the OPPOSITE isolation shape used by
 * hosted vendors: resolveProviderEnv fetches the per-user key from the encrypted
 * secrets store and injects it as the provider's own env VALUE, and — the load-
 * bearing guarantee — never sets any key under the ANTHROPIC or CLAUDE namespace.
 *
 * Bootstrap mirrors isolation.e2e.test.ts: a sandboxed $HOME (honored by
 * os.homedir on this platform) and a throwaway DB opened before importing any
 * project module, plus a pinned NASSAJ_PROVIDER_SECRETS_KEY so the secrets store
 * encrypts deterministically. Runner: node:test + node:assert/strict (no vitest).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-resolve-env-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('../provider-sharing.js');
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const { setProviderKey, _resetProviderSecretsServerKeyCache } = await import('./provider-secrets-store.js');

await initializeDatabase();

/** Force the vendor providers isolated (their default) for deterministic runs. */
function isolateVendors(): void {
  _resetProviderSharingCache();
  setProviderSharingConfig({ kimi: 'isolated', deepseek: 'isolated', glm: 'isolated' });
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const VENDOR_KEY_ENV: Record<string, string> = {
  kimi: 'KIMI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  glm: 'GLM_API_KEY',
};

/** Asserts an env carries no key under the ANTHROPIC or CLAUDE namespace. */
function assertNoAnthropicNamespace(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    assert.ok(
      !/^ANTHROPIC_/.test(name) && !/^CLAUDE_/.test(name),
      `iron rule: env must not contain "${name}"`,
    );
  }
}

describe('resolveProviderEnv — hosted vendor key injection', () => {
  for (const provider of ['kimi', 'deepseek', 'glm'] as const) {
    it(`injects ${VENDOR_KEY_ENV[provider]} from the per-user store`, () => {
      isolateVendors();
      _resetProviderSecretsServerKeyCache();
      setProviderKey(100, provider, `sk-${provider}-live`);

      const env = resolveProviderEnv(100, provider, { PATH: '/usr/bin' });
      assert.equal(env[VENDOR_KEY_ENV[provider]], `sk-${provider}-live`);
    });

    it(`${provider}: never sets any ANTHROPIC_*/CLAUDE_* var (IRON RULE)`, () => {
      isolateVendors();
      _resetProviderSecretsServerKeyCache();
      setProviderKey(100, provider, `sk-${provider}-live`);

      const env = resolveProviderEnv(100, provider, { PATH: '/usr/bin' });
      assertNoAnthropicNamespace(env);
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    });
  }

  it('does not inject a key for a user that has none (absence is no-op)', () => {
    isolateVendors();
    _resetProviderSecretsServerKeyCache();
    // user 200 has no stored key
    const env = resolveProviderEnv(200, 'kimi', { PATH: '/usr/bin' });
    assert.equal(env.KIMI_API_KEY, undefined);
  });

  it('per-user isolation: two users get only their own injected key', () => {
    isolateVendors();
    _resetProviderSecretsServerKeyCache();
    setProviderKey(301, 'deepseek', 'sk-user301');
    setProviderKey(302, 'deepseek', 'sk-user302');

    const env301 = resolveProviderEnv(301, 'deepseek', { PATH: '/usr/bin' });
    const env302 = resolveProviderEnv(302, 'deepseek', { PATH: '/usr/bin' });

    assert.equal(env301.DEEPSEEK_API_KEY, 'sk-user301');
    assert.equal(env302.DEEPSEEK_API_KEY, 'sk-user302');
    assert.notEqual(env301.DEEPSEEK_API_KEY, env302.DEEPSEEK_API_KEY);
  });

  it('anonymous (null userId) vendor spawn injects nothing', () => {
    isolateVendors();
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = resolveProviderEnv(null, 'kimi', { ...base });
    assert.deepEqual(env, base);
    assert.equal(env.KIMI_API_KEY, undefined);
  });
});
