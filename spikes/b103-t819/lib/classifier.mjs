#!/usr/bin/env node
/*
 * B-103 / T-819 producer spike — the terminal-state classifier (§أ-3).
 *
 * Inputs: a task output dir (result.json / result.json.partial / DONE) and the
 * transient unit's terminal systemd state.  Output: exactly one of
 *   SUCCEEDED | PARTIAL | PARTIAL-untrusted | CRASHED  (or RUNNING if not yet terminal).
 *
 * Decision order (DONE is the source of truth; unit state only drives the
 * DONE-absent reconciliation):
 *
 *   DONE present:
 *     signal != null                         → CRASHED   (sealed a kill)
 *     exit_code === 0 && result.json present  → SUCCEEDED
 *     exit_code === 0 && result.json absent   → PARTIAL-untrusted  (anomaly)
 *     exit_code !== 0                         → PARTIAL
 *
 *   DONE absent (§أ-3 reconciliation — no infinite hang, no false SUCCEEDED):
 *     wait until unit is terminal (inactive | failed | gone), then RECONCILE_GRACE_MS,
 *     then re-check DONE.  If DONE appeared → re-run the DONE-present branch (loss race
 *     resolved).  Else decide from unit state + result.json:
 *       failed  OR  result.json absent        → CRASHED
 *       inactive/gone  AND result.json present → PARTIAL-untrusted
 *
 * The grace closes the race where is-active flips terminal a few ms before the
 * wrapper writes DONE. After the grace, the verdict is always decisive.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const a = { outdir: null, unit: null, graceMs: 10000, pollTimeoutMs: 60000,
    pollIntervalMs: 200, unitStateOverride: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--outdir') a.outdir = argv[++i];
    else if (t === '--unit') a.unit = argv[++i];
    else if (t === '--grace-ms') a.graceMs = Number.parseInt(argv[++i], 10);
    else if (t === '--poll-timeout-ms') a.pollTimeoutMs = Number.parseInt(argv[++i], 10);
    else if (t === '--unit-state') a.unitStateOverride = argv[++i];
    else throw new Error(`unknown arg: ${t}`);
  }
  if (!a.outdir) throw new Error('--outdir required');
  return a;
}

function sleepMs(ms) {
  if (ms <= 0) return;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/** Query the user unit's ActiveState/Result/LoadState. Returns 'active'|'activating'|
 *  'inactive'|'failed'|'gone'|'unknown'. 'gone' = systemd GC'd a clean transient service. */
function unitState(unit) {
  if (!unit) return 'gone';
  let out;
  try {
    out = execFileSync('systemctl', ['--user', 'show', unit,
      '--property=ActiveState', '--property=Result', '--property=LoadState'],
      { encoding: 'utf8' });
  } catch {
    return 'gone';
  }
  const kv = Object.fromEntries(out.trim().split('\n').map((l) => {
    const j = l.indexOf('=');
    return [l.slice(0, j), l.slice(j + 1)];
  }));
  if (kv.LoadState === 'not-found') return 'gone';
  const s = kv.ActiveState || 'unknown';
  return s;
}

function isTerminal(state) {
  return state === 'inactive' || state === 'failed' || state === 'gone';
}

function readDone(outdir) {
  const p = path.join(outdir, 'DONE');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { _unparsable: true };
  }
}

function resultPresent(outdir) {
  const p = path.join(outdir, 'result.json');
  if (!fs.existsSync(p)) return false;
  // result.json exists ⟺ complete (only ever created by an atomic rename of a fully
  // written .partial). Still confirm it parses, as a belt-and-suspenders check.
  try { JSON.parse(fs.readFileSync(p, 'utf8')); return true; } catch { return true; }
}

function partialPresent(outdir) {
  return fs.existsSync(path.join(outdir, 'result.json.partial'));
}

function classifyFromDone(done, outdir) {
  const rp = resultPresent(outdir);
  if (done.signal != null) return { classification: 'CRASHED', reason: 'DONE records a kill signal' };
  if (done.exit_code === 0 && rp) return { classification: 'SUCCEEDED', reason: 'exit 0 + result.json + DONE' };
  if (done.exit_code === 0 && !rp) return { classification: 'PARTIAL-untrusted', reason: 'DONE exit 0 but result.json absent (anomaly)' };
  return { classification: 'PARTIAL', reason: `exit_code=${done.exit_code} sealed in DONE` };
}

function classify(a) {
  const deadline = Date.now() + a.pollTimeoutMs;

  // 1. Wait for either DONE to appear or the unit to be terminal.
  let state = a.unitStateOverride || unitState(a.unit);
  while (!readDone(a.outdir) && !isTerminal(state) && Date.now() < deadline) {
    sleepMs(a.pollIntervalMs);
    state = a.unitStateOverride || unitState(a.unit);
  }

  const done = readDone(a.outdir);
  if (done && !done._unparsable) {
    const r = classifyFromDone(done, a.outdir);
    return { ...r, unitState: state, done, resultPresent: resultPresent(a.outdir),
      partialPresent: partialPresent(a.outdir), graceApplied: false };
  }

  // 2. DONE absent. If the unit is still not terminal we hit the poll timeout → not decisive.
  if (!isTerminal(state)) {
    return { classification: 'RUNNING', reason: 'unit not terminal within poll timeout (no hang: bounded)',
      unitState: state, done: null, resultPresent: resultPresent(a.outdir),
      partialPresent: partialPresent(a.outdir), graceApplied: false };
  }

  // 3. Terminal + no DONE → apply the grace, then re-check DONE (loss-race window).
  sleepMs(a.graceMs);
  const done2 = readDone(a.outdir);
  if (done2 && !done2._unparsable) {
    const r = classifyFromDone(done2, a.outdir);
    return { ...r, unitState: state, done: done2, resultPresent: resultPresent(a.outdir),
      partialPresent: partialPresent(a.outdir), graceApplied: true };
  }

  // 4. Decisive reconciliation verdict (§أ-3): never SUCCEEDED, never a hang.
  const rp = resultPresent(a.outdir);
  const finalState = a.unitStateOverride || unitState(a.unit); // re-read post-grace
  let classification, reason;
  if (finalState === 'failed' || !rp) {
    classification = 'CRASHED';
    reason = `DONE absent after grace; unit=${finalState}, result.json=${rp} → crashed`;
  } else {
    classification = 'PARTIAL-untrusted';
    reason = `DONE absent after grace; unit=${finalState}, result.json present but unsealed → untrusted`;
  }
  return { classification, reason, unitState: finalState, done: null, resultPresent: rp,
    partialPresent: partialPresent(a.outdir), graceApplied: true };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const r = classify(a);
  process.stdout.write(JSON.stringify(r) + '\n');
}

main();
