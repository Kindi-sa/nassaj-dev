/**
 * T-822 — the Tier-B injector core (offline, with a stubbed `runResumeTurn` that
 * simulates the CLI appending the ref-anchored resumed turn). Proves:
 *  - happy path: ONE turn, ledger committed, spend recorded, the injected prompt
 *    carries the ref token + disallowedTools=Task/Workflow (leaf-only),
 *  - coalescing: ≥3 tasks for one conversation ⇒ ONE turn, ONE ledger batch,
 *  - exactly-once: a second pass after delivery is a no-op (ledger hit),
 *  - ledger-repair: a committed ref with no ledger ⇒ repaired, NO re-turn,
 *  - budget exceeded ⇒ card fallback (NO turn), result still surfaced,
 *  - kill switch ⇒ card fallback,
 *  - deferred: a held (human) lock ⇒ defer, NO turn,
 *  - bad userId ⇒ denied, NO turn,
 *  - leaf-only proof: no new intent file ⇒ newIntentFiles === 0.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  injectForConversation,
  buildCoalescedPrompt,
  type ConversationInjectInput,
  type InjectTaskInput,
  type ResumeTurnParams,
  type ResumeTurnResult,
} from '@/modules/workflow-supervisor/handoff-injector.js';
import {
  handoffId,
  injectionRefToken,
  readLedger,
  ledgerHasTask,
} from '@/modules/workflow-supervisor/handoff.js';
import { acquireInjectorTurnLock } from '@/modules/workflow-supervisor/chat-turn-lock.js';
import { readSpend } from '@/modules/workflow-supervisor/handoff-budget.js';

function envFor(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root, ...extra };
}

/** A stub runner that simulates `claude -p --resume` appending the ref-anchored
 * user turn + an assistant turn to the jsonl, and returns usage. */
function makeStub(jsonlPath: string) {
  const calls: ResumeTurnParams[] = [];
  const run = async (params: ResumeTurnParams): Promise<ResumeTurnResult> => {
    calls.push(params);
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: params.prompt }, uuid: 'u' }) + '\n',
    );
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ack' }, uuid: 'a' }) + '\n',
    );
    return { ok: true, exitCode: 0, timedOut: false, resultObj: { usage: { input_tokens: 1000, output_tokens: 300 } } };
  };
  return { run, calls };
}

function mkTask(root: string, taskId: string, outcome: InjectTaskInput['outcome'] = 'SUCCEEDED'): InjectTaskInput {
  const taskDir = path.join(root, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  return { taskId, userId: 7, outcome, resultObj: { text: `result of ${taskId}` }, taskDir };
}

function inputFor(root: string, conv: string, tasks: InjectTaskInput[]): ConversationInjectInput {
  return {
    conversationId: conv,
    projectPath: path.join(root, 'proj'),
    jsonlPath: path.join(root, `${conv}.jsonl`),
    tasks,
  };
}

test('happy path: one leaf-only turn, ledger committed, spend recorded, ref+tools in prompt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-happy-'));
  const env = envFor(root);
  try {
    const input = inputFor(root, 'conv1', [mkTask(root, 'ta')]);
    const stub = makeStub(input.jsonlPath);
    const r = await injectForConversation({ env, runResumeTurn: stub.run }, input);

    assert.equal(r.event, 'delivered');
    assert.deepEqual(r.injected, ['ta']);
    assert.equal(r.newIntentFiles, 0, 'leaf-only: no new intent written');
    assert.equal(stub.calls.length, 1, 'exactly one turn');
    // Leaf-only tool policy + ref token in the prompt.
    assert.deepEqual([...stub.calls[0]!.disallowedTools], ['Task', 'Workflow']);
    assert.ok(stub.calls[0]!.prompt.includes(injectionRefToken(handoffId('ta'))), 'prompt carries the ref anchor');
    assert.ok(!('ENABLE_ULTRACODE_WORKFLOWS' in stub.calls[0]!.env), 'workflow env stripped');
    // Ledger + spend.
    assert.ok(ledgerHasTask(readLedger(env, 'conv1'), 'ta'));
    assert.equal(readSpend(env, 'conv', 'conv1').tokens, 1300);
    assert.equal(readSpend(env, 'user', 7).tokens, 1300);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('coalescing: 3 tasks ⇒ ONE turn, ONE ledger batch of 3', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-coal-'));
  const env = envFor(root);
  try {
    const input = inputFor(root, 'conv2', [mkTask(root, 'c1'), mkTask(root, 'c2'), mkTask(root, 'c3')]);
    const stub = makeStub(input.jsonlPath);
    const r = await injectForConversation({ env, runResumeTurn: stub.run }, input);

    assert.equal(r.event, 'delivered');
    assert.equal(stub.calls.length, 1, 'a SINGLE coalesced turn for all three');
    assert.deepEqual(r.injected.sort(), ['c1', 'c2', 'c3']);
    const ledger = readLedger(env, 'conv2');
    assert.equal(ledger!.entries!.length, 3, 'one atomic ledger batch of three');
    for (const t of ['c1', 'c2', 'c3']) {
      assert.ok(stub.calls[0]!.prompt.includes(injectionRefToken(handoffId(t))), `ref for ${t} present`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exactly-once: a second pass after delivery is a ledger-hit no-op', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-once-'));
  const env = envFor(root);
  try {
    const input = inputFor(root, 'conv3', [mkTask(root, 'o1')]);
    const stub = makeStub(input.jsonlPath);
    await injectForConversation({ env, runResumeTurn: stub.run }, input);
    // Same task again (fresh InjectTaskInput, same id) ⇒ nothing to do.
    const r2 = await injectForConversation({ env, runResumeTurn: stub.run }, inputFor(root, 'conv3', [mkTask(root, 'o1')]));
    assert.equal(r2.event, 'nothing-pending');
    assert.equal(stub.calls.length, 1, 'no second turn');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ledger-repair: a committed ref with no ledger ⇒ repaired, NO re-turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-repair-'));
  const env = envFor(root);
  try {
    const input = inputFor(root, 'conv4', [mkTask(root, 'r1')]);
    // Simulate a crash AFTER the turn committed (ref in jsonl) but BEFORE the ledger.
    const ref = injectionRefToken(handoffId('r1'));
    fs.writeFileSync(
      input.jsonlPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: `x ${ref} y` }, uuid: 'u' }) + '\n',
    );
    const stub = makeStub(input.jsonlPath);
    const r = await injectForConversation({ env, runResumeTurn: stub.run }, input);
    assert.equal(r.event, 'repaired-only');
    assert.deepEqual(r.repaired, ['r1']);
    assert.equal(stub.calls.length, 0, 'the expensive turn is NOT re-run');
    assert.ok(ledgerHasTask(readLedger(env, 'conv4'), 'r1'), 'ledger repaired');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('budget exceeded ⇒ card fallback (NO turn), result still surfaced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-budget-'));
  const env = envFor(root, {
    WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_CONV_MAX: '1000',
    WORKFLOW_SUPERVISOR_HANDOFF_TURN_TOKEN_ESTIMATE: '73000',
  });
  try {
    const input = inputFor(root, 'conv5', [mkTask(root, 'b1')]);
    const stub = makeStub(input.jsonlPath);
    const r = await injectForConversation({ env, runResumeTurn: stub.run }, input);
    assert.equal(r.event, 'card-fallback');
    assert.equal(r.fellBackToCard, true);
    assert.equal(stub.calls.length, 0, 'NO expensive turn over budget');
    // The result is still delivered as a Tier-A card (exactly-once via ledger).
    assert.ok(ledgerHasTask(readLedger(env, 'conv5'), 'b1'));
    const cardLine = fs.readFileSync(input.jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
    assert.equal(cardLine.kind, 'task_reconcile', 'a card, not a turn');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('kill switch ⇒ card fallback (NO turn)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-kill-'));
  const env = envFor(root, { WORKFLOW_SUPERVISOR_HANDOFF_KILL: '1' });
  try {
    const input = inputFor(root, 'conv6', [mkTask(root, 'k1')]);
    const stub = makeStub(input.jsonlPath);
    const r = await injectForConversation({ env, runResumeTurn: stub.run }, input);
    assert.equal(r.event, 'card-fallback');
    assert.equal(stub.calls.length, 0);
    assert.ok(ledgerHasTask(readLedger(env, 'conv6'), 'k1'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deferred: a held (human) lock ⇒ defer, NO turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-defer-'));
  const env = envFor(root);
  try {
    const input = inputFor(root, 'conv7', [mkTask(root, 'd1')]);
    const stub = makeStub(input.jsonlPath);
    // A live human turn holds the lock.
    const human = await acquireInjectorTurnLock('conv7', env);
    assert.equal(human.held, true);
    const r = await injectForConversation({ env, runResumeTurn: stub.run }, input);
    assert.equal(r.event, 'deferred');
    assert.equal(r.deferred, true);
    assert.equal(stub.calls.length, 0, 'human priority — injector does not run');
    assert.ok(!ledgerHasTask(readLedger(env, 'conv7'), 'd1'), 'not delivered — retried later');
    human.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bad userId ⇒ denied, NO turn (fail-closed §هـ-1)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-uid-'));
  const env = envFor(root);
  try {
    const task = mkTask(root, 'u1');
    (task as { userId: number }).userId = 0; // non-positive
    const input = inputFor(root, 'conv8', [task]);
    const stub = makeStub(input.jsonlPath);
    const r = await injectForConversation({ env, runResumeTurn: stub.run }, input);
    assert.equal(r.event, 'denied');
    assert.equal(stub.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildCoalescedPrompt: trusted preamble + one ref-wrapped block per task', () => {
  const tasks: InjectTaskInput[] = [
    { taskId: 'p1', userId: 7, outcome: 'SUCCEEDED', resultObj: 'r1', taskDir: '/x' },
    { taskId: 'p2', userId: 7, outcome: 'SUCCEEDED', resultObj: 'r2', taskDir: '/x' },
  ];
  const prompt = buildCoalescedPrompt(tasks);
  assert.match(prompt, /^2 background task results are delivered below as data\./);
  assert.ok(prompt.includes(injectionRefToken(handoffId('p1'))));
  assert.ok(prompt.includes(injectionRefToken(handoffId('p2'))));
});
