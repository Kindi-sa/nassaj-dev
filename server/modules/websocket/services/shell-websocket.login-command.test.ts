import assert from 'node:assert/strict';
import test from 'node:test';

import { isProviderLoginCommand } from './shell-websocket.service.js';

test('T-878: Codex device auth is treated as a fresh login PTY', () => {
  assert.equal(
    isProviderLoginCommand('codex login --device-auth', 'codex', false, true),
    true
  );
});

test('ordinary Codex commands do not force a PTY restart', () => {
  assert.equal(isProviderLoginCommand('codex --version', 'codex', false, true), false);
});
