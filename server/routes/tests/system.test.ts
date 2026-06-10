/**
 * Tests for GET /api/system/stats (server/routes/system.js).
 *
 * Pure-helper coverage (parseCpuLine / parseMeminfo / cpuPercentFromSamples)
 * plus one integration pass mounting the real router on express — the route
 * reads the live /proc of the test host, so we assert shape and ranges, not
 * exact values.
 *
 * Framework: node:test + node:assert/strict via tsx, matching the suite.
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import systemRouter, {
  cpuPercentFromSamples,
  parseCpuLine,
  parseMeminfo,
} from '../system.js';

test('parseCpuLine extracts idle (incl. iowait) and total jiffies', () => {
  const text = 'cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\n';
  const parsed = parseCpuLine(text);
  assert.ok(parsed);
  assert.equal(parsed.idle, 850); // idle 800 + iowait 50
  assert.equal(parsed.total, 1000);
});

test('parseCpuLine returns null on garbage input', () => {
  assert.equal(parseCpuLine('not a proc stat file'), null);
  assert.equal(parseCpuLine('cpu  abc def\n'), null);
});

test('parseMeminfo extracts MemTotal/MemAvailable in bytes', () => {
  const text = 'MemTotal:       10485760 kB\nMemFree:         1024 kB\nMemAvailable:    5242880 kB\n';
  const parsed = parseMeminfo(text);
  assert.ok(parsed);
  assert.equal(parsed.totalBytes, 10485760 * 1024);
  assert.equal(parsed.availableBytes, 5242880 * 1024);
});

test('parseMeminfo returns null when MemAvailable is missing', () => {
  assert.equal(parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\n'), null);
});

test('cpuPercentFromSamples computes busy ratio and clamps', () => {
  // 1000 jiffies elapsed, 600 of them idle → 40% busy.
  assert.equal(
    cpuPercentFromSamples({ idle: 0, total: 0 }, { idle: 600, total: 1000 }),
    40
  );
  // No elapsed time → null (caller reuses previous value).
  assert.equal(cpuPercentFromSamples({ idle: 5, total: 10 }, { idle: 5, total: 10 }), null);
});

test('GET /stats returns the documented contract with sane ranges', async () => {
  const app = express();
  app.use('/api/system', systemRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/system/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      cpu: { percent: number };
      memory: { usedBytes: number; totalBytes: number; percent: number };
    };

    assert.equal(typeof body.cpu.percent, 'number');
    assert.ok(body.cpu.percent >= 0 && body.cpu.percent <= 100);

    assert.equal(typeof body.memory.usedBytes, 'number');
    assert.equal(typeof body.memory.totalBytes, 'number');
    assert.equal(typeof body.memory.percent, 'number');
    assert.ok(body.memory.totalBytes > 0);
    assert.ok(body.memory.usedBytes >= 0 && body.memory.usedBytes <= body.memory.totalBytes);
    assert.ok(body.memory.percent >= 0 && body.memory.percent <= 100);
  } finally {
    server.close();
  }
});
