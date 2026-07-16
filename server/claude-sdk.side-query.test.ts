/**
 * claude-sdk.side-query.test.ts — T-881 (/btw read-only side query).
 *
 * Proves the hard gates the design review (qa-critic) attached to "البديل 2"
 * (SDK fork), driving the REAL spawnClaudeSideQuery with ONLY the Agent SDK
 * `query` module-mocked (no real Claude Code child is spawned):
 *
 *   (a·C2) a /btw query enters NOTHING into activeSessions — neither the live
 *          session id nor the fork id — before, DURING, or after the run, so the
 *          drain count / ghost-detach / mirror fan-out never see it; and it never
 *          appends to the original `<liveSid>.jsonl` (asserted structurally via
 *          the SDK options: forkSession:true routes writes to a NEW id and
 *          persistSession:false writes nothing at all — a bare resume is refused).
 *   (C1)   the fork is resume + forkSession:true (never a bare resume).
 *   (C3)   disallowedTools blocks Write/Edit/NotebookEdit/Bash and the run never
 *          uses bypassPermissions — a read-only query.
 *   (C4)   an optional upToMessageId is forwarded as SDK resumeSessionAt.
 *   + streaming: assistant text → onChunk, then onComplete; error/resume-missing
 *          results map to the sdk_error / session_not_found codes.
 *
 * Runner: node:test with --experimental-test-module-mocks (no vitest). The SDK
 * mock MUST be registered before importing the module-under-test, hence the
 * dynamic import below.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test, { mock, beforeEach, afterEach } from 'node:test';

type SdkMessage = Record<string, unknown>;

// --- Agent SDK mock ----------------------------------------------------------
// `query(arg)` records the constructed arg and returns an async-iterable that
// yields the scripted messages, exposing interrupt() for teardown. `onYield`
// lets a test observe state (e.g. activeSessions) DURING the stream.
let scriptedMessages: SdkMessage[] = [];
let lastQueryArg: { prompt?: unknown; options?: Record<string, unknown> } | null = null;
let interruptCount = 0;
let onYield: (() => void) | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { prompt?: unknown; options?: Record<string, unknown> }) => {
      lastQueryArg = arg;
      const messages = scriptedMessages;
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) {
            onYield?.();
            yield m;
          }
        },
        interrupt: async () => {
          interruptCount += 1;
        },
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    // Stubs so claude-sdk.js's transitive import graph (vendor-delegate-mcp.js)
    // instantiates. They are never invoked in these tests (no vendor delegation).
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  spawnClaudeSideQuery: (
    params: Record<string, unknown>,
    callbacks: {
      onStarted?: (handle: { interrupt: () => void }) => void;
      onChunk?: (text: string) => void;
      onError?: (code: string, message: string) => void;
      onComplete?: () => void;
    }
  ) => Promise<void>;
  getActiveClaudeSDKSessions: () => string[];
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
};

const LIVE_SID = 'live-session-uuid-1111';
const FORK_SID = 'forked-session-uuid-9999';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'NASSAJ_PROVIDER_CAGE',
] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';

beforeEach(() => {
  scriptedMessages = [];
  lastQueryArg = null;
  interruptCount = 0;
  onYield = null;

  // Hermetic env: no competitor base URL / token, cage OFF, and an EMPTY claude
  // config dir so the real settings-env guards read nothing (degrade-safe → inert)
  // instead of the operator's real ~/.claude.
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.NASSAJ_PROVIDER_CAGE;
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

test('T-881(a/C1/C2/C3/C4): fork isolation, no activeSessions registration, read-only, streamed', async () => {
  scriptedMessages = [
    {
      type: 'assistant',
      session_id: FORK_SID,
      message: { content: [{ type: 'text', text: 'The build script is npm run build:server.' }] },
    },
    {
      type: 'result',
      session_id: FORK_SID,
      subtype: 'success',
      is_error: false,
      result: 'The build script is npm run build:server.',
    },
  ];

  // Precondition: the live session is not registered as active in this test scope.
  assert.ok(!sdk.getActiveClaudeSDKSessions().includes(LIVE_SID), 'liveSid absent before the run');

  // C2 (mid-stream): assert on EVERY yielded message that neither id is registered.
  onYield = () => {
    const active = sdk.getActiveClaudeSDKSessions();
    assert.ok(!active.includes(LIVE_SID), 'liveSid never registered mid-stream');
    assert.ok(!active.includes(FORK_SID), 'fork id never registered mid-stream');
  };

  const chunks: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  let completed = false;

  await sdk.spawnClaudeSideQuery(
    {
      sessionId: LIVE_SID,
      question: 'what is the build script?',
      upToMessageId: 'msg-uuid-42',
      userId: null,
      cwd: process.cwd(),
    },
    {
      onChunk: (t) => chunks.push(t),
      onError: (code, message) => errors.push({ code, message }),
      onComplete: () => {
        completed = true;
      },
    }
  );

  assert.ok(lastQueryArg, 'the SDK query was constructed');
  const opts = lastQueryArg!.options ?? {};

  // C1: forked resume — never a bare resume.
  assert.equal(opts.resume, LIVE_SID, 'resume targets the live session id (C1)');
  assert.equal(opts.forkSession, true, 'forkSession:true — never a bare resume (C1)');
  // C1/C2: the fork writes nothing to disk, so the original <liveSid>.jsonl is
  // never appended to (and forkSession would route any write to a NEW id anyway).
  assert.equal(opts.persistSession, false, 'persistSession:false — fork writes no jsonl (C1/C2)');
  assert.equal(lastQueryArg!.prompt, 'what is the build script?', 'the question is the prompt');

  // C4: the pinned message id is forwarded as resumeSessionAt.
  assert.equal(opts.resumeSessionAt, 'msg-uuid-42', 'upToMessageId → resumeSessionAt (C4)');

  // C3: read-only tool wall + never bypassPermissions.
  const disallowed = (opts.disallowedTools ?? []) as string[];
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
    assert.ok(disallowed.includes(tool), `disallowedTools blocks ${tool} (C3)`);
  }
  assert.notEqual(opts.permissionMode, 'bypassPermissions', 'never bypassPermissions (C3)');

  // C2 (after): neither id ever entered activeSessions.
  const activeAfter = sdk.getActiveClaudeSDKSessions();
  assert.ok(!activeAfter.includes(LIVE_SID), 'liveSid never entered activeSessions (C2)');
  assert.ok(!activeAfter.includes(FORK_SID), 'fork id never entered activeSessions (C2)');
  // getSession(liveSid) is a miss (never registered) ⇒ isClaudeSDKSessionActive is
  // falsy (undefined), which itself confirms the fork was never tracked (C2).
  assert.ok(!sdk.isClaudeSDKSessionActive(LIVE_SID), 'liveSid not reported active (C2)');

  // Streaming contract.
  assert.deepEqual(chunks, ['The build script is npm run build:server.'], 'assistant text streamed');
  assert.equal(completed, true, 'onComplete fired on success');
  assert.deepEqual(errors, [], 'no error on the happy path');
  assert.ok(interruptCount >= 1, 'the fork child is interrupted/torn down after the one-shot answer');
});

test('T-881(C4): no upToMessageId ⇒ resumeSessionAt is not set (fork from the tail)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];

  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', upToMessageId: null, userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );

  const opts = lastQueryArg!.options ?? {};
  assert.equal(opts.resume, LIVE_SID);
  assert.equal(opts.forkSession, true);
  assert.equal('resumeSessionAt' in opts, false, 'resumeSessionAt omitted when no message is pinned');
});

test('T-881: an error result maps to the sdk_error code (no complete)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'error_during_execution', is_error: true, result: 'boom' },
  ];

  const errors: Array<{ code: string; message: string }> = [];
  let completed = false;
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    {
      onChunk: () => {},
      onError: (code, message) => errors.push({ code, message }),
      onComplete: () => {
        completed = true;
      },
    }
  );

  assert.equal(errors.length, 1, 'exactly one terminal error');
  assert.equal(errors[0].code, 'sdk_error');
  assert.equal(completed, false, 'no onComplete after an error');
});

test('T-881: a "no conversation found" result maps to session_not_found', async () => {
  scriptedMessages = [
    {
      type: 'result',
      session_id: FORK_SID,
      subtype: 'error_during_execution',
      is_error: true,
      result: 'No conversation found with session ID: ' + LIVE_SID,
    },
  ];

  const errors: Array<{ code: string; message: string }> = [];
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: (code, message) => errors.push({ code, message }), onComplete: () => {} }
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'session_not_found', 'stale/missing session → session_not_found');
});

test('T-881: an empty question is rejected before any fork is constructed', async () => {
  const errors: Array<{ code: string; message: string }> = [];
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: '   ', userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: (code, message) => errors.push({ code, message }), onComplete: () => {} }
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'sdk_error');
  assert.equal(lastQueryArg, null, 'no SDK query constructed for an empty question');
});

test('T-881(A-2.3): a null/blank project path is refused (sdk_error, no fork constructed)', async () => {
  for (const badCwd of [null, '', '   ']) {
    lastQueryArg = null;
    const errors: Array<{ code: string; message: string }> = [];
    let completed = false;
    await sdk.spawnClaudeSideQuery(
      { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: badCwd },
      {
        onChunk: () => {},
        onError: (code, message) => errors.push({ code, message }),
        onComplete: () => {
          completed = true;
        },
      }
    );
    assert.equal(errors.length, 1, `exactly one error for cwd=${JSON.stringify(badCwd)}`);
    assert.equal(errors[0].code, 'sdk_error', 'a missing project path is sdk_error');
    assert.equal(completed, false, 'no completion when the project path is missing');
    assert.equal(lastQueryArg, null, 'the fork is never constructed without a project root');
  }
});

test('T-881(A-2.1): the tool wall is an allowlist — only Read/Grep/Glob pass, all else denied', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const projectRoot = process.cwd();
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: projectRoot },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};
  const canUseTool = opts.canUseTool as (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<{ behavior: string; message?: string }>;
  assert.equal(typeof canUseTool, 'function', 'canUseTool is installed on the fork');

  // A-2.1: WebFetch/WebSearch dropped from the allowed set, along with every
  // mutating/executing/interactive tool.
  for (const denied of ['WebFetch', 'WebSearch', 'Write', 'Edit', 'Bash', 'Task', 'AskUserQuestion']) {
    const d = await canUseTool(denied, {});
    assert.equal(d.behavior, 'deny', `${denied} is denied by the allowlist`);
  }
  // Read/Grep/Glob remain, inside the project.
  const rIn = await canUseTool('Read', { file_path: path.join(projectRoot, 'server/claude-sdk.js') });
  assert.equal(rIn.behavior, 'allow', 'Read inside the project is allowed');
  const gIn = await canUseTool('Grep', { pattern: 'x', path: path.join(projectRoot, 'server') });
  assert.equal(gIn.behavior, 'allow', 'Grep inside the project is allowed');
  const globNoPath = await canUseTool('Glob', { pattern: '**/*.ts' });
  assert.equal(globNoPath.behavior, 'allow', 'Glob with no path defaults to the project cwd (allowed)');
});

test('T-881(A-2.2): Read/Grep/Glob are confined to the project root (absolute + ".." escapes denied)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const projectRoot = process.cwd();
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: projectRoot },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};
  const canUseTool = opts.canUseTool as (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<{ behavior: string; message?: string }>;

  // A relative path resolves under the root ⇒ allowed.
  const relRead = await canUseTool('Read', { file_path: 'server/index.js' });
  assert.equal(relRead.behavior, 'allow', 'a relative Read resolves under the project root');

  // Absolute path outside the root ⇒ denied.
  const absOut = await canUseTool('Read', { file_path: '/etc/passwd' });
  assert.equal(absOut.behavior, 'deny', 'an absolute Read outside the project is denied');

  // ".." traversal (absolute or relative) that climbs out of the root ⇒ denied.
  const escAbs = await canUseTool('Read', { file_path: path.join(projectRoot, '../../../etc/passwd') });
  assert.equal(escAbs.behavior, 'deny', '".." traversal out of the root is denied');
  const escRel = await canUseTool('Read', { file_path: '../outside-secret' });
  assert.equal(escRel.behavior, 'deny', 'a relative ".." escape is denied');

  // Grep/Glob honour the same boundary on their `path` field.
  const grepOut = await canUseTool('Grep', { pattern: 'x', path: '/etc' });
  assert.equal(grepOut.behavior, 'deny', 'Grep outside the project is denied');
  const globOut = await canUseTool('Glob', { pattern: '*', path: path.join(projectRoot, '..') });
  assert.equal(globOut.behavior, 'deny', 'Glob rooted above the project is denied');

  // A Read with no file_path cannot be confined ⇒ denied.
  const readNoPath = await canUseTool('Read', {});
  assert.equal(readNoPath.behavior, 'deny', 'a Read with no file_path is denied');
});

test('T-881(A-1): onStarted hands back an interrupt handle that tears the fork down', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const handles: Array<{ interrupt: () => void }> = [];
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    {
      onStarted: (h) => {
        handles.push(h);
      },
      onChunk: () => {},
      onError: () => {},
      onComplete: () => {},
    }
  );
  assert.equal(handles.length, 1, 'onStarted fired exactly once with a handle');
  assert.equal(typeof handles[0].interrupt, 'function', 'the handle exposes interrupt()');
  const before = interruptCount;
  handles[0].interrupt();
  assert.ok(interruptCount >= before + 1, 'invoking the handle interrupts the underlying fork');
});
