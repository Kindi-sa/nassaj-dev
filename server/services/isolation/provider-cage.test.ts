/**
 * provider-cage.test.ts — unit + integration coverage for the unified bwrap cage
 * (Phase 1, ultracode workshop 2026-07-14).
 *
 * Unit: the flag gate, the exemption classes (codex + HTTP-hosted vendors), the
 * bwrap argv shape (with per-user rebind), the fail-safe passthrough when no
 * bwrap resolves, and resolveBwrapPath's invariant.
 *
 * Integration (skipped gracefully when bwrap/userns is unavailable): runs a real
 * `buildCagedLaunch` argv through bwrap on an `sh` command that tries to read a
 * fake other-user tree under a temp usersRoot and `ls /run/docker.sock`, and
 * asserts both are blocked while `node` still boots — mirroring the on-disk check.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/services/isolation/provider-cage.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cageEnabled,
  resolveBwrapPath,
  buildCagedLaunch,
  HTTP_HOSTED_PROVIDERS,
  CAGE_EXEMPT_PROVIDERS,
} from './provider-cage.js';

// --- flag helpers -----------------------------------------------------------

const ORIGINAL_FLAG = process.env.NASSAJ_PROVIDER_CAGE;

function setCage(on: boolean): void {
  process.env.NASSAJ_PROVIDER_CAGE = on ? 'true' : 'false';
}

after(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.NASSAJ_PROVIDER_CAGE;
  else process.env.NASSAJ_PROVIDER_CAGE = ORIGINAL_FLAG;
});

// --- argv subsequence helper ------------------------------------------------

/** Index of the first contiguous occurrence of `sub` inside `arr`, or -1. */
function indexOfSubsequence(arr: string[], sub: string[]): number {
  outer: for (let i = 0; i + sub.length <= arr.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (arr[i + j] !== sub[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function assertContainsSeq(arr: string[], sub: string[]): void {
  assert.ok(
    indexOfSubsequence(arr, sub) !== -1,
    `argv must contain the contiguous sequence ${JSON.stringify(sub)}\ngot: ${JSON.stringify(arr)}`,
  );
}

// ---------------------------------------------------------------------------
// cageEnabled — the flag gate + exemption classes
// ---------------------------------------------------------------------------

describe('cageEnabled — flag gate and exemptions', () => {
  const WRAPPED = ['claude', 'gemini', 'agy', 'opencode', 'cursor', 'hermes'];

  it('returns false for every provider when the flag is off', () => {
    setCage(false);
    for (const p of [...WRAPPED, ...CAGE_EXEMPT_PROVIDERS]) {
      assert.equal(cageEnabled(p), false, `${p} must not be caged with flag off`);
    }
  });

  it('returns false when the flag is unset entirely', () => {
    delete process.env.NASSAJ_PROVIDER_CAGE;
    assert.equal(cageEnabled('claude'), false);
  });

  it('catches only in-scope local-CLI providers when the flag is on', () => {
    setCage(true);
    for (const p of WRAPPED) {
      assert.equal(cageEnabled(p), true, `${p} must be caged with flag on`);
    }
  });

  it('exempts codex (self-cages) even with the flag on', () => {
    setCage(true);
    assert.equal(cageEnabled('codex'), false);
  });

  it('exempts the HTTP-hosted vendors (no local process) even with the flag on', () => {
    setCage(true);
    for (const p of HTTP_HOSTED_PROVIDERS) {
      assert.equal(cageEnabled(p), false, `${p} is HTTP-hosted and must not be caged`);
    }
    // and the exemption set is exactly codex + the hosted vendors
    assert.deepEqual(
      [...CAGE_EXEMPT_PROVIDERS].sort(),
      ['codex', ...HTTP_HOSTED_PROVIDERS].sort(),
    );
  });

  it('never cages an empty / whitespace provider', () => {
    setCage(true);
    assert.equal(cageEnabled(''), false);
    assert.equal(cageEnabled('   '), false);
    // @ts-expect-error — defensive against nullish input at the JS boundary
    assert.equal(cageEnabled(undefined), false);
  });

  it('is case-insensitive', () => {
    setCage(true);
    assert.equal(cageEnabled('Claude'), true);
    assert.equal(cageEnabled('CODEX'), false);
    assert.equal(cageEnabled('  Gemini  '), true);
  });
});

// ---------------------------------------------------------------------------
// resolveBwrapPath — invariant
// ---------------------------------------------------------------------------

describe('resolveBwrapPath', () => {
  it('returns null or a real executable file named bwrap', () => {
    const p = resolveBwrapPath();
    assert.ok(
      p === null || (typeof p === 'string' && path.basename(p) === 'bwrap'),
      `expected null or a .../bwrap path, got ${String(p)}`,
    );
    if (p !== null) {
      assert.ok(fs.statSync(p).isFile(), 'resolved bwrap must be a real file');
      assert.doesNotThrow(() => fs.accessSync(p, fs.constants.X_OK), 'must be executable');
    }
  });
});

// ---------------------------------------------------------------------------
// buildCagedLaunch — passthrough vs wrap (argv shape via an injected resolver so
// the UNIT tests do not depend on bwrap being installed).
// ---------------------------------------------------------------------------

describe('buildCagedLaunch — passthrough branches', () => {
  const FAKE = { resolveBwrapPath: () => '/opt/codex/bwrap' };

  it('passes through unchanged when the flag is off', () => {
    setCage(false);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'claude', cmd: 'claude', args: ['chat'], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(out, { cmd: 'claude', args: ['chat'] });
  });

  it('passes through codex (exempt) even with the flag on', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'codex', cmd: 'codex', args: ['exec'], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(out, { cmd: 'codex', args: ['exec'] });
    assert.notEqual(out.cmd, '/opt/codex/bwrap');
  });

  it('passes through an HTTP-hosted vendor (kimi) even with the flag on', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'kimi', cmd: 'kimi', args: [], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(out, { cmd: 'kimi', args: [] });
  });

  it('FAILS SAFE (passthrough) + warns on EVERY spawn when the flag is on but no bwrap resolves', () => {
    setCage(true);
    const warn = mock.method(console, 'warn', () => {});
    const call = () =>
      buildCagedLaunch(
        { userId: '1', provider: 'claude', cmd: 'claude', args: ['chat'], cwd: '/w', usersRoot: '/u' },
        { resolveBwrapPath: () => null },
      );
    const a = call();
    const b = call();
    const c = call();
    // never blocked — always passthrough
    for (const out of [a, b, c]) {
      assert.deepEqual(out, { cmd: 'claude', args: ['chat'] }, 'must run unwrapped, not blocked');
    }
    // NOT deduplicated: a dropped isolation layer must shout on each spawn
    assert.equal(warn.mock.callCount(), 3, 'must warn once PER spawn about the dropped cage');
    warn.mock.restore();
  });
});

describe('buildCagedLaunch — wrapped argv shape', () => {
  const FAKE = { resolveBwrapPath: () => '/opt/codex/bwrap' };
  const usersRoot = '/srv/nassaj-users';
  const cwd = '/home/nassaj/Project/demo';

  it('wraps an in-scope provider in bwrap with the unified flags + per-user rebind', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: ['chat', '--foo'], cwd, usersRoot },
      FAKE,
    );

    // cmd becomes bwrap; the provider command is pushed after the `--` separator.
    assert.equal(out.cmd, '/opt/codex/bwrap');

    // namespace + filesystem flags
    assertContainsSeq(out.args, ['--unshare-user', '--unshare-pid', '--unshare-ipc']);
    assertContainsSeq(out.args, ['--ro-bind', '/', '/']);
    assertContainsSeq(out.args, ['--dev', '/dev']);
    assertContainsSeq(out.args, ['--proc', '/proc']);
    assertContainsSeq(out.args, ['--tmpfs', '/run']);
    assertContainsSeq(out.args, ['--tmpfs', '/tmp']);

    // per-user isolation: hide the whole users root, re-expose only user 77's dir
    const userDir = path.join(usersRoot, '77');
    assertContainsSeq(out.args, ['--tmpfs', usersRoot]);
    assertContainsSeq(out.args, ['--bind', userDir, userDir]);

    // writable cwd
    assertContainsSeq(out.args, ['--bind', cwd, cwd]);

    // the real command sits after the separator, intact
    const dash = out.args.indexOf('--');
    assert.notEqual(dash, -1, 'a `--` separator must precede the wrapped command');
    assert.deepEqual(out.args.slice(dash + 1), ['claude', 'chat', '--foo']);

    // tmpfs-usersRoot must come BEFORE its own-dir rebind (re-expose on top)
    const tmpfsUsersIdx = indexOfSubsequence(out.args, ['--tmpfs', usersRoot]);
    const bindUserIdx = indexOfSubsequence(out.args, ['--bind', userDir, userDir]);
    assert.ok(tmpfsUsersIdx < bindUserIdx, 'must tmpfs usersRoot before rebinding the user dir');
  });

  it('rebinds the correct (distinct) userId per call — no cross-user path', () => {
    setCage(true);
    const a = buildCagedLaunch(
      { userId: '1001', provider: 'gemini', cmd: 'gemini', cwd, usersRoot },
      FAKE,
    );
    const b = buildCagedLaunch(
      { userId: '1002', provider: 'gemini', cmd: 'gemini', cwd, usersRoot },
      FAKE,
    );
    const dirA = path.join(usersRoot, '1001');
    const dirB = path.join(usersRoot, '1002');
    assertContainsSeq(a.args, ['--bind', dirA, dirA]);
    assertContainsSeq(b.args, ['--bind', dirB, dirB]);
    assert.equal(indexOfSubsequence(a.args, ['--bind', dirB, dirB]), -1, 'user A must not see B');
  });

  it('blanks each hidePaths entry with its own --tmpfs (owner-secret hiding)', () => {
    setCage(true);
    const ssh = '/home/nassaj/.ssh';
    const aws = '/home/nassaj/.aws';
    const out = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot, hidePaths: [ssh, aws] },
      FAKE,
    );
    assertContainsSeq(out.args, ['--tmpfs', ssh]);
    assertContainsSeq(out.args, ['--tmpfs', aws]);
  });

  it('orders every hidePaths tmpfs BEFORE the per-user rebind (re-expose on top)', () => {
    setCage(true);
    const ssh = '/home/nassaj/.ssh';
    const out = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot, hidePaths: [ssh] },
      FAKE,
    );
    const hideIdx = indexOfSubsequence(out.args, ['--tmpfs', ssh]);
    const userDir = path.join(usersRoot, '77');
    const bindUserIdx = indexOfSubsequence(out.args, ['--bind', userDir, userDir]);
    assert.ok(hideIdx !== -1 && bindUserIdx !== -1);
    assert.ok(hideIdx < bindUserIdx, 'hidePaths tmpfs must precede the user rebind');
  });

  it('ignores empty entries and adds nothing when hidePaths is omitted', () => {
    setCage(true);
    const withEmpty = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot, hidePaths: ['', undefined as unknown as string] },
      FAKE,
    );
    // no stray --tmpfs '' pair
    assert.equal(indexOfSubsequence(withEmpty.args, ['--tmpfs', '']), -1);

    const omitted = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot },
      FAKE,
    );
    // exactly the three baseline tmpfs mounts (/run, /tmp, usersRoot) — no extras
    const tmpfsCount = omitted.args.filter((a) => a === '--tmpfs').length;
    assert.equal(tmpfsCount, 3, 'baseline is /run + /tmp + usersRoot only when no hidePaths');
  });
});

// ---------------------------------------------------------------------------
// Integration — drive a REAL bwrap sandbox (skipped when unavailable)
// ---------------------------------------------------------------------------

/** bwrap present AND unprivileged userns actually usable in this environment? */
function detectCageUsable(): { usable: boolean; reason: string } {
  const bwrap = resolveBwrapPath();
  if (!bwrap) return { usable: false, reason: 'no bwrap resolved' };
  const probe = spawnSync(bwrap, ['--unshare-user', '--ro-bind', '/', '/', '--', 'true'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    return { usable: false, reason: `userns probe failed (status=${String(probe.status)})` };
  }
  return { usable: true, reason: '' };
}

const cage = detectCageUsable();

describe('buildCagedLaunch — integration against a real bwrap sandbox', () => {
  it(
    'hides another user tree + /run/docker.sock while node boots',
    { skip: cage.usable ? false : `bwrap/userns unavailable: ${cage.reason}` },
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cage-it-'));
      try {
        const usersRoot = path.join(tmp, 'users');
        const ownDir = path.join(usersRoot, '42');
        const otherDir = path.join(usersRoot, '99');
        const otherSecret = path.join(otherDir, 'secret.txt');
        const cwd = path.join(tmp, 'project');
        const cwdFile = path.join(cwd, 'file.txt');

        fs.mkdirSync(ownDir, { recursive: true });
        fs.mkdirSync(otherDir, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        fs.writeFileSync(otherSecret, 'TOPSECRET');
        fs.writeFileSync(cwdFile, 'hi');

        // single-quote wrap (temp paths from mkdtemp carry no quotes/spaces)
        const q = (s: string) => `'${s}'`;
        const script = [
          `if cat ${q(otherSecret)} 2>/dev/null; then echo LEAK_OTHER; else echo BLOCKED_OTHER; fi`,
          `if ls /run/docker.sock 2>/dev/null; then echo LEAK_SOCK; else echo BLOCKED_SOCK; fi`,
          `if [ -d ${q(ownDir)} ]; then echo OWN_OK; else echo OWN_MISSING; fi`,
          `if [ -f ${q(cwdFile)} ]; then echo CWD_OK; else echo CWD_MISSING; fi`,
          `node -e 'process.stdout.write("NODE_OK\\n")' 2>/dev/null || echo NODE_FAIL`,
        ].join('\n');

        setCage(true);
        const launch = buildCagedLaunch({
          userId: '42',
          provider: 'claude', // in-scope local CLI
          cmd: 'sh',
          args: ['-c', script],
          cwd,
          usersRoot,
        });

        // the real cage must actually be applied (not a passthrough)
        assert.equal(launch.cmd, resolveBwrapPath());

        const res = spawnSync(launch.cmd, launch.args, { encoding: 'utf8' });
        const out = `${res.stdout || ''}${res.stderr || ''}`;

        assert.equal(res.status, 0, `sandbox should exit 0, got ${String(res.status)}\n${out}`);
        // other user's tree is hidden, own dir + cwd survive
        assert.match(out, /BLOCKED_OTHER/, 'another user tree must be hidden');
        assert.doesNotMatch(out, /LEAK_OTHER/);
        assert.doesNotMatch(out, /TOPSECRET/, 'the other user secret must never be readable');
        assert.match(out, /OWN_OK/, "the caller's own dir must be re-exposed");
        assert.match(out, /CWD_OK/, 'the writable cwd must be present');
        // host runtime sockets hidden
        assert.match(out, /BLOCKED_SOCK/, '/run/docker.sock must be hidden');
        assert.doesNotMatch(out, /LEAK_SOCK/);
        // the child still boots
        assert.match(out, /NODE_OK/, 'node must still boot inside the cage');
        assert.doesNotMatch(out, /NODE_FAIL/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
