/**
 * ADR-048 — Workflow Completion Reconcile (incident 2026-06-27, wf_ef5ba242-b4b).
 *
 * This is the FORMAT-PINNING test (ADR-048 risk mitigation #1): the reconcile
 * couples to the on-disk `journal.jsonl` shape the Claude Code SDK writes
 * (`{type:'started'|'result', key, agentId, ...}`), which an upstream upgrade
 * may change. The fixture below is the incident shape (started/result matched by
 * `key`; `result.result = {sectionId,title,content}`; NO `path` field). If an
 * upgrade renames `type`/`key` or changes the started⊆result completeness
 * semantics, these assertions fail FIRST in CI — before the flag is ever turned
 * on — instead of silently mis-reporting completion.
 *
 * It also locks the design's other guarantees:
 *  - fail-safe: missing folder / malformed lines / empty started => NO correction,
 *    never throws (read-only, console.debug only).
 *  - freshness gates: a journal not newer than the stopped row, or one still
 *    being written (quiet window), yields no correction.
 *  - flag OFF (default) is a byte-for-byte no-op.
 *  - the derived row's contract: kind:'task_reconcile', isTaskNotification:true,
 *    taskStatus:'completed', wfId, agentsDone/agentsTotal, originKind:
 *    'task-notification', timestamp = journal mtime, and NO `path` field.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReconcileMessage,
  findLatestStoppedNotificationMs,
  findReconciledWorkflows,
  reconcileWorkflowMessages,
  workflowReconcileEnabled,
} from '@/modules/providers/list/claude/workflow-reconcile.service.js';

const WF_ID = 'wf_ef5ba242-b4b';

/**
 * Incident-shaped journal: five `started` keys, all five matched by a `result`
 * key. `result.result` carries {sectionId,title,content} and there is no `path`
 * anywhere — exactly what wf_ef5ba242-b4b wrote.
 */
const COMPLETED_JOURNAL_LINES: Array<Record<string, unknown>> = [
  { type: 'started', key: 'sec_1_hash_abc123', agentId: 'plan_drafter_1', timestamp: 1719482511000 },
  { type: 'started', key: 'sec_2_hash_def456', agentId: 'plan_drafter_1', timestamp: 1719482515000 },
  { type: 'started', key: 'sec_3_hash_ghi789', agentId: 'plan_drafter_1', timestamp: 1719482519000 },
  { type: 'started', key: 'intro_hash_jkl012', agentId: 'plan_drafter_1', timestamp: 1719482523000 },
  { type: 'started', key: 'summary_hash_mno345', agentId: 'plan_drafter_1', timestamp: 1719482527000 },
  {
    type: 'result',
    key: 'sec_1_hash_abc123',
    agentId: 'plan_drafter_1',
    result: { sectionId: 'section_1', title: 'مقدمة الخطة', content: '# خطة المشروع' },
    timestamp: 1719482595000,
  },
  {
    type: 'result',
    key: 'sec_2_hash_def456',
    agentId: 'plan_drafter_1',
    result: { sectionId: 'section_2', title: 'أهداف المشروع', content: '## الأهداف' },
    timestamp: 1719482631000,
  },
  {
    type: 'result',
    key: 'sec_3_hash_ghi789',
    agentId: 'plan_drafter_1',
    result: { sectionId: 'section_3', title: 'الموارد', content: '## الموارد' },
    timestamp: 1719482667000,
  },
  {
    type: 'result',
    key: 'intro_hash_jkl012',
    agentId: 'plan_drafter_1',
    result: { sectionId: 'intro', title: 'المقدمة', content: '# خطة المشروع v1' },
    timestamp: 1719482703000,
  },
  {
    type: 'result',
    key: 'summary_hash_mno345',
    agentId: 'plan_drafter_1',
    result: { sectionId: 'summary', title: 'الملخص', content: '## الملخص' },
    timestamp: 1719482829000,
  },
];

function toJsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/**
 * Runs `body` against a fresh session directory containing one `wf_*` folder
 * whose `journal.jsonl` is written from `lines` and whose mtime is forced to
 * `journalMtimeMs`, so freshness gates are deterministic regardless of wall
 * clock. Cleans the temp tree afterwards.
 */
async function withWorkflowJournal(
  lines: Array<Record<string, unknown>> | null,
  journalMtimeMs: number,
  body: (sessionDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wf-reconcile-'));
  const sessionDir = path.join(tempDir, 'sess-1');
  const wfDir = path.join(sessionDir, 'subagents', 'workflows', WF_ID);
  await mkdir(wfDir, { recursive: true });

  if (lines !== null) {
    const journalPath = path.join(wfDir, 'journal.jsonl');
    await writeFile(journalPath, toJsonl(lines), 'utf8');
    const mtimeSeconds = journalMtimeMs / 1000;
    await utimes(journalPath, mtimeSeconds, mtimeSeconds);
  }

  try {
    await body(sessionDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Anchor times: stopped row at T0, journal completed 6 min later (incident gap),
// and "now" well past the quiet window so freshness is satisfied by default.
const STOPPED_AT_MS = Date.parse('2026-06-27T14:51:00.000Z');
const JOURNAL_DONE_MS = Date.parse('2026-06-27T14:57:00.000Z');
const NOW_MS = JOURNAL_DONE_MS + 60_000;

// ---------------- format-pinning: completion semantics ----------------

test('completed incident journal is reconciled (started keys all matched by result keys)', async () => {
  await withWorkflowJournal(COMPLETED_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });

    assert.equal(reconciled.length, 1, 'one workflow must be reconciled');
    assert.equal(reconciled[0].wfId, WF_ID);
    assert.equal(reconciled[0].agentsTotal, 5, 'five started keys');
    assert.equal(reconciled[0].agentsDone, 5, 'five matched result keys');
    assert.equal(reconciled[0].completedAt, new Date(JOURNAL_DONE_MS).toISOString());
  });
});

test('a started key without a matching result is NOT complete (orphan still running)', async () => {
  // Drop the last result line: 5 started / 4 result => started ⊄ result.
  const partial = COMPLETED_JOURNAL_LINES.filter(
    (line) => !(line.type === 'result' && line.key === 'summary_hash_mno345'),
  );
  await withWorkflowJournal(partial, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 0, 'incomplete workflow must yield no correction');
  });
});

test('duplicate started keys (retry/escalation) need only one result each', async () => {
  // Same key started twice; a single result for it still completes the work item.
  const withRetry = [
    { type: 'started', key: 'only_hash', agentId: 'a', timestamp: 1 },
    { type: 'started', key: 'only_hash', agentId: 'a', timestamp: 2 },
    { type: 'result', key: 'only_hash', agentId: 'a', result: { sectionId: 's', title: 't', content: 'c' }, timestamp: 3 },
  ];
  await withWorkflowJournal(withRetry, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].agentsTotal, 1, 'keys are de-duplicated (Set semantics)');
    assert.equal(reconciled[0].agentsDone, 1);
  });
});

// ---------------- fail-safe: never throws, no correction ----------------

test('malformed JSON lines are skipped, not fatal (fail-safe)', async () => {
  await withWorkflowJournal(null, JOURNAL_DONE_MS, async (sessionDir) => {
    const journalPath = path.join(sessionDir, 'subagents', 'workflows', WF_ID, 'journal.jsonl');
    const body = COMPLETED_JOURNAL_LINES.map((line) => JSON.stringify(line));
    // Inject a corrupt line in the middle; the good lines must still reconcile.
    body.splice(3, 0, '{ this is not valid json');
    await writeFile(journalPath, body.join('\n') + '\n', 'utf8');
    const mtimeSeconds = JOURNAL_DONE_MS / 1000;
    await utimes(journalPath, mtimeSeconds, mtimeSeconds);

    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 1, 'corrupt line skipped, remaining keys still complete');
    assert.equal(reconciled[0].agentsTotal, 5);
  });
});

test('a missing subagents/workflows directory yields no correction and never throws', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wf-reconcile-empty-'));
  try {
    const sessionDir = path.join(tempDir, 'sess-1');
    await mkdir(sessionDir, { recursive: true });
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.deepEqual(reconciled, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('an empty started set is never "complete" (absence of a workflow, not a finished one)', async () => {
  const resultsOnly = COMPLETED_JOURNAL_LINES.filter((line) => line.type === 'result');
  await withWorkflowJournal(resultsOnly, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 0);
  });
});

// ---------------- freshness gates ----------------

test('a journal not newer than the stopped notification is ignored (freshness a)', async () => {
  // Journal mtime BEFORE the stopped row => it predates the stop, not a fresh completion.
  const olderThanStop = STOPPED_AT_MS - 60_000;
  await withWorkflowJournal(COMPLETED_JOURNAL_LINES, olderThanStop, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 0, 'stale-vs-stopped journal must not be reconciled');
  });
});

test('a journal still within the quiet window is ignored (freshness b: write may be in flight)', async () => {
  await withWorkflowJournal(COMPLETED_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
    // now is only 1s after the last write, below the default 5000ms quiet window.
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, {
      now: JOURNAL_DONE_MS + 1000,
      quietMs: 5000,
    });
    assert.equal(reconciled.length, 0, 'a journal written <QUIET_MS ago is treated as in-flight');
  });
});

// ---------------- flag gating + top-level entry ----------------

test('workflowReconcileEnabled is OFF unless explicitly truthy', () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    delete process.env.WORKFLOW_RECONCILE;
    assert.equal(workflowReconcileEnabled(), false, 'unset => OFF');
    process.env.WORKFLOW_RECONCILE = 'false';
    assert.equal(workflowReconcileEnabled(), false);
    process.env.WORKFLOW_RECONCILE = '0';
    assert.equal(workflowReconcileEnabled(), false);
    process.env.WORKFLOW_RECONCILE = 'on';
    assert.equal(workflowReconcileEnabled(), true);
    process.env.WORKFLOW_RECONCILE = '1';
    assert.equal(workflowReconcileEnabled(), true);
    process.env.WORKFLOW_RECONCILE = 'true';
    assert.equal(workflowReconcileEnabled(), true);
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

test('reconcileWorkflowMessages is a no-op when the flag is OFF (byte-for-byte prior behaviour)', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    delete process.env.WORKFLOW_RECONCILE;
    await withWorkflowJournal(COMPLETED_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
      const messages = await reconcileWorkflowMessages('sess-1', sessionDir, STOPPED_AT_MS, { now: NOW_MS });
      assert.deepEqual(messages, [], 'OFF => no derived rows');
    });
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

test('reconcileWorkflowMessages is a no-op when there is no stopped notification', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    process.env.WORKFLOW_RECONCILE = '1';
    await withWorkflowJournal(COMPLETED_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
      const messages = await reconcileWorkflowMessages('sess-1', sessionDir, null, { now: NOW_MS });
      assert.deepEqual(messages, [], 'no stopped row => nothing to correct');
    });
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

test('reconcileWorkflowMessages emits the derived correction when ON, complete and fresh', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    process.env.WORKFLOW_RECONCILE = '1';
    await withWorkflowJournal(COMPLETED_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
      const messages = await reconcileWorkflowMessages('sess-1', sessionDir, STOPPED_AT_MS, { now: NOW_MS });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, 'task_reconcile');
      assert.equal(messages[0].wfId, WF_ID);
      assert.equal(messages[0].agentsDone, 5);
      assert.equal(messages[0].agentsTotal, 5);
    });
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

// ---------------- derived-message contract shape ----------------

test('buildReconcileMessage matches the server→client contract exactly (no path field)', () => {
  const msg = buildReconcileMessage('sess-1', {
    wfId: WF_ID,
    agentsDone: 5,
    agentsTotal: 5,
    completedAt: '2026-06-27T14:57:00.000Z',
  });

  assert.equal(msg.kind, 'task_reconcile');
  assert.equal(msg.provider, 'claude');
  assert.equal(msg.sessionId, 'sess-1');
  assert.equal(msg.isTaskNotification, true);
  assert.equal(msg.taskStatus, 'completed');
  assert.equal(msg.content, 'اكتملت المهمة الخلفية');
  assert.equal(msg.wfId, WF_ID);
  assert.equal(msg.agentsDone, 5);
  assert.equal(msg.agentsTotal, 5);
  assert.equal(msg.originKind, 'task-notification', 'must not be attributed to the user');
  assert.equal(msg.timestamp, '2026-06-27T14:57:00.000Z', 'timestamp = journal mtime, sorts after stopped');
  assert.ok(Object.hasOwn(msg, 'id') && typeof msg.id === 'string', 'envelope id filled');
  assert.equal(Object.hasOwn(msg, 'path'), false, 'the journal has no output-file path');
});

// ---------------- stopped-notification detection ----------------

test('findLatestStoppedNotificationMs picks the latest task-notification stopped row', () => {
  const rows: Array<Record<string, unknown>> = [
    {
      origin: { kind: 'task-notification' },
      timestamp: '2026-06-27T14:40:00.000Z',
      message: { role: 'user', content: '<task-notification><status>stopped</status></task-notification>' },
    },
    {
      origin: { kind: 'task-notification' },
      timestamp: '2026-06-27T14:51:00.000Z',
      message: { role: 'user', content: '<task-notification><status>stopped</status></task-notification>' },
    },
    // a non-stopped task-notification and a human row must be ignored
    {
      origin: { kind: 'task-notification' },
      timestamp: '2026-06-27T15:00:00.000Z',
      message: { role: 'user', content: '<task-notification><status>started</status></task-notification>' },
    },
    {
      timestamp: '2026-06-27T15:05:00.000Z',
      message: { role: 'user', content: '<status>stopped</status> typed by a human (no task-notification origin)' },
    },
  ];

  const latest = findLatestStoppedNotificationMs(rows);
  assert.equal(latest, Date.parse('2026-06-27T14:51:00.000Z'));
});

test('findLatestStoppedNotificationMs returns null when there is no background stop', () => {
  const rows: Array<Record<string, unknown>> = [
    {
      timestamp: '2026-06-27T14:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    },
  ];
  assert.equal(findLatestStoppedNotificationMs(rows), null);
});
