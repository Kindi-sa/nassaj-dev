/**
 * Path-traversal hardening tests for the TaskMaster PRD routes
 * (server/routes/taskmaster.js) — regressions B-133 / B-135 / B-140.
 *
 * All three routes fed a caller-supplied `fileName` straight into
 * path.join(projectPath, '.taskmaster', 'docs', fileName) with no validation:
 *   - GET  /prd/:projectId/:fileName   (B-133, arbitrary file READ)   — encoded
 *     `..%2f..%2fetc%2fpasswd` survives Express routing and is decoded into the
 *     :param, so the raw path escaped the docs sandbox.
 *   - POST /apply-template/:projectId  (B-135, arbitrary file WRITE) — fileName
 *     from req.body.
 *   - POST /parse-prd/:projectId       (B-140, arbitrary file target) — fileName
 *     from req.body.
 *
 * The fix routes every filename through the shared resolvePrdFilePath() guard
 * (reference pattern originally on POST /prd): reject with 400 unless the name
 * matches /^[\w\-. ]+\.(txt|md)$/ AND the resolved absolute path stays strictly
 * inside <projectPath>/.taskmaster/docs.
 *
 * Framework: node:test (built-in) + node:assert/strict via tsx, matching the
 * server suite (package.json "test"; vitest here is client-only, scoped to
 * src/** by vite.config.js) and the sibling plugins.role-gate.test.ts. The real
 * router is mounted on a throwaway express app; the database index and the two
 * side-effecting utils are isolated with node:test module mocking (requires
 * --experimental-test-module-mocks) so importing the router never opens the real
 * SQLite store. The mocked projectsDb.getProjectPathById returns a per-run temp
 * dir, so the only filesystem the accepting tests touch is a throwaway sandbox.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

// The DB id the mocked projectsDb resolves to the per-run temp project path.
const VALID_ID = 'valid-project';

// Per-run sandbox: <tmp>/.taskmaster/docs with a prd.txt fixture the GET
// acceptance case reads back. Created before the mock so its closure can
// hand the path back as the resolved project directory.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-taskmaster-trav-'));
const docsDir = path.join(tmpDir, '.taskmaster', 'docs');
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, 'prd.txt'), '# Valid PRD\n', 'utf8');

// Resolve the specifiers taskmaster.js imports to absolute file URLs, then mock
// them BEFORE importing the router (node:test module mocks are NOT hoisted, so
// registration order matters — unlike vitest's vi.mock). Only getProjectPathById
// is exercised; the util mocks just keep the import graph off real code.
const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../modules/database/index.js')
).href;
const mcpDetectorUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../utils/mcp-detector.js')
).href;
const tmWebsocketUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../utils/taskmaster-websocket.js')
).href;

mock.module(dbIndexUrl, {
  namedExports: {
    projectsDb: {
      getProjectPathById: (id: string) => (id === VALID_ID ? tmpDir : null),
    },
  },
});
mock.module(mcpDetectorUrl, {
  namedExports: {
    detectTaskMasterMCPServer: async () => ({ hasMCPServer: false }),
  },
});
mock.module(tmWebsocketUrl, {
  namedExports: {
    broadcastTaskMasterProjectUpdate: () => {},
    broadcastTaskMasterTasksUpdate: () => {},
  },
});

// Import the router AFTER the mocks are registered.
const { default: taskmasterRouter } = await import('./taskmaster.js');

const app = express();
app.use(express.json());
app.use('/api/taskmaster', taskmasterRouter);

const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * GET the two-param PRD route. `rawFileSegment` is inserted verbatim (already
 * percent-encoded) so `%2f` reaches Express, which decodes it into the :param —
 * exactly the B-133 vector. Do NOT re-encode it here.
 */
async function getPrd(projectId: string, rawFileSegment: string): Promise<Response> {
  return fetch(
    `${baseUrl}/api/taskmaster/prd/${encodeURIComponent(projectId)}/${rawFileSegment}`
  );
}

async function postJson(urlPath: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Encoded traversal for the GET :param route: `%2f` reaches Express and is
// decoded into the param, reproducing the B-133 vector.
const GET_TRAVERSAL = [
  '..%2f..%2fetc%2fpasswd', // → ../../etc/passwd
  '..%2f..%2fx', // → ../../x
  'foo%2f..%2f..%2fbar', // → foo/../../bar
  '%2fetc%2fpasswd', // → /etc/passwd
];

// Traversal payloads carried in a JSON body (literal separators — the POST
// routes read fileName from req.body, so nothing decodes/normalizes them). The
// last entry is the raw percent form, which is also an illegal name.
const BODY_TRAVERSAL = [
  '../../etc/passwd',
  '../../x',
  'foo/../../bar',
  '/etc/passwd',
  '..%2f..%2fetc%2fpasswd',
];

describe('GET /api/taskmaster/prd/:projectId/:fileName — B-133 (arbitrary read)', () => {
  for (const encoded of GET_TRAVERSAL) {
    test(`rejects encoded traversal "${encoded}" with 400`, async () => {
      const res = await getPrd(VALID_ID, encoded);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string; content?: string };
      assert.equal(body.error, 'Invalid filename');
      // The response must never carry file contents (no read happened).
      assert.equal(body.content, undefined);
    });
  }

  test('accepts a valid prd.txt and returns its content (200)', async () => {
    const res = await getPrd(VALID_ID, 'prd.txt');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { fileName?: string; content?: string };
    assert.equal(body.fileName, 'prd.txt');
    assert.equal(body.content, '# Valid PRD\n');
  });
});

describe('POST /api/taskmaster/parse-prd/:projectId — B-140 (arbitrary target)', () => {
  for (const fileName of BODY_TRAVERSAL) {
    test(`rejects fileName "${fileName}" with 400 (before access/spawn)`, async () => {
      const res = await postJson(`/api/taskmaster/parse-prd/${VALID_ID}`, { fileName });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, 'Invalid filename');
    });
  }

  test('lets a valid filename past the guard (404 for a missing file, not 400)', async () => {
    // A legal name that does not exist → 404 from the existence check. Proves the
    // name cleared the 400 guard without triggering a real task-master spawn.
    const res = await postJson(`/api/taskmaster/parse-prd/${VALID_ID}`, {
      fileName: 'does-not-exist.txt',
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'PRD file not found');
  });
});

describe('POST /api/taskmaster/apply-template/:projectId — B-135 (arbitrary write)', () => {
  for (const fileName of BODY_TRAVERSAL) {
    test(`rejects fileName "${fileName}" with 400 (no write)`, async () => {
      const res = await postJson(`/api/taskmaster/apply-template/${VALID_ID}`, {
        templateId: 'web-app',
        fileName,
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, 'Invalid filename');
    });
  }

  test('never writes outside the docs sandbox for a traversal fileName', async () => {
    // Unguarded, path.join(docsDir, '../../PWNED.txt') would land in tmpDir.
    const escapeTarget = path.join(tmpDir, 'PWNED.txt');
    assert.equal(fs.existsSync(escapeTarget), false);
    const res = await postJson(`/api/taskmaster/apply-template/${VALID_ID}`, {
      templateId: 'web-app',
      fileName: '../../PWNED.txt',
    });
    assert.equal(res.status, 400);
    // The decisive assertion: the escape file must not have been created.
    assert.equal(fs.existsSync(escapeTarget), false);
  });

  test('accepts a valid filename and writes inside the docs sandbox (200)', async () => {
    const res = await postJson(`/api/taskmaster/apply-template/${VALID_ID}`, {
      templateId: 'web-app',
      fileName: 'applied.txt',
    });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(docsDir, 'applied.txt')), true);
  });
});
