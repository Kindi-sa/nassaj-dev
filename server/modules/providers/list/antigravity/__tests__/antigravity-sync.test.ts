import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  clearAntigravityProjectPath,
  registerAntigravityProjectPath,
} from '@/modules/providers/list/antigravity/antigravity-project-registry.js';
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

test('synchronize strips out <instructions> tags from the session title', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\n<instructions>\nIMPORTANT: Arabic only\n</instructions>\n\nWrite me a poem\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'Write me a poem');
    },
  );
});

test('synchronize strips every <instructions> block from the title when several are present', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content:
          '<USER_REQUEST>\n<instructions>\nArabic only\n</instructions>\nWrite me a poem\n<instructions>\nbe concise\n</instructions>\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'Write me a poem');
    },
  );
});

test('synchronize falls back to the default title when the request is only an <instructions> block', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\n<instructions>\nIMPORTANT: Arabic only\n</instructions>\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      // Stripping the injected instructions leaves no user text, so
      // extractTitleFromFirstLine returns undefined and the synchronizer falls
      // back to the default title rather than naming the chat after machine input.
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'New Antigravity Chat');
    },
  );
});

test('synchronize preserves an existing real project_path instead of clobbering it with the placeholder', async () => {
  // Regression: agy-cli.js registers a freshly created session under its real
  // workspace cwd on process close. A subsequent full sync must NOT relocate
  // that session into the phantom /__antigravity__ workspace, or it disappears
  // from the owning project's sidebar.
  const REAL_PROJECT_PATH = '/home/nassaj/Project/nassaj-dev';

  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nhello from a real project\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      // Simulate agy-cli.js close handler having already filed the session
      // under the real project path.
      sessionsDb.createSession(SESSION_UUID, 'antigravity', REAL_PROJECT_PATH);

      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.project_path, REAL_PROJECT_PATH);
      assert.notEqual(row?.project_path, ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH);
    },
  );
});

test('synchronize uses the in-process registry path when the DB row does not exist yet', async () => {
  // Regression: a synchronize() (boot / sidebar refresh / watcher) can reach a
  // brand-new brain UUID *before* agy-cli.js has written its DB row. Without the
  // registry fallback the first sync files the /__antigravity__ placeholder and
  // nothing ever corrects it — the conversation vanishes from its project folder.
  const REAL_PROJECT_PATH = '/home/nassaj/Project/nassaj-dev';

  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>raced against the close handler</USER_REQUEST>',
      });
    },
    async (sync) => {
      // The spawn adapter publishes the binding the instant it discovers the UUID,
      // before any DB row exists for it.
      registerAntigravityProjectPath(SESSION_UUID, REAL_PROJECT_PATH);
      try {
        const processed = await sync.synchronize();
        assert.equal(processed, 1);

        const row = sessionsDb.getSessionById(SESSION_UUID);
        assert.equal(row?.project_path, REAL_PROJECT_PATH);
        assert.notEqual(row?.project_path, ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH);
      } finally {
        clearAntigravityProjectPath(SESSION_UUID);
      }
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
