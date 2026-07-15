/**
 * codex-coordinator-agents.test.ts — T-886. Pure filesystem unit test of the
 * coordinator-delegate TOML generator: no DB, no SDK, no spawn, NO fs mocks (the
 * synthetic-fixtures lesson — every path is a real temp file under a sandboxed $HOME).
 *
 * Proves:
 *  - the read-only delegate roster + root-contract constants;
 *  - normalizeCodexModel yields a BARE id (بلا @) and rejects the unusable;
 *  - buildAgentToml emits name (no @) + description + sandbox_mode="read-only" + the
 *    session model (DROPPING the card's Claude id) + the leaf contract + an
 *    agentDefinitionHash, and returns null for a missing/malformed card;
 *  - materializeCoordinatorAgents writes both delegate TOMLs, is idempotent, rewrites on
 *    card/model drift, and FAILS CLOSED (ok:false, nothing half-written) on a missing
 *    model or a missing delegate card.
 *
 * HOME is sandboxed before importing the module so coordinatorAgentCardPath() (which
 * reads $HOME/.claude/agents/<name>.md) resolves into the temp tree. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-coord-agents-'));
const ORIGINAL_HOME = process.env.HOME;
const sandboxHome = path.join(sandbox, 'home');
const CARDS_DIR = path.join(sandboxHome, '.claude', 'agents');
fs.mkdirSync(CARDS_DIR, { recursive: true });
process.env.HOME = sandboxHome;

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Realistic cards mirroring ~/.claude/agents/*.md frontmatter (incl. the Claude model
// id that MUST be dropped, and a list-valued `triggers:` that must be ignored).
const ARCHITECT_CARD = `---
name: architect
model: claude-opus-4-8
name_ar: المِعمار
description: تصميم المعمارية واتخاذ القرارات التقنية.
role: تصميم المعمارية واتخاذ القرارات التقنية الكبرى
scope: engineering
max_words: 400
triggers:
  - "architecture"
  - "schema"
---

## الدور
يُستدعى عند بدء مشروع جديد.
بوابة الرفض: خارج التخصص → أعد للمنسّق.
`;

const QA_CARD = `---
name: qa-critic
model: claude-opus-4-8
name_ar: الناقد
description: مراجعة نقدية للكود والقرارات بصلاحية فيتو.
role: مراجعة نقدية للكود والقرارات مع صلاحية فيتو
scope: engineering
---

## الدور
الناقد الصارم. يملك صلاحية فيتو.
`;

function seedCards(): void {
  fs.writeFileSync(path.join(CARDS_DIR, 'architect.md'), ARCHITECT_CARD);
  fs.writeFileSync(path.join(CARDS_DIR, 'qa-critic.md'), QA_CARD);
}

const {
  COORDINATOR_AGENT_NAMES,
  CODEX_AGENTS_SUBDIR,
  COORDINATOR_ROOT_CONTRACT,
  normalizeCodexModel,
  coordinatorAgentCardPath,
  buildAgentToml,
  materializeCoordinatorAgents,
} = await import('./codex-coordinator-agents.js');

// Reseed both cards before EACH case so drift/missing/malformed cases stay independent.
beforeEach(seedCards);

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A fresh, NON-existent CODEX_HOME (materialize must create agents/ itself). */
function freshHome(name: string): string {
  const home = path.join(sandbox, name);
  fs.rmSync(home, { recursive: true, force: true });
  return home;
}

describe('codex-coordinator-agents — constants', () => {
  it('roster is the read-only delegates architect + qa-critic', () => {
    assert.deepEqual(COORDINATOR_AGENT_NAMES, ['architect', 'qa-critic']);
    assert.equal(CODEX_AGENTS_SUBDIR, 'agents');
  });

  it('root contract is delegate-only and names agents by bare name (بلا @)', () => {
    assert.match(COORDINATOR_ROOT_CONTRACT, /منسّق نسّاج/);
    assert.match(COORDINATOR_ROOT_CONTRACT, /spawn_agent/);
    assert.match(COORDINATOR_ROOT_CONTRACT, /بلا @/);
  });

  it('root contract enumerates the delegate roster and forbids unconfigured spawns', () => {
    // Roster is derived from COORDINATOR_AGENT_NAMES — every name must appear verbatim
    // (no hand-maintained duplicate list in the contract text).
    for (const name of COORDINATOR_AGENT_NAMES) {
      assert.ok(
        COORDINATOR_ROOT_CONTRACT.includes(name),
        `contract must enumerate the delegate «${name}»`,
      );
    }
    // Directive: delegate ONLY to the roster; an unavailable specialization ⇒ tell the
    // owner, do NOT spawn an unconfigured agent, do NOT self-execute (guards the silent
    // degradation of forking a write agent that has no TOML).
    assert.match(COORDINATOR_ROOT_CONTRACT, /فوّض فقط إلى هؤلاء/);
    assert.match(COORDINATOR_ROOT_CONTRACT, /غير مُهيّأ/);
  });

  it('resolves cards under $HOME/.claude/agents', () => {
    assert.equal(coordinatorAgentCardPath('architect'), path.join(CARDS_DIR, 'architect.md'));
  });
});

describe('normalizeCodexModel — bare id, no @ (Gate 1B)', () => {
  it('passes a bare id through unchanged', () => {
    assert.equal(normalizeCodexModel('gpt-5-codex'), 'gpt-5-codex');
  });

  it('strips a provider@ / @ prefix to the bare id', () => {
    assert.equal(normalizeCodexModel('codex@gpt-5-codex'), 'gpt-5-codex');
    assert.equal(normalizeCodexModel('@gpt-5-codex'), 'gpt-5-codex');
  });

  it('returns null for empty / whitespace / non-string (fail-closed upstream)', () => {
    assert.equal(normalizeCodexModel(''), null);
    assert.equal(normalizeCodexModel('   '), null);
    assert.equal(normalizeCodexModel(null), null);
    assert.equal(normalizeCodexModel(undefined), null);
    assert.equal(normalizeCodexModel(42), null);
  });
});

describe('buildAgentToml — schema, identity, model, leaf, hash, no @', () => {
  it('emits the full delegate TOML and DROPS the card Claude id', () => {
    const built = buildAgentToml('architect', 'gpt-5-codex');
    assert.ok(built, 'must build for a present card');
    const { toml, hash } = built;

    // Identity = card `name`, referenced with NO leading @.
    assert.match(toml, /^name = "architect"$/m);
    assert.equal(toml.includes('@architect'), false, 'no @-prefixed agent name');
    assert.equal(toml.includes('"@'), false, 'no @ opening any TOML string');

    // Model is the passed BARE Codex model; the card's Claude id is DROPPED.
    assert.match(toml, /^model = "gpt-5-codex"$/m);
    assert.equal(toml.includes('claude-opus-4-8'), false, 'Claude model id must not leak into the TOML');

    // read-only child sandbox (aligns with E12 parent inheritance).
    assert.match(toml, /^sandbox_mode = "read-only"$/m);

    // Leaf contract + the card's own refusal gate carried into developer_instructions.
    assert.match(toml, /developer_instructions = """/);
    assert.match(toml, /أنت وكيل leaf: لا تفوّض/);
    assert.match(toml, /أعد النتيجة للمنسّق/);
    assert.match(toml, /بوابة الرفض/);

    // agentDefinitionHash comment present and equal to the returned hash.
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.match(toml, new RegExp(`^# agentDefinitionHash = "${hash}"$`, 'm'));
  });

  it('normalizes an @-prefixed model into the TOML (بلا @)', () => {
    const built = buildAgentToml('qa-critic', 'codex@gpt-5-codex');
    assert.ok(built);
    assert.match(built.toml, /^model = "gpt-5-codex"$/m);
    assert.match(built.toml, /^name = "qa-critic"$/m);
  });

  it('returns null for a missing card', () => {
    assert.equal(buildAgentToml('does-not-exist', 'gpt-5-codex'), null);
  });

  it('returns null for a malformed (no frontmatter) card', () => {
    fs.writeFileSync(path.join(CARDS_DIR, 'architect.md'), 'no frontmatter at all');
    assert.equal(buildAgentToml('architect', 'gpt-5-codex'), null);
  });

  it('returns null when the model is unusable (fail-closed input)', () => {
    assert.equal(buildAgentToml('architect', ''), null);
    assert.equal(buildAgentToml('architect', '   '), null);
  });
});

describe('materializeCoordinatorAgents — fail-closed, idempotent, drift', () => {
  it('writes both delegate TOMLs into <codexHome>/agents and returns ok', () => {
    const home = freshHome('home-ok');
    const res = materializeCoordinatorAgents(home, 'gpt-5-codex');
    assert.equal(res.ok, true);
    assert.deepEqual(res.agents, ['architect', 'qa-critic']);
    assert.equal(res.agentsDir, path.join(home, 'agents'));

    for (const name of ['architect', 'qa-critic']) {
      const p = path.join(home, 'agents', `${name}.toml`);
      assert.equal(fs.existsSync(p), true, `${name}.toml must exist`);
      const toml = fs.readFileSync(p, 'utf8');
      assert.match(toml, new RegExp(`^name = "${name}"$`, 'm'));
      assert.match(toml, /^sandbox_mode = "read-only"$/m);
      assert.match(toml, /^model = "gpt-5-codex"$/m);
      assert.match(toml, /^# agentDefinitionHash = "[0-9a-f]{64}"$/m);
      assert.equal(toml.includes(`@${name}`), false, 'no @-prefixed delegate name');
    }
  });

  it('is idempotent: an unchanged card+model is NOT rewritten', () => {
    const home = freshHome('home-idem');
    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const p = path.join(home, 'agents', 'architect.toml');
    const mtime1 = fs.statSync(p).mtimeMs;

    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const mtime2 = fs.statSync(p).mtimeMs;
    assert.equal(mtime1, mtime2, 'unchanged delegate must not be rewritten (idempotent)');
  });

  it('rewrites on drift when the source card changes', () => {
    const home = freshHome('home-card-drift');
    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const p = path.join(home, 'agents', 'architect.toml');
    const before = fs.readFileSync(p, 'utf8');

    fs.writeFileSync(
      path.join(CARDS_DIR, 'architect.md'),
      ARCHITECT_CARD.replace('يُستدعى عند بدء مشروع جديد.', 'نص محدَّث للبطاقة.'),
    );
    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const after = fs.readFileSync(p, 'utf8');
    assert.notEqual(before, after, 'a changed card must rewrite the delegate TOML');
    assert.match(after, /نص محدَّث للبطاقة\./);
  });

  it('rewrites on drift when the resolved model changes', () => {
    const home = freshHome('home-model-drift');
    materializeCoordinatorAgents(home, 'gpt-5-codex');
    const p = path.join(home, 'agents', 'architect.toml');
    assert.match(fs.readFileSync(p, 'utf8'), /^model = "gpt-5-codex"$/m);

    materializeCoordinatorAgents(home, 'gpt-5.5');
    assert.match(fs.readFileSync(p, 'utf8'), /^model = "gpt-5.5"$/m);
  });

  it('FAIL-CLOSED: refuses (ok:false) when the model is missing — writes nothing', () => {
    const home = freshHome('home-nomodel');
    const res = materializeCoordinatorAgents(home, '');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'model_missing');
    assert.equal(fs.existsSync(path.join(home, 'agents')), false, 'no dir/files created without a model');
  });

  it('FAIL-CLOSED: refuses when a delegate card is missing', () => {
    const home = freshHome('home-nocard');
    fs.rmSync(path.join(CARDS_DIR, 'qa-critic.md'), { force: true });
    const res = materializeCoordinatorAgents(home, 'gpt-5-codex');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'card_unavailable:qa-critic');
    assert.equal(
      fs.existsSync(path.join(home, 'agents', 'qa-critic.toml')),
      false,
      'the missing delegate must not have a TOML',
    );
  });
});
