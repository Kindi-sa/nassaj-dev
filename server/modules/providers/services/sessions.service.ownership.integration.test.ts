/**
 * sessions.service.ownership.integration.test.ts — B-105 REST IDOR fix.
 *
 * Proves the fail-closed ownership gate on sessionsService.fetchHistory: the
 * endpoint GET /sessions/:id/messages used to derive the session from the URL
 * alone and never check who was asking, so any authenticated user could read
 * another user's conversation by sessionId. The gate added to the service now
 * refuses unless the caller is an owner/participant of — or a recorded message
 * author in — the session, and refuses with the SAME 404 contract used for a
 * missing session so the existence of someone else's session is not disclosed.
 *
 * The fixtures are realistic, not synthetic: real users are created in the DB,
 * the owner is recorded through the exact production run-path call
 * (participantsDb.recordSpawn), and a real vendor transcript .jsonl is written
 * to disk and resolved through the live provider. The provider choice (kimi)
 * is incidental — the gate sits in the service ahead of provider resolution.
 *
 * node:test does not isolate state, so each scenario gets its own DB + temp
 * home (the vendor provider resolves transcripts under os.homedir()).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  messageAuthorsDb,
  participantsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { vendorProjectHash } from '@/modules/providers/shared/vendor/vendor-transcript.js';

const PROJECT_PATH = '/work/secret-proj';
const SESSION_ID = 'owned-by-alice-001';

type Fixture = {
  ownerId: number;
  outsiderId: number;
};

/**
 * Builds an isolated DB + temp home, writes a real kimi vendor transcript for
 * SESSION_ID, registers the session row, and records `ownerUsername` as the
 * session owner through the production spawn path. Returns the created user ids.
 */
async function withOwnedSession(
  runTest: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalHome = os.homedir;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b105-ownership-'));
  const databasePath = path.join(tempRoot, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  // The vendor provider reads transcripts relative to the home directory.
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    const ownerId = userDb.createUser('alice', 'hash-a', 'user').id;
    const outsiderId = userDb.createUser('bob', 'hash-b', 'user').id;

    // Real transcript on disk, resolved through the live kimi provider path.
    const dir = path.join(tempRoot, '.nassaj-vendor-sessions', 'kimi', vendorProjectHash(PROJECT_PATH));
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'meta', projectPath: PROJECT_PATH, sessionName: 'secret' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'my private prompt' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'private answer' } }),
    ];
    await fs.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);

    sessionsDb.createSession(SESSION_ID, 'kimi', PROJECT_PATH);
    // Production run-path ownership stamp: alice is the first (owner) participant.
    participantsDb.recordSpawn(SESSION_ID, ownerId);

    await runTest({ ownerId, outsiderId });
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('B-105: owner reads their own session history', async () => {
  await withOwnedSession(async ({ ownerId }) => {
    const result = await sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 10, offset: 0 });
    assert.equal(result.total, 2, 'owner sees the full transcript');
    assert.equal(result.messages[0]?.content, 'my private prompt');
    assert.equal(result.messages[1]?.content, 'private answer');
  });
});

test("B-105: a different authenticated user is refused (404, no content leak)", async () => {
  await withOwnedSession(async ({ outsiderId }) => {
    await assert.rejects(
      () => sessionsService.fetchHistory(SESSION_ID, outsiderId, { limit: 10, offset: 0 }),
      (err: unknown) => {
        const e = err as { statusCode?: number; code?: string };
        assert.equal(e.statusCode, 404, 'outsider gets 404, not the messages');
        assert.equal(e.code, 'SESSION_NOT_FOUND', 'same contract as a missing session (no existence disclosure)');
        return true;
      },
      'an authenticated non-participant must NOT receive another user\'s conversation',
    );
  });
});

test('B-105: an unauthenticated/unresolved caller (null) is refused', async () => {
  await withOwnedSession(async () => {
    await assert.rejects(
      () => sessionsService.fetchHistory(SESSION_ID, null, { limit: 10, offset: 0 }),
      (err: unknown) => {
        const e = err as { statusCode?: number; code?: string };
        assert.equal(e.statusCode, 404);
        assert.equal(e.code, 'SESSION_NOT_FOUND');
        return true;
      },
    );
  });
});

test('B-105: a message author (no participant row) is allowed — second half of the access model', async () => {
  await withOwnedSession(async () => {
    // A user who never spawned (no session_participants row) but authored a
    // message in the session is part of the access model and must pass.
    const authorId = userDb.createUser('carol', 'hash-c', 'user').id;
    messageAuthorsDb.recordUserMessage(SESSION_ID, authorId, 'my private prompt');

    const result = await sessionsService.fetchHistory(SESSION_ID, authorId, { limit: 10, offset: 0 });
    assert.equal(result.total, 2, 'recorded author reads the session');
  });
});

test('B-105: isParticipant predicate is fail-closed for a non-member and rejects non-integer ids', async () => {
  await withOwnedSession(async ({ ownerId, outsiderId }) => {
    assert.equal(participantsDb.isParticipant(SESSION_ID, ownerId), true, 'owner is a participant');
    assert.equal(participantsDb.isParticipant(SESSION_ID, outsiderId), false, 'outsider is not');
    assert.equal(participantsDb.isParticipant(SESSION_ID, Number.NaN), false, 'NaN matches nothing');
    assert.equal(participantsDb.isParticipant('no-such-session', ownerId), false, 'unknown session matches nothing');
  });
});
