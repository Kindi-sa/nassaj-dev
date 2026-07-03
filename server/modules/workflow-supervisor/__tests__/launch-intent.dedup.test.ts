/**
 * B-126 — dedup safety belt for the (decommissioned) workflow supervisor.
 *
 * The durable supervisor (ADR-053 Layer 2) is DECOMMISSIONED by owner decision
 * ب1 (2026-07-03) and must never be enabled. Should the WORKFLOW_SUPERVISOR flag
 * be turned on by mistake, the inline workflow runner has ALREADY executed the
 * workflow in-process this turn (ENABLE_ULTRACODE_WORKFLOWS => CLAUDE_CODE_WORKFLOWS=1),
 * so writing a launch intent would let the supervisor re-launch and DOUBLE-EXECUTE
 * the same workflow. `writeLaunchIntent` therefore refuses to write when
 * `inlineWorkflowsActive` is set — BEFORE it touches disk.
 *
 * These are real tests: they assert on the actual return value AND that the
 * on-disk intents/ tree is truly empty (nothing was persisted).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { intentsDir } from '@/modules/workflow-supervisor/config.js';
import { writeLaunchIntent } from '@/modules/workflow-supervisor/launch-intent.js';

/** Recursively collect every regular-file path under a dir (empty if none/absent). */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

test('B-126: inlineWorkflowsActive + flag ON + pendingWorkflows=2 => written:false, reason cites B-126, NOTHING on disk', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-dedup-inline-'));
  try {
    const env = { WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_STATE_DIR: tempRoot };
    const res = await writeLaunchIntent({
      userId: 7,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'the raw command',
      pendingWorkflows: 2,
      inlineWorkflowsActive: true,
      env,
    });
    assert.equal(res.written, false, 'must refuse to write when the workflow already ran inline');
    if (!res.written) assert.match(res.reason, /B-126/, 'reason must cite B-126');
    // The intents tree must be genuinely empty — no file, no per-user dir content.
    const files = await listFiles(intentsDir(env));
    assert.deepEqual(files, [], 'no intent file may be persisted on the dedup refusal');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('B-126: inlineWorkflowsActive=false + flag ON + valid userId & projectPath => written:true', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-dedup-normal-'));
  try {
    const env = { WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_STATE_DIR: tempRoot };
    const res = await writeLaunchIntent({
      userId: 9,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'run the workflow',
      pendingWorkflows: 1,
      inlineWorkflowsActive: false,
      env,
    });
    assert.equal(res.written, true, 'a genuine, non-inline launch still writes an intent');
    if (res.written) {
      assert.match(res.path, /\/intents\/9\/.+\.json$/, 'intent lives under intents/<userId>/');
      const files = await listFiles(intentsDir(env));
      assert.equal(files.length, 1, 'exactly one intent file persisted');
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('B-126: flag OFF is a TOTAL no-op — inlineWorkflowsActive is never even consulted, nothing on disk', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-dedup-off-'));
  try {
    // Flag intentionally ABSENT => off. inlineWorkflowsActive left undefined to prove
    // the OFF gate short-circuits BEFORE the dedup gate reads that field.
    const env = { WORKFLOW_SUPERVISOR_STATE_DIR: tempRoot };
    const res = await writeLaunchIntent({
      userId: 7,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'the raw command',
      pendingWorkflows: 2,
      env,
    });
    assert.equal(res.written, false);
    if (!res.written) assert.match(res.reason, /flag off/, 'OFF gate wins — reason is "flag off", not B-126');
    const entries = await readdir(tempRoot).catch(() => []);
    assert.deepEqual(entries, [], 'flag OFF writes nothing at all');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
