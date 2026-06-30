/**
 * session-conversations-search.service.ownership.integration.test.ts — B-106.
 *
 * Sibling of the B-105 REST IDOR fix, one class wider. GET /search/sessions
 * scanned every transcript on disk across ALL projects with no notion of who was
 * asking, then streamed matching content snippets over SSE — so any
 * authenticated user could read (and watch live) other users' conversation
 * content. The gate added to searchConversations now keeps ONLY the sessions the
 * requester owns or participates in (participantsDb.isParticipant — the same
 * predicate that guards GET /sessions/:id/messages), applied BEFORE ripgrep runs
 * and before any project bucket is built or emitted, so a non-owned transcript
 * is never read off disk and never surfaces as a snippet — not even transiently.
 *
 * The fixtures are realistic, not synthetic: real users are created in the DB,
 * ownership is stamped through the exact production run-path call
 * (participantsDb.recordSpawn), and real Claude .jsonl transcripts are written to
 * disk and resolved through the live search path (sessionsDb.getAllSessions →
 * ripgrep over jsonl_path). The probe asserts on BOTH return values AND every
 * streamed progress update, so a leak via SSE would fail the test even if the
 * final result set were empty.
 *
 * node:test does not isolate state, so each scenario gets its own DB + temp dir
 * for the transcript files.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  searchConversations,
  type SessionConversationSearchProgressUpdate,
} from '@/modules/providers/services/session-conversations-search.service.js';

// A unique token so ripgrep matches our planted lines and nothing else on disk.
const SECRET_TERM = 'zylophascinatoryxqz';

type SessionSpec = {
  sessionId: string;
  projectPath: string;
  ownerId: number;
  // One user-authored transcript line containing SECRET_TERM.
  secretLine: string;
};

type Fixture = {
  aliceId: number;
  bobId: number;
  tempRoot: string;
  // Registers a Claude session: writes its transcript to disk, inserts the
  // sessions row pointing jsonl_path at that file, and stamps `ownerId` as the
  // owning participant through the production spawn path.
  addSession: (spec: SessionSpec) => Promise<void>;
};

/**
 * Collects every snippet streamed through onProgress so a test can prove no
 * content leaked over SSE, independent of the final result set.
 */
function collectSnippets(updates: SessionConversationSearchProgressUpdate[]): string[] {
  const snippets: string[] = [];
  for (const update of updates) {
    if (!update.projectResult) {
      continue;
    }
    for (const session of update.projectResult.sessions) {
      for (const match of session.matches) {
        snippets.push(match.snippet);
      }
    }
  }
  return snippets;
}

async function withFixture(runTest: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b106-search-ownership-'));
  const databasePath = path.join(tempRoot, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const aliceId = userDb.createUser('alice', 'hash-a', 'user').id;
    const bobId = userDb.createUser('bob', 'hash-b', 'user').id;

    const addSession = async (spec: SessionSpec): Promise<void> => {
      const transcriptPath = path.join(tempRoot, `${spec.sessionId}.jsonl`);
      const lines = [
        JSON.stringify({
          type: 'user',
          sessionId: spec.sessionId,
          uuid: `${spec.sessionId}-u1`,
          timestamp: '2026-06-30T10:00:00.000Z',
          message: { role: 'user', content: spec.secretLine },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: spec.sessionId,
          uuid: `${spec.sessionId}-a1`,
          timestamp: '2026-06-30T10:00:01.000Z',
          message: { role: 'assistant', content: 'an ordinary reply' },
        }),
      ];
      await fs.writeFile(transcriptPath, `${lines.join('\n')}\n`);

      // jsonl_path must be the real file on disk: the search path ripgreps it.
      sessionsDb.createSession(
        spec.sessionId,
        'claude',
        spec.projectPath,
        null as unknown as undefined,
        undefined,
        undefined,
        transcriptPath,
      );
      // Production run-path ownership stamp.
      participantsDb.recordSpawn(spec.sessionId, spec.ownerId);
    };

    await runTest({ aliceId, bobId, tempRoot, addSession });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('B-106: owner finds matches and snippets in their own session', async () => {
  await withFixture(async ({ aliceId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `please keep this ${SECRET_TERM} private`,
    });

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, aliceId, 50, (update) => {
      updates.push(update);
    });

    assert.equal(result.totalMatches, 1, 'owner sees exactly their one match');
    const sessionIds = result.results.flatMap((project) =>
      project.sessions.map((session) => session.sessionId),
    );
    assert.deepEqual(sessionIds, ['alice-session-1'], 'only the owned session is returned');

    const snippets = collectSnippets(updates);
    assert.equal(snippets.length, 1, 'one snippet streamed');
    assert.ok(
      snippets[0].includes(SECRET_TERM),
      'the streamed snippet is the owner-visible content',
    );
  });
});

test("B-106: a different authenticated user gets zero results AND zero snippets", async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    // Alice owns a session whose transcript contains SECRET_TERM on disk.
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `top ${SECRET_TERM} secret only alice should see`,
    });

    // Bob searches the same term. The transcript is on disk and ripgrep WOULD
    // match it, so an empty result here proves the gate excluded it before the
    // scan rather than the term simply being absent.
    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, bobId, 50, (update) => {
      updates.push(update);
    });

    assert.equal(result.totalMatches, 0, 'outsider sees no matches');
    assert.equal(result.results.length, 0, "outsider sees none of alice's sessions");

    const snippets = collectSnippets(updates);
    assert.equal(snippets.length, 0, 'NOT ONE snippet of another user content leaked over SSE');
    assert.ok(
      updates.every((update) => update.projectResult === null),
      'no project result for a non-owned session was ever emitted',
    );
  });
});

test('B-106: an unauthenticated/unresolved caller (null) is refused with no results or snippets', async () => {
  await withFixture(async ({ aliceId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `private ${SECRET_TERM} content`,
    });

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, null, 50, (update) => {
      updates.push(update);
    });

    assert.equal(result.totalMatches, 0, 'null caller owns nothing');
    assert.equal(result.results.length, 0, 'null caller sees no sessions');
    assert.equal(collectSnippets(updates).length, 0, 'null caller receives no snippets');
  });
});

test('B-106: per-project isolation — a user does not see another user project sessions', async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    // Two sessions in two different projects, each owned by a different user,
    // both transcripts containing SECRET_TERM on disk.
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `alice ${SECRET_TERM} note`,
    });
    await addSession({
      sessionId: 'bob-session-1',
      projectPath: '/work/bob-proj',
      ownerId: bobId,
      secretLine: `bob ${SECRET_TERM} note`,
    });

    // Alice searches: she must see her project/session only, never bob's.
    const aliceUpdates: SessionConversationSearchProgressUpdate[] = [];
    const aliceResult = await searchConversations(SECRET_TERM, aliceId, 50, (update) => {
      aliceUpdates.push(update);
    });

    const aliceSessionIds = aliceResult.results.flatMap((project) =>
      project.sessions.map((session) => session.sessionId),
    );
    assert.deepEqual(aliceSessionIds, ['alice-session-1'], 'alice sees only her own session');

    const aliceProjectNames = aliceResult.results.map((project) => project.projectName);
    assert.ok(
      !aliceProjectNames.includes('/work/bob-proj'),
      "bob's project is not present in alice's results",
    );
    assert.ok(
      collectSnippets(aliceUpdates).every((snippet) => !snippet.includes('bob')),
      "no snippet from bob's session leaked into alice's stream",
    );

    // Symmetric check: bob sees only his own session.
    const bobResult = await searchConversations(SECRET_TERM, bobId, 50);
    const bobSessionIds = bobResult.results.flatMap((project) =>
      project.sessions.map((session) => session.sessionId),
    );
    assert.deepEqual(bobSessionIds, ['bob-session-1'], 'bob sees only his own session');
  });
});
