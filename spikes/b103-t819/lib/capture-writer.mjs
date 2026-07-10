#!/usr/bin/env node
/*
 * B-103 / T-819 producer spike — the SINGLE atomic result-capture write path.
 *
 * Implements the §أ-4 producer protocol EXACTLY once, in seal():
 *   1. `.partial` holds output while the task runs (never final).
 *   2. On clean exit (exit_code === 0): fsync(.partial) → rename(.partial → result.json)
 *      → fsync(dir).  rename(2) is atomic on the same filesystem, so result.json
 *      NEVER exists unless it is a fully-written, durable copy.
 *   3. DONE is written LAST (tmp → fsync → rename → fsync dir): { exit_code, signal,
 *      finalizedAt }.  DONE is the last trace; a monitor trusts nothing without it.
 *
 * TWO invocation modes share the ONE seal() so live capture and the local tearing
 * test exercise byte-identical finalize code:
 *   --finalize : `.partial` already on disk (written by `claude -p > result.json.partial`);
 *                seal it.  Used by bin/task-inner.sh (real runs).
 *   --replay   : write given fixture bytes INTO `.partial` through this module, then
 *                seal.  Used by tests/criterion2-tearing.sh with --kill-at-offset to
 *                prove no kill during `.partial` population can yield a torn result.json.
 *                No LLM cost — replays REAL captured stdout.
 *
 * Documented test-only hooks:
 *   --kill-at-offset K   SIGKILL self after writing exactly K bytes of `.partial`,
 *                        BEFORE rename. Proves the tearing invariant (criterion 2).
 *   --widen-window-ms W  Sleep W ms BETWEEN rename and DONE so an external kill -9 can
 *                        reliably land in that window (criterion 3, hole 2-أ).
 *   --skip-done          rename but never write DONE — simulates a clean-exit durability
 *                        gap (inactive unit, result.json present, DONE missing) that
 *                        exercises the PARTIAL-untrusted reconciliation branch (§أ-3).
 */

import fs from 'node:fs';
import path from 'node:path';

const PARTIAL = 'result.json.partial';
const RESULT = 'result.json';
const DONE = 'DONE';
const CHUNK = 64; // small chunks so kill-at-offset is byte-precise

function parseArgs(argv) {
  const a = { mode: null, outdir: null, exitCode: null, input: null,
    killAtOffset: null, widenWindowMs: 0, skipDone: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--finalize') a.mode = 'finalize';
    else if (t === '--replay') a.mode = 'replay';
    else if (t === '--outdir') a.outdir = argv[++i];
    else if (t === '--exit-code') a.exitCode = Number.parseInt(argv[++i], 10);
    else if (t === '--input') a.input = argv[++i];
    else if (t === '--kill-at-offset') a.killAtOffset = Number.parseInt(argv[++i], 10);
    else if (t === '--widen-window-ms') a.widenWindowMs = Number.parseInt(argv[++i], 10);
    else if (t === '--skip-done') a.skipDone = true;
    else throw new Error(`unknown arg: ${t}`);
  }
  if (!a.mode) throw new Error('mode required: --finalize | --replay');
  if (!a.outdir) throw new Error('--outdir required');
  if (a.exitCode == null || Number.isNaN(a.exitCode)) throw new Error('--exit-code required');
  return a;
}

/** fsync a directory entry so a rename into it is durable. */
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** atomic file create: tmp → fsync → rename → fsync(dir). */
function writeFileAtomic(dir, name, buf) {
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path.join(dir, name));
  fsyncDir(dir);
}

/** real, SIGKILL-interruptible sleep (futex wait, not busy CPU). */
function sleepMs(ms) {
  if (ms <= 0) return;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/*
 * THE SHARED SEAL PATH. Both --finalize and --replay reach result.json ONLY through
 * here, so the atomicity guarantee is one code path proven once.
 */
function seal(outdir, exitCode, { widenWindowMs = 0, skipDone = false, signal = null } = {}) {
  const partialPath = path.join(outdir, PARTIAL);
  const resultPath = path.join(outdir, RESULT);

  // Step 2 — rename ONLY on clean exit, and only if a `.partial` exists.
  if (exitCode === 0 && fs.existsSync(partialPath)) {
    const pfd = fs.openSync(partialPath, 'r');
    try { fs.fsyncSync(pfd); } finally { fs.closeSync(pfd); }
    fs.renameSync(partialPath, resultPath); // atomic on same FS
    fsyncDir(outdir);
  }

  // Test hook — widen the rename→DONE window (criterion 3). The process is alive here
  // with result.json present and DONE absent; an external kill -9 lands in this gap.
  if (widenWindowMs > 0) sleepMs(widenWindowMs);

  // Step 3 — DONE last (unless the durability-gap hook suppresses it).
  if (!skipDone) {
    const done = JSON.stringify({
      exit_code: exitCode,
      signal,
      finalizedAt: new Date().toISOString(),
      schema: 't819-producer-1',
    });
    writeFileAtomic(outdir, DONE, Buffer.from(done + '\n'));
  }
}

/*
 * Write fixture bytes into `.partial` through this module (replay), optionally
 * SIGKILL-ing self at byte offset K. Death happens BEFORE seal(), so result.json
 * can never appear — the whole point of criterion 2.
 */
function replayWritePartial(outdir, inputPath, killAtOffset) {
  const data = fs.readFileSync(inputPath);
  const partialPath = path.join(outdir, PARTIAL);
  const fd = fs.openSync(partialPath, 'w', 0o600);
  try {
    // kill before any byte (offset 0)
    if (killAtOffset === 0) {
      fs.fsyncSync(fd);
      process.kill(process.pid, 'SIGKILL');
    }
    let written = 0;
    while (written < data.length) {
      let end = Math.min(written + CHUNK, data.length);
      if (killAtOffset != null && written < killAtOffset && killAtOffset <= end) {
        end = killAtOffset; // land exactly on the requested offset
      }
      fs.writeSync(fd, data, written, end - written);
      written = end;
      if (killAtOffset != null && written === killAtOffset) {
        fs.fsyncSync(fd);
        process.kill(process.pid, 'SIGKILL'); // uncatchable — dies mid-write, before rename
      }
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  fs.mkdirSync(a.outdir, { recursive: true, mode: 0o700 });

  if (a.mode === 'replay') {
    if (!a.input) throw new Error('--replay requires --input');
    replayWritePartial(a.outdir, a.input, a.killAtOffset); // may SIGKILL self
  }

  // finalize (or the tail of a non-killed replay): seal via the shared path.
  seal(a.outdir, a.exitCode, {
    widenWindowMs: a.widenWindowMs,
    skipDone: a.skipDone,
    signal: null,
  });
}

main();
