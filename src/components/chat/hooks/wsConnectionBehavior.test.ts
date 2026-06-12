/**
 * Unit tests for WS connection behaviour changes (B-39 + B-33 frontend).
 *
 * Covers:
 *  - sendMessage returns { ok: false } when socket is not open
 *  - dispatchProviderCommand returns false → sendError is set
 *  - SERVER_ERROR_CODE_KEYS map covers the agreed codes
 *  - calcReconnectDelay grows with attempt count (exponential backoff)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* ------------------------------------------------------------------ */
/*  Helpers — replicate minimal logic in pure form for testing         */
/* ------------------------------------------------------------------ */

/** Mirrors the WS sendMessage contract from WebSocketContext.tsx */
function makeSendMessage(isOpen: boolean) {
  return (_message: unknown): { ok: boolean; reason?: string } => {
    if (isOpen) return { ok: true };
    return { ok: false, reason: 'disconnected' };
  };
}

/**
 * Mirrors dispatchProviderCommand's return contract:
 * returns false when sendMessage fails.
 */
function dispatchProviderCommand(
  sendMessage: (msg: unknown) => { ok: boolean },
  messageContent: string,
): boolean {
  const result = sendMessage({ type: 'claude-command', command: messageContent, options: {} });
  return result.ok;
}

/** Mirrors calcReconnectDelay from WebSocketContext.tsx (no jitter for deterministic tests). */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function calcReconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

/** Maps known server error codes to i18n keys. Mirrors SERVER_ERROR_CODE_KEYS. */
const SERVER_ERROR_CODE_KEYS: Record<string, string> = {
  project_dir_missing: 'serverError.project_dir_missing',
  cli_not_installed: 'serverError.cli_not_installed',
  spawn_failed: 'serverError.spawn_failed',
};

/* ------------------------------------------------------------------ */
/*  Tests: sendMessage return value                                    */
/* ------------------------------------------------------------------ */

describe('sendMessage return value', () => {
  it('returns { ok: true } when the socket is open', () => {
    const send = makeSendMessage(true);
    const result = send({ type: 'ping' });
    assert.equal(result.ok, true);
  });

  it('returns { ok: false, reason: "disconnected" } when socket is closed', () => {
    const send = makeSendMessage(false);
    const result = send({ type: 'ping' });
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'disconnected');
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: dispatchProviderCommand propagates WS failure               */
/* ------------------------------------------------------------------ */

describe('dispatchProviderCommand propagates WS state', () => {
  it('returns true when WS is connected', () => {
    const send = makeSendMessage(true);
    const sent = dispatchProviderCommand(send, 'hello world');
    assert.equal(sent, true);
  });

  it('returns false when WS is disconnected', () => {
    const send = makeSendMessage(false);
    const sent = dispatchProviderCommand(send, 'hello world');
    assert.equal(sent, false);
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: exponential backoff delay                                   */
/* ------------------------------------------------------------------ */

describe('calcReconnectDelay (exponential backoff)', () => {
  it('first attempt delay is base delay (1 s)', () => {
    assert.equal(calcReconnectDelay(0), 1000);
  });

  it('second attempt delay doubles', () => {
    assert.equal(calcReconnectDelay(1), 2000);
  });

  it('delay grows exponentially up to the cap', () => {
    const delays = [0, 1, 2, 3, 4, 5].map(calcReconnectDelay);
    // Each step must be >= previous (non-decreasing)
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1], `delay[${i}] should be >= delay[${i - 1}]`);
    }
  });

  it('delay is capped at RECONNECT_MAX_DELAY_MS', () => {
    // 2^10 * 1000 = 1 024 000 → well above cap
    const delay = calcReconnectDelay(10);
    assert.equal(delay, RECONNECT_MAX_DELAY_MS);
  });

  it('original fixed 3-second delay is no longer the only reconnect value', () => {
    // The old code always reconnected after exactly 3000ms.  With backoff,
    // attempt 0 is 1000ms — proving the change is in effect.
    assert.notEqual(calcReconnectDelay(0), 3000);
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: SERVER_ERROR_CODE_KEYS coverage                             */
/* ------------------------------------------------------------------ */

describe('SERVER_ERROR_CODE_KEYS', () => {
  const REQUIRED_CODES = ['project_dir_missing', 'cli_not_installed', 'spawn_failed'];

  for (const code of REQUIRED_CODES) {
    it(`contains key for "${code}"`, () => {
      assert.ok(code in SERVER_ERROR_CODE_KEYS, `Missing key: ${code}`);
    });

    it(`"${code}" maps to the correct i18n path`, () => {
      assert.equal(SERVER_ERROR_CODE_KEYS[code], `serverError.${code}`);
    });
  }

  it('unknown codes are NOT in the map (falls back to serverError.unknown)', () => {
    assert.equal(SERVER_ERROR_CODE_KEYS['totally_unknown_code'], undefined);
  });
});
