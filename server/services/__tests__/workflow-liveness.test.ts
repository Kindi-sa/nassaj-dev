/**
 * ADR-053 / T-53-B1 — workflow liveness (pid source + م-3 classifier).
 *
 * Proves the B-103 visibility primitive: a background workflow whose coordinator
 * turn already ended is judged RUNNING / ORPHAN / COMPLETED from the CHILD PID
 * combined with the journal's real key sets and freshness. The key sets are read
 * from the SAME parser reconcile uses (`readJournalKeySets`) applied to the REAL
 * incident/completed journals on disk (no synthetic fixtures — lesson
 * `feedback_synthetic_fixtures_false_confidence`).
 *
 * The load-bearing rule under test is م-3 (the 6th mandatory condition): a dead
 * pid whose journal is NOT quiet is RUNNING (conservative), never COMPLETED — so
 * a grandchild orphan still flushing after the root died is never prematurely
 * declared finished.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJournalKeySets } from '@/modules/providers/list/claude/workflow-reconcile.service.js';
import {
  classifyWorkflowLiveness,
  forgetWorkflowPid,
  isPidAlive,
  isWorkflowProcessAlive,
  registerWorkflowPid,
  resolveWorkflowPid,
  trackedWorkflowPidCount,
} from '@/services/workflow-liveness.js';
import {
  COMPLETED_JOURNAL_LINES,
  INCIDENT_JOURNAL_LINES,
  toJsonl,
} from '@/services/__tests__/__fixtures__/wf-real-journals.js';

const QUIET_MS = 5000;
const NOW_MS = Date.parse('2026-06-27T15:00:00.000Z');
// Journal last written 6 min before "now" => well past the quiet window.
const QUIET_MTIME_MS = NOW_MS - 6 * 60_000;
// Journal written 1s ago => inside the quiet window (still being flushed).
const FRESH_MTIME_MS = NOW_MS - 1000;

/**
 * Writes `lines` to a temp journal and returns its real key-set booleans via the
 * production parser — so the classifier is driven by the SAME derivation the
 * reconcile/status paths use, on the SAME real rows.
 */
async function keysFromRealJournal(lines: Array<Record<string, unknown>>): Promise<{
  startedKeyCount: number;
  resultKeyCount: number;
  allStartedResulted: boolean;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wf-liveness-'));
  try {
    const journalPath = path.join(dir, 'journal.jsonl');
    await writeFile(journalPath, toJsonl(lines), 'utf8');
    const { startedKeys, resultKeys } = await readJournalKeySets(journalPath);
    let allStartedResulted = startedKeys.size >= 1;
    for (const key of startedKeys) {
      if (!resultKeys.has(key)) {
        allStartedResulted = false;
        break;
      }
    }
    return { startedKeyCount: startedKeys.size, resultKeyCount: resultKeys.size, allStartedResulted };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// isPidAlive — the raw child-pid probe
// ============================================================================

test('isPidAlive: this very process is alive', () => {
  assert.equal(isPidAlive(process.pid), true, 'the running test process must read as alive');
});

test('isPidAlive: a reaped short-lived child reads as dead', async () => {
  // Spawn a process that exits immediately, wait for its exit, then probe. Its
  // pid is no longer a live process (reaped by Node) => ESRCH => dead.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  // Give the OS a beat to fully reap before probing.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(isPidAlive(pid), false, 'an exited+reaped child pid must read as dead');
});

test('isPidAlive: invalid/nonsense pids are dead (fail-safe)', () => {
  assert.equal(isPidAlive(null as unknown as number), false);
  assert.equal(isPidAlive(undefined as unknown as number), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(1.5 as unknown as number), false);
});

// ============================================================================
// pid registry — survives past turn-end, self-prunes on death
// ============================================================================

test('registry: register/resolve round-trips a live pid; invalid ignored', () => {
  const sid = 'sess-live';
  forgetWorkflowPid(sid);
  registerWorkflowPid(sid, process.pid);
  assert.equal(resolveWorkflowPid(sid), process.pid);

  // Invalid registrations are ignored (no overwrite to a bad value).
  registerWorkflowPid(sid, 0);
  registerWorkflowPid(sid, -5);
  assert.equal(resolveWorkflowPid(sid), process.pid, 'a live pid is not clobbered by invalid ones');

  forgetWorkflowPid(sid);
  assert.equal(resolveWorkflowPid(sid), null, 'forget clears the mapping');
});

test('registry: isWorkflowProcessAlive is true for a live pid and self-prunes a dead one', async () => {
  const liveSid = 'sess-alive';
  forgetWorkflowPid(liveSid);
  registerWorkflowPid(liveSid, process.pid);
  assert.equal(isWorkflowProcessAlive(liveSid), true);

  const deadSid = 'sess-dead';
  forgetWorkflowPid(deadSid);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await new Promise((r) => setTimeout(r, 50));
  registerWorkflowPid(deadSid, pid);
  assert.equal(trackedWorkflowPidCount() >= 1, true, 'dead pid is tracked before the probe');
  assert.equal(isWorkflowProcessAlive(deadSid), false, 'a dead pid reads as not alive');
  assert.equal(resolveWorkflowPid(deadSid), null, 'the dead mapping is pruned so the registry stays bounded');

  forgetWorkflowPid(liveSid);
});

test('registry: an unknown session is not alive (never claim liveness without a pid)', () => {
  assert.equal(isWorkflowProcessAlive('never-registered'), false);
});

// ============================================================================
// classifyWorkflowLiveness — م-3, on REAL journal key sets
// ============================================================================

test('classify: pid ALIVE => RUNNING regardless of journal state (authoritative)', async () => {
  const incident = await keysFromRealJournal(INCIDENT_JOURNAL_LINES);
  const verdict = classifyWorkflowLiveness({
    pidAlive: true,
    ...incident,
    journalMtimeMs: QUIET_MTIME_MS, // even quiet + orphaned keys
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'RUNNING', 'a live child pid means the workflow tree is up');
});

test('classify (م-3): pid DEAD + journal NOT quiet => RUNNING (no premature COMPLETED)', async () => {
  // The COMPLETED journal has every started key resulted; if quiet it would be
  // COMPLETED. But inside the quiet window a grandchild may still be flushing —
  // م-3 forces the conservative RUNNING so completion is never announced early.
  const completed = await keysFromRealJournal(COMPLETED_JOURNAL_LINES);
  const verdict = classifyWorkflowLiveness({
    pidAlive: false,
    ...completed,
    journalMtimeMs: FRESH_MTIME_MS, // written 1s ago => not quiet
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'RUNNING', 'dead pid but still-writing journal must stay RUNNING (م-3)');
});

test('classify: pid DEAD + quiet + INCIDENT keys (one orphan) => ORPHAN', async () => {
  const incident = await keysFromRealJournal(INCIDENT_JOURNAL_LINES);
  assert.equal(incident.startedKeyCount, 16, 'real incident: 16 unique started keys');
  assert.equal(incident.resultKeyCount, 15, 'real incident: 15 unique result keys');
  assert.equal(incident.allStartedResulted, false, 'one started key never resulted (the orphan)');

  const verdict = classifyWorkflowLiveness({
    pidAlive: false,
    ...incident,
    journalMtimeMs: QUIET_MTIME_MS,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'ORPHAN', 'dead pid, quiet, unfinished => visible orphan');
});

test('classify: pid DEAD + quiet + COMPLETED keys (all resulted) => COMPLETED', async () => {
  const completed = await keysFromRealJournal(COMPLETED_JOURNAL_LINES);
  assert.equal(completed.startedKeyCount, 7, 'real completed: 7 unique started keys');
  assert.equal(completed.resultKeyCount, 7, 'real completed: 7 unique result keys');
  assert.equal(completed.allStartedResulted, true, 'every started key resulted');

  const verdict = classifyWorkflowLiveness({
    pidAlive: false,
    ...completed,
    journalMtimeMs: QUIET_MTIME_MS,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'COMPLETED', 'dead pid, quiet, all resulted => completed');
});

test('classify: pid DEAD + quiet + NO journal (mtime 0) + no keys => ORPHAN', () => {
  // A workflow folder with no journal at all: mtime 0 is treated as quiet (there
  // is nothing being written), and with a dead pid and no results it is an
  // orphan the user must be shown, not a silently swallowed nothing.
  const verdict = classifyWorkflowLiveness({
    pidAlive: false,
    startedKeyCount: 0,
    resultKeyCount: 0,
    allStartedResulted: false,
    journalMtimeMs: 0,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'ORPHAN', 'dead pid + empty/absent journal => orphan (surfaced, not swallowed)');
});

test('classify: pid DEAD + quiet + results present but a started key unmatched => ORPHAN', () => {
  // Directly exercises the "output landed yet a subagent hung" boundary with the
  // real incident shape's essence (started > resulted, some result present).
  const verdict = classifyWorkflowLiveness({
    pidAlive: false,
    startedKeyCount: 3,
    resultKeyCount: 2,
    allStartedResulted: false,
    journalMtimeMs: QUIET_MTIME_MS,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'ORPHAN');
});

// ============================================================================
// The decisive-source invariant (ADR-053:100): pid is authoritative even when
// the in-memory session/activeSessions view is empty. We model "activeSessions
// empty" as "no registry pid at all" (dropped at turn-end) vs "pid still alive".
// ============================================================================

test('invariant: with the in-memory view gone, the CHILD PID is the decisive liveness source', () => {
  const sid = 'sess-decisive';
  forgetWorkflowPid(sid);

  // Turn ended: no pid registered yet (mirrors activeSessions/registry empty).
  assert.equal(isWorkflowProcessAlive(sid), false, 'no pid => cannot claim alive (defers to journal)');

  // The run path registered the real child pid before turn-end; it survives.
  registerWorkflowPid(sid, process.pid);
  assert.equal(
    isWorkflowProcessAlive(sid),
    true,
    'the surviving child pid — NOT activeSessions — decides the workflow is still alive',
  );

  forgetWorkflowPid(sid);
});
