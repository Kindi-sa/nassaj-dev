import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';

const SESSION_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH = '/__antigravity__';

const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = os.homedir;
  (os as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as { homedir: () => string }).homedir = original;
  };
};

/**
 * Sets up an isolated DB plus a fake `$HOME` so the synchronizer reads from a
 * disposable brain directory. The DB is required because synchronize() writes
 * session rows through sessionsDb.createSession (FK → projects).
 */
async function withSyncFixture(
  populate: (brainDir: string) => Promise<void> | void,
  runTest: (sync: AntigravitySessionSynchronizer, brainDir: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'agy-sync-'));
  const databasePath = path.join(tempHome, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const restoreHomeDir = patchHomeDir(tempHome);
  const brainDir = path.join(tempHome, '.gemini', 'antigravity-cli', 'brain');

  try {
    await populate(brainDir);
    const sync = new AntigravitySessionSynchronizer();
    await runTest(sync, brainDir);
  } finally {
    restoreHomeDir();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function writeTranscript(brainDir: string, uuid: string, firstLine: unknown): Promise<string> {
  const transcriptDir = path.join(brainDir, uuid, '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
  await writeFile(transcriptPath, JSON.stringify(firstLine) + '\n', 'utf8');
  return transcriptPath;
}

test('synchronize returns 0 when the brain directory does not exist yet', async () => {
  await withSyncFixture(
    () => {
      /* deliberately do not create the brain directory */
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(typeof processed, 'number');
      assert.equal(processed, 0);
    },
  );
});

test('synchronize indexes a brain UUID and writes a session row with the transcript path', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nWrite me a poem\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.ok(row, 'expected the synchronizer to upsert a session row');
      assert.equal(row?.provider, 'antigravity');
      assert.equal(row?.project_path, ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH);
      assert.equal(row?.custom_name, 'Write me a poem');
      assert.match(row?.jsonl_path ?? '', /transcript\.jsonl$/);
    },
  );
});

test('synchronize ignores non-UUID directory names inside the brain folder', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await mkdir(path.join(brainDir, 'not-a-uuid'), { recursive: true });
      await mkdir(path.join(brainDir, '.hidden'), { recursive: true });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 0);
    },
  );
});

test('synchronize skips brain UUIDs that have no transcript file yet', async () => {
  await withSyncFixture(
    async (brainDir) => {
      // Create the UUID folder but no transcript inside
      await mkdir(path.join(brainDir, SESSION_UUID), { recursive: true });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 0);
    },
  );
});

test('synchronize falls back to "New Antigravity Chat" when no USER_REQUEST is present', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: 'system warmup',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);
      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'New Antigravity Chat');
    },
  );
});

test('synchronize honours the `since` filter via transcript mtime', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>filtered out</USER_REQUEST>',
      });
    },
    async (sync) => {
      // mtime is "just now"; passing a future cutoff should skip everything
      const future = new Date(Date.now() + 60_000);
      const processed = await sync.synchronize(future);
      assert.equal(processed, 0);
    },
  );
});

test('synchronizeFile rejects paths that do not end in transcript.jsonl', async () => {
  await withSyncFixture(
    () => undefined,
    async (sync) => {
      const result = await sync.synchronizeFile('/tmp/not-a-transcript.txt');
      assert.equal(result, null);
    },
  );
});

test('synchronizeFile returns null when the UUID segment is not a valid UUID', async () => {
  await withSyncFixture(
    () => undefined,
    async (sync) => {
      const result = await sync.synchronizeFile(
        '/home/x/.gemini/antigravity-cli/brain/not-a-uuid/.system_generated/logs/transcript.jsonl',
      );
      assert.equal(result, null);
    },
  );
});

test('synchronizeFile indexes a single transcript path and returns its session id', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>single file ingest</USER_REQUEST>',
      });
    },
    async (sync, brainDir) => {
      const transcriptPath = path.join(brainDir, SESSION_UUID, '.system_generated', 'logs', 'transcript.jsonl');
      const result = await sync.synchronizeFile(transcriptPath);
      assert.equal(result, SESSION_UUID);
      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'single file ingest');
    },
  );
});
