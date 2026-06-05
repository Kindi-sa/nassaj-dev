/**
 * Tests for the branding logo upload hardening (server/routes/settings.js).
 *
 * Security-focused coverage:
 *  1. Magic-byte unit check (detectImageExt) — the single source of truth for
 *     "what kind of image is this". Verifies real PNG/JPEG/WEBP signatures are
 *     accepted and that spoofed / SVG / truncated content is rejected (null).
 *  2. POST /api/settings/branding/logo end-to-end:
 *     - a file declared image/png whose bytes are NOT a real PNG -> 400.
 *     - an SVG (no longer supported, XML/script vector) -> 400.
 *     - a payload exceeding the 2MB limit -> 413.
 *
 * Framework: node:test (built-in) + node:assert/strict, run via tsx — matching
 * the existing server test suite. The database index is isolated with node:test
 * module mocking (requires --experimental-test-module-mocks) because settings.js
 * imports several db singletons at module load; we stub appConfigDb so the upload
 * path never touches the real key/value store.
 *
 * The route's owner check (requireRole('owner')) reads req.user.role, so the test
 * harness injects a verified owner user via a stand-in middleware. None of the
 * asserted cases reach the disk-write branch (all are rejected before it), so the
 * test performs no filesystem side effects.
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

// In-memory stand-in for app_config so the route never touches the real store.
const appConfigStore = new Map<string, string>();

const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../modules/database/index.js')
).href;

// Register mocks ONCE. node:test forbids re-mocking the same specifier.
// We provide every named export settings.js destructures from the db index so
// the module loads; only appConfigDb is exercised by these tests.
mock.module(dbIndexUrl, {
  namedExports: {
    // The only repository these tests exercise. Backed by the in-memory map so
    // the upload path never touches the real key/value store.
    appConfigDb: {
      get: (key: string) => appConfigStore.get(key) ?? null,
      set: (key: string, value: string) => {
        appConfigStore.set(key, value);
      },
    },
    // Remaining named exports are stubbed only so settings.js and its transitive
    // imports (auth middleware, notification orchestrator, vapid keys) load.
    initializeDatabase: () => {},
    closeConnection: () => {},
    getConnection: () => ({}),
    getDatabasePath: () => ':memory:',
    apiKeysDb: {},
    auditLogDb: {},
    invitesDb: {},
    credentialsDb: {},
    githubTokensDb: {},
    notificationPreferencesDb: {},
    participantsDb: {},
    projectsDb: {},
    sessionAgentsDb: {},
    pushSubscriptionsDb: {},
    scanStateDb: {},
    sessionsDb: {},
    userDb: {},
    vapidKeysDb: {},
  },
});

// Import the router and the magic-byte helper once, after mocks are registered.
const settingsModule = await import('../settings.js');
const settingsRouter = settingsModule.default;
const detectImageExt = settingsModule.detectImageExt as (
  buffer: Buffer | null
) => string | null;

// ---------------------------------------------------------------------------
// Real binary signatures used to build valid/invalid fixtures.
// ---------------------------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function pngFixture(extraBytes = 32): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(extraBytes, 0)]);
}
function jpegFixture(extraBytes = 32): Buffer {
  return Buffer.concat([JPEG_MAGIC, Buffer.alloc(extraBytes, 0)]);
}
function webpFixture(extraBytes = 16): Buffer {
  // "RIFF" <4 size bytes> "WEBP" ...
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(extraBytes, 0),
  ]);
}
const SVG_FIXTURE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'utf8'
);

// ---------------------------------------------------------------------------
// 1. Unit tests for the magic-byte detector.
// ---------------------------------------------------------------------------
test('detectImageExt accepts a real PNG signature', () => {
  assert.equal(detectImageExt(pngFixture()), 'png');
});

test('detectImageExt accepts a real JPEG signature', () => {
  assert.equal(detectImageExt(jpegFixture()), 'jpg');
});

test('detectImageExt accepts a real WEBP signature', () => {
  assert.equal(detectImageExt(webpFixture()), 'webp');
});

test('detectImageExt rejects SVG (no longer supported)', () => {
  assert.equal(detectImageExt(SVG_FIXTURE), null);
});

test('detectImageExt rejects content with a spoofed/incorrect signature', () => {
  // Bytes that are not any allowed image format.
  const bogus = Buffer.from('this is definitely not an image at all', 'utf8');
  assert.equal(detectImageExt(bogus), null);
});

test('detectImageExt rejects a buffer too short to contain a signature', () => {
  assert.equal(detectImageExt(Buffer.from([0x89, 0x50])), null);
  assert.equal(detectImageExt(Buffer.alloc(0)), null);
  assert.equal(detectImageExt(null), null);
});

test('detectImageExt rejects RIFF that is not WEBP (e.g. WAV/AVI)', () => {
  const riffWave = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WAVE', 'ascii'),
    Buffer.alloc(16, 0),
  ]);
  assert.equal(detectImageExt(riffWave), null);
});

// ---------------------------------------------------------------------------
// 2. End-to-end route tests.
// ---------------------------------------------------------------------------
async function buildServer() {
  appConfigStore.clear();

  const app = express();
  // Stand-in for authenticateToken: inject a verified owner so requireRole
  // ('owner') passes and the upload handler runs.
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = {
      id: 1,
      username: 'owner',
      role: 'owner',
    };
    next();
  });
  app.use('/api/settings', settingsRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const uploadLogo = async (filename: string, contentType: string, body: Buffer) => {
    const boundary = '----nassajtestboundary' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="logo"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payload = Buffer.concat([head, body, tail]);

    const res = await fetch(`http://127.0.0.1:${port}/api/settings/branding/logo`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(payload.length),
      },
      body: payload,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { _raw: text };
    }
    return { status: res.status, body: json };
  };

  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));

  return { uploadLogo, close };
}

test('POST branding/logo rejects a file declaring image/png whose bytes are not a real PNG (400)', async () => {
  const srv = await buildServer();
  try {
    const fakePng = Buffer.from('GIF89a-not-really-a-png', 'utf8');
    const { status } = await srv.uploadLogo('logo.png', 'image/png', fakePng);
    assert.equal(status, 400);
  } finally {
    await srv.close();
  }
});

test('POST branding/logo rejects an SVG upload (400)', async () => {
  const srv = await buildServer();
  try {
    // Declared as image/png so it survives the lenient multer fileFilter; the
    // magic-byte check must still reject it because the bytes are SVG/XML.
    const { status } = await srv.uploadLogo('logo.png', 'image/png', SVG_FIXTURE);
    assert.equal(status, 400);
  } finally {
    await srv.close();
  }
});

test('POST branding/logo rejects a payload exceeding the 2MB limit (413)', async () => {
  const srv = await buildServer();
  try {
    // Valid PNG header but > 2MB total: rejected by the multer size limit before
    // any content inspection.
    const tooBig = Buffer.concat([PNG_MAGIC, Buffer.alloc(2 * 1024 * 1024 + 1024, 0)]);
    const { status } = await srv.uploadLogo('logo.png', 'image/png', tooBig);
    assert.equal(status, 413);
  } finally {
    await srv.close();
  }
});
