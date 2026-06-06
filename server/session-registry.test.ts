// PHASE-SR-0 test gate (ADR-021). Covers the three mandatory tests against the
// SessionRegistry seam that backs B-N5 / B-N7 / B-N-ATTACH for agy.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionRegistry, RingBuffer } from './session-registry.js';

const FLAG = 'SESSION_REGISTRY_test';

function withFlag<T>(value: boolean, fn: () => T): T {
  const prev = process.env[FLAG];
  process.env[FLAG] = value ? '1' : '0';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// ---------------------------------------------------------------------------
// B-N5 — rekey: a message buffered before sessionId survives the rekey, with no
// loss and no duplication; rekey onto an existing sessionId never interleaves two
// runs into a corrupt stream.
// ---------------------------------------------------------------------------

test('B-N5 rekey: payload buffered under connectionId moves to sessionId without loss or duplication', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const conn = 'conn-1';
    const sid = 'session-1';

    // Emitted BEFORE the real sessionId is known — keyed by connectionId.
    reg.open(conn);
    const seq1 = reg.record(conn, { kind: 'stream_delta', content: 'pre-A' });
    const seq2 = reg.record(conn, { kind: 'stream_delta', content: 'pre-B' });
    assert.equal(seq1, 1);
    assert.equal(seq2, 2);

    // sessionId arrives -> rekey.
    reg.rekey(conn, sid);

    // A payload emitted after rekey, addressed by sessionId.
    reg.record(sid, { kind: 'stream_delta', content: 'post-C' });

    // Differential replay from scratch must see ALL three, in order, once each.
    const replayed: any[] = [];
    const highest = reg.attach(sid, 0, (p: any) => replayed.push(p));

    assert.deepEqual(replayed.map((p: any) => p.content), ['pre-A', 'pre-B', 'post-C']);
    assert.equal(highest, 3);
    // Old key is gone — no duplicate slot.
    assert.equal(reg.attach(conn, 0, () => {}), null);
  });
});

test('B-N5 rekey: onto an existing sessionId appends without dropping or duplicating', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const conn = 'conn-2';
    const sid = 'session-2';

    // Target session already has buffered output.
    reg.record(sid, { kind: 'stream_delta', content: 'existing-1' });
    // A late temporary buffer for the same logical session.
    reg.record(conn, { kind: 'stream_delta', content: 'temp-1' });
    reg.record(conn, { kind: 'stream_delta', content: 'temp-2' });

    reg.rekey(conn, sid);

    const replayed: string[] = [];
    reg.attach(sid, 0, (p: any) => replayed.push(p.content));

    // Every payload present exactly once; existing target output preserved.
    assert.deepEqual(replayed, ['existing-1', 'temp-1', 'temp-2']);
    // No duplication: count check.
    assert.equal(replayed.length, 3);
    assert.equal(reg.attach(conn, 0, () => {}), null);
  });
});

// ---------------------------------------------------------------------------
// B-N7 — single source of truth: start/end flips one `active` flag that both
// the attach lookup and (future) drain read.
// ---------------------------------------------------------------------------

test('B-N7 single source: open/setActive is the one active flag read everywhere', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-3';

    assert.equal(reg.isActive(sid), false, 'unknown session is inactive');

    reg.open(sid); // spawn
    assert.equal(reg.isActive(sid), true, 'active after open');

    reg.setActive(sid, false); // terminal (close/error)
    assert.equal(reg.isActive(sid), false, 'inactive after terminal');

    // The same flag survives rekey so attach + drain never diverge.
    const conn = 'conn-3';
    reg.open(conn);
    assert.equal(reg.isActive(conn), true);
    reg.rekey(conn, 'session-3b');
    assert.equal(reg.isActive('session-3b'), true, 'active flag carried through rekey');
    assert.equal(reg.isActive(conn), false, 'old key no longer active');
  });
});

// ---------------------------------------------------------------------------
// B-N-ATTACH — differential replay: only seq > lastSeq, no duplicate, no gap,
// and attach is strictly read-only (no swap/abort hooks exist on the registry).
// ---------------------------------------------------------------------------

test('attach-replay differential: only seq > lastSeq, no duplicate, no gap', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-4';

    reg.open(sid);
    for (let i = 1; i <= 5; i += 1) {
      reg.record(sid, { kind: 'stream_delta', content: `m${i}` });
    }

    // Client already saw up to seq 3 -> must receive only 4 and 5.
    const replayed: string[] = [];
    const highest = reg.attach(sid, 3, (p: any) => replayed.push(p.content));
    assert.deepEqual(replayed, ['m4', 'm5'], 'no duplicate of already-seen, no gap');
    assert.equal(highest, 5);

    // Replaying again from the new high-water mark yields nothing (no duplication).
    const second: string[] = [];
    const stillHighest = reg.attach(sid, highest, (p: any) => second.push(p));
    assert.deepEqual(second, []);
    assert.equal(stillHighest, 5);

    // attach does not mutate the buffer (still re-readable from 0).
    const full: string[] = [];
    reg.attach(sid, 0, (p: any) => full.push(p.content));
    assert.deepEqual(full, ['m1', 'm2', 'm3', 'm4', 'm5']);
  });
});

test('attach-replay differential: live session stays active across attach (no abort/swap)', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-5';
    reg.open(sid);
    reg.record(sid, { kind: 'stream_delta', content: 'a' });

    assert.equal(reg.isActive(sid), true, 'active before attach');
    reg.attach(sid, 0, () => {});
    // Read-only: the active flag is untouched by attach (no abort), and the
    // registry exposes no writer-swap surface at all.
    assert.equal(reg.isActive(sid), true, 'still active after attach — no abort');
    assert.equal((reg as any).reconnectSessionWriter, undefined);
    assert.equal((reg as any).swap, undefined);

    // A subsequent live payload after attach continues the SAME seq line — the
    // attach did not fork or reset the stream.
    const seq = reg.record(sid, { kind: 'stream_delta', content: 'b' });
    assert.equal(seq, 2);
  });
});

// ---------------------------------------------------------------------------
// Coexistence: flag OFF == no-op (legacy behavior preserved).
// ---------------------------------------------------------------------------

test('flag off: every registry method is an inert no-op', () => {
  withFlag(false, () => {
    const reg = new SessionRegistry(FLAG);
    assert.equal(reg.enabled, false);
    assert.equal(reg.open('k'), null);
    assert.equal(reg.record('k', { x: 1 }), null);
    assert.equal(reg.isActive('k'), false);
    reg.setActive('k', true);
    assert.equal(reg.isActive('k'), false);
    assert.equal(reg.attach('k', 0, () => assert.fail('must not replay')), null);
    assert.equal(reg.lastSeq('k'), 0);
  });
});

// ---------------------------------------------------------------------------
// RingBuffer invariants (eviction must not corrupt differential replay).
// ---------------------------------------------------------------------------

test('RingBuffer: monotonic seq survives eviction; since() never replays evicted-but-seen', () => {
  const rb = new RingBuffer(3);
  for (let i = 1; i <= 5; i += 1) rb.push({ n: i });
  // Capacity 3 -> only the last three retained, but seq keeps climbing.
  assert.equal(rb.lastSeq, 5);
  assert.deepEqual(rb.since(0).map((it) => it.seq), [3, 4, 5]);
  assert.deepEqual(rb.since(4).map((it) => it.seq), [5]);
  assert.deepEqual(rb.since(5), []);
});
