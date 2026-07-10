#!/usr/bin/env node
/*
 * B-103 / T-819 consumer spike — the PERMANENT supervisor (§ب-2, §و/المرحلة 1 criteria 6-7).
 *
 * A standalone spike daemon that models runSupervisor()'s full cycle:
 *   boot  → (flock held by bin/supervisor-run.sh, criterion 7) → reconcile-on-boot
 *   loop  → for each tasks/<id>/: cheap terminal check → classifier verdict → deliver
 *           (finalizeDelivery, exactly-once) → append action to actions.jsonl
 *
 * Crash safety (criterion 6): the tasks are independent systemd transient units that OUTLIVE
 * this process; killing the supervisor with kill -9 at any offset and restarting it re-binds
 * (scans wf-*.service + the on-disk tasks/) and finishes delivery EXACTLY ONCE — the ledger +
 * JSON.parse jsonl reconcile in lib/handoff.mjs guarantee no double and no lost injection.
 *
 * SIGTERM ⇒ clean exit (graceful stop). kill -9 is uncatchable — that IS the resilience test.
 *
 * Env hooks (test-only, documented): HANDOFF_WIDEN_MS widens the inject→ledger gap;
 * SUPERVISOR_MARK_INJECT=1 makes a delivery touch tasks/<id>/INJECT-PENDING at the top of that
 * gap so the harness can kill -9 precisely inside it; HANDOFF_MATCHER selects json|regex.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finalizeDelivery, ledgerHasTask, readLedger } from './handoff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFIER = path.join(HERE, 'classifier.mjs');

function parse(argv) {
  const a = { stateRoot: null, graceMs: 1500, pollMs: 300, mode: 'loop', log: null, actions: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--state-root') a.stateRoot = argv[++i];
    else if (t === '--grace-ms') a.graceMs = Number.parseInt(argv[++i], 10);
    else if (t === '--poll-ms') a.pollMs = Number.parseInt(argv[++i], 10);
    else if (t === '--mode') a.mode = argv[++i];
    else if (t === '--log') a.log = argv[++i];
    else if (t === '--actions') a.actions = argv[++i];
    else throw new Error(`unknown arg: ${t}`);
  }
  if (!a.stateRoot) throw new Error('--state-root required');
  return a;
}

const PID = process.pid;
let LOG = null, ACTIONS = null;
function logln(event, extra = {}) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), pid: PID, event, ...extra }) + '\n'); }
  catch { /* best-effort */ }
}
function actionln(rec) {
  if (!ACTIONS) return;
  try { fs.appendFileSync(ACTIONS, JSON.stringify({ pid: PID, ...rec }) + '\n'); } catch { /* best-effort */ }
}

function sleepMs(ms) {
  if (ms <= 0) return;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/** cheap terminal check: DONE present, or the unit is not active anymore. */
function looksTerminal(taskDir, unit) {
  if (fs.existsSync(path.join(taskDir, 'DONE'))) return true;
  if (!unit) return true;
  try {
    const s = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim();
    return s !== 'active' && s !== 'activating';
  } catch { return true; } // is-active exits nonzero for inactive/failed/gone
}

/** authoritative §أ-3 verdict via the (unchanged) classifier CLI. */
function classify(taskDir, unit, graceMs) {
  const out = execFileSync('node', [CLASSIFIER, '--outdir', taskDir, '--unit', unit || '',
    '--grace-ms', String(graceMs), '--poll-timeout-ms', '20000'], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

function listTasks(stateRoot) {
  const tdir = path.join(stateRoot, 'tasks');
  if (!fs.existsSync(tdir)) return [];
  return fs.readdirSync(tdir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => path.join(tdir, n))
    .filter((d) => fs.existsSync(path.join(d, 'task.json')));
}

function readTask(taskDir) {
  try { return JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')); }
  catch { return null; }
}

function deliverIfTerminal(stateRoot, taskDir, task, opts) {
  // already delivered? (primary key) — cheap idempotent skip
  if (ledgerHasTask(readLedger(stateRoot, task.conversationId), task.taskId)) return 'already';
  const unit = task.unit || null;
  if (!looksTerminal(taskDir, unit)) return 'running';

  let verdict;
  try { verdict = classify(taskDir, unit, opts.graceMs); }
  catch (e) { logln('classify-error', { taskId: task.taskId, err: String(e).slice(0, 200) }); return 'error'; }
  if (verdict.classification === 'RUNNING') return 'running';

  const markInject = process.env.SUPERVISOR_MARK_INJECT === '1';
  const hooks = {
    matcher: process.env.HANDOFF_MATCHER || 'json',
    widenMs: Number.parseInt(process.env.HANDOFF_WIDEN_MS || '0', 10) || 0,
    injectedMarkerPath: markInject ? path.join(taskDir, 'INJECT-PENDING') : null,
  };
  const resultPath = path.join(taskDir, 'result.json');
  const resultObj = fs.existsSync(resultPath)
    ? (() => { try { return JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { return { unparseable: true }; } })()
    : { note: 'no result.json', classification: verdict.classification };
  const outcome = verdict.classification === 'SUCCEEDED' ? 'SUCCEEDED' : verdict.classification;

  const action = finalizeDelivery(
    { stateRoot, task, jsonlPath: task.conversationJsonl, resultObj, outcome }, hooks);
  actionln({ ...action, classification: verdict.classification });
  logln('deliver', { taskId: task.taskId, event: action.event, injected: action.injected,
    classification: verdict.classification });
  return action.event;
}

function processOnce(stateRoot, opts) {
  let all = true, pending = 0;
  for (const taskDir of listTasks(stateRoot)) {
    const task = readTask(taskDir);
    if (!task) continue;
    const r = deliverIfTerminal(stateRoot, taskDir, task, opts);
    if (r === 'running' || r === 'error') { all = false; pending++; }
  }
  return { allDelivered: all, pending };
}

function main() {
  const a = parse(process.argv.slice(2));
  LOG = a.log; ACTIONS = a.actions;
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; logln('sigterm'); });
  process.on('SIGINT', () => { stopping = true; logln('sigint'); });

  logln('boot', { mode: a.mode, stateRoot: a.stateRoot, widenMs: process.env.HANDOFF_WIDEN_MS || '0',
    matcher: process.env.HANDOFF_MATCHER || 'json' });
  // reconcile-on-boot: one immediate pass re-binds any task that finished while we were dead.
  const boot = processOnce(a.stateRoot, a);
  logln('reconcile-on-boot-done', boot);

  while (!stopping) {
    const st = processOnce(a.stateRoot, a);
    if (a.mode === 'drain-exit' && st.allDelivered) { logln('drained-exit'); break; }
    sleepMs(a.pollMs);
  }
  logln('exit', { stopping });
}

main();
