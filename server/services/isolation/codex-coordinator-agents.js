/**
 * codex-coordinator-agents — materializes the nassaj coordinator's read-only
 * delegate agents (architect, qa-critic) as Codex custom-agent TOMLs into
 * $CODEX_HOME/agents/, so a coordinator-role Codex launch (a read-only parent) can
 * delegate to them via spawn_agent (T-886).
 *
 * This is the clean PRODUCT port of docs/plans/spike-artifacts/gen-codex-agent-toml.cjs
 * (the Gate 1B spike). Differences from the spike:
 *   - reads the SHARED operator agent cards (~/.claude/agents/<name>.md) — the same
 *     operator-home base codex-governance-material uses — so it is fleet-portable and
 *     HOME-sandboxable (real-fs testable, no mocks).
 *   - takes the SESSION-RESOLVED Codex model. Gate 1B proved a custom agent REQUIRES
 *     an explicit `model` and that a Claude model id is invalid for Codex; delegation
 *     fails ("could not resolve the child model") without a real Codex model. The model
 *     is additionally normalized to a bare id (no `provider@`/`@` prefix) — Gate 1B: a
 *     native reference with `@` fails.
 *   - emits an `agentDefinitionHash` over the generating inputs (card bytes + resolved
 *     model + child sandbox + contract-template version) for drift detection and
 *     turn-to-turn idempotence (rewrite only when an input changed).
 *   - returns ok:false (never throws) on a missing/malformed card, a missing model, or a
 *     write failure. The caller (openai-codex.js) treats this FAIL-OPEN as of the
 *     2026-07-15 redirect: it logs loudly and STILL launches — coordination is now a
 *     PERMANENT textual layer, so a transient materialization glitch must not take down
 *     all Codex. (This module used to be consumed fail-closed by an opt-in coordinator
 *     MODE; that mode was removed.)
 *
 * Security posture (R3 honesty — NOT overclaimed): sandbox_mode="read-only" in the child
 * TOML is the delegate's OWN declared sandbox for these read-analysis roles (architect,
 * qa-critic) — "no writes / no network", NOT "no execution": read-exec analysis stays.
 * It is NO LONGER backed by a read-only parent: after the 2026-07-15 redirect the
 * coordinator root follows the session's ACTUAL mode (workspace-write for default/
 * acceptEdits), so there is no OS-enforced read-only floor over the root to "align" with.
 * The delegate-first guarantee is now TEXTUAL (the root contract), mirroring Claude
 * Code's zero-rule; a structural OS guard for the Codex root is a separate future
 * follow-up. The agentDefinitionHash detects INPUT drift (card/model/template changed);
 * it is not a tamper-seal — the agents dir is 0700-isolated per user.
 *
 * No project-internal imports beyond node builtins (mirrors codex-governance-material):
 * safe to import from BOTH the spawn path (openai-codex.js) and provisioning
 * (provision-user-dirs.js) without an import cycle.
 */

'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The delegate roster the coordinator layer may spawn. Deliberately read-analysis roles
 * only for this MVP (D2): each delegate TOML declares its own sandbox_mode="read-only",
 * so these delegates do not write. Write agents (backend-dev …) are OUT of this MVP and
 * ship later once a Codex-native write-delegate story lands.
 */
export const COORDINATOR_AGENT_NAMES = ['architect', 'qa-critic'];

/** Subdir under $CODEX_HOME from which Codex ingests custom-agent TOMLs. */
export const CODEX_AGENTS_SUBDIR = 'agents';

/**
 * The coordinator's ROOT-ONLY contract (D3). Injected into the coordinator's turn
 * input at launch (openai-codex.js) — NEVER into AGENTS.md (T-883 fingerprint) and
 * NEVER inherited by spawned children (they carry their own leaf contract from their
 * TOML). This is the instruction that AUTHORIZES delegation for the root session.
 */
export const COORDINATOR_ROOT_CONTRACT =
  'أنت منسّق نسّاج: فوّض ولا تنفّذ؛ لأي مهمة متخصصة استدعِ الوكيل المطابق بالاسم بلا @ ' +
  'عبر spawn_agent وانتظر wait_agent ثم ادمج؛ لا تنفّذ العمل المتخصص بنفسك. ' +
  `الوكلاء المتاحون للتفويض حصراً هم: ${COORDINATOR_AGENT_NAMES.join('، ')}. ` +
  'فوّض فقط إلى هؤلاء؛ وإن تطلّبت المهمة تخصصاً غير متاح فأبلغ المالك ولا ' +
  'تُفرّخ وكيلاً غير مُهيّأ ولا تنفّذ العمل بنفسك.';

/** Structural error code when a coordinator launch cannot prepare its delegates. */
export const COORDINATOR_AGENTS_MISSING_CODE = 'coordinator_agents_missing';

/** User-facing (Arabic) message for a coordinator launch blocked for lack of delegates. */
export const COORDINATOR_AGENTS_MISSING_MESSAGE =
  'جلسة المنسّق محجوبة: تعذّر تهيئة وكلاء التفويض.';

/**
 * Contract-template version. BUMP this whenever the leaf-contract text below changes
 * so every already-materialized TOML drifts (input-hash mismatch) and is rewritten on
 * the next coordinator spawn.
 */
const CONTRACT_TEMPLATE_VERSION = 'v1';

/**
 * The delegate's OWN declared sandbox, written into every delegate TOML. read-only keeps
 * these read-analysis delegates (architect, qa-critic) from writing/networking. It is the
 * child's self-declaration — NOT a re-application of a read-only parent (the coordinator
 * root now follows the session's actual mode; see module header).
 */
const CHILD_SANDBOX_MODE = 'read-only';

/** Dir mode for the per-user agents dir (matches the 0700 isolation tree). */
const DIR_MODE = 0o700;

/** File mode for a materialized delegate TOML under the shared-uid isolation tree. */
const FILE_MODE = 0o600;

/** The shared operator agent-cards dir: ~/.claude/agents. */
function agentsCardsRoot() {
  return path.join(os.homedir(), '.claude', 'agents');
}

/**
 * Absolute path to a shared operator agent card.
 * @param {string} name agent identity (e.g. 'architect')
 * @returns {string}
 */
export function coordinatorAgentCardPath(name) {
  return path.join(agentsCardsRoot(), `${name}.md`);
}

/** sha256 hex of a string. */
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Human-readable error text from an unknown throw. */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Normalizes a picker/session model to a BARE Codex model id: strips any
 * `provider@`/`@` prefix (Gate 1B — a native reference carrying `@` fails to resolve
 * the child model). A bare id passes through unchanged. Codex/OpenAI model ids never
 * contain `@`, so slicing after the last `@` is safe.
 *
 * @param {unknown} model
 * @returns {string|null} the bare id, or null when unusable (fail-closed upstream)
 */
export function normalizeCodexModel(model) {
  if (typeof model !== 'string') {
    return null;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }
  const bare = trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1).trim() : trimmed;
  return bare || null;
}

/**
 * Parses a nassaj agent card's frontmatter + body. Mirrors the spike parser: only
 * simple `key: value` frontmatter lines are captured; list values (triggers) and
 * comment values are ignored. Returns null when the card is malformed (no frontmatter).
 *
 * @param {string} md raw card markdown
 * @returns {{ fm: Record<string,string>, body: string } | null}
 */
function parseCard(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    return null;
  }
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv && kv[2] && !kv[2].startsWith('#')) {
      fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: m[2].trim() };
}

/**
 * Escapes a string for embedding in a TOML multi-line basic string ("""..."""):
 * backslashes and any literal triple-quote run.
 */
function tomlMultiline(s) {
  return s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

/**
 * Builds the leaf-contract developer_instructions for a delegate: persona + scope +
 * the LEAF contract (do NOT delegate — return to the coordinator) + the card's OWN
 * refusal gates (the full card body). The name is referenced WITHOUT a leading `@`.
 */
function buildDeveloperInstructions(fm, body, identityName) {
  return [
    `أنت وكيل نسّاج المتخصّص «${identityName}» (${fm.name_ar || identityName}).`,
    `نطاقك: ${fm.scope || 'غير محدد'}. حدّك: ${fm.role || fm.description || identityName}.`,
    'أنت وكيل leaf: لا تفوّض ولا تستدعي وكلاء فرعيين؛ نفّذ ضمن تخصّصك فقط ثم أعد النتيجة للمنسّق.',
    'التزم حرفياً ببوابات الرفض في قواعدك أدناه: ارفض أي مهمة خارج نطاق دورك بذكر اسم البوابة المنطبقة.',
    '--- بطاقة الدور الكاملة (حوكمة نسّاج) ---',
    body,
  ].join('\n');
}

/**
 * Builds a Codex custom-agent TOML (schema codex-cli 0.144.1) for `name`, bound to a
 * bare Codex `model`, from the shared operator card at ~/.claude/agents/<name>.md.
 *
 * @param {string} name agent filename/identity (e.g. 'architect')
 * @param {string} model resolved Codex model (already-bare or `@`-prefixed — normalized here)
 * @returns {{ toml: string, hash: string, name: string } | null} null when the card is
 *   missing/malformed or the model is unusable (caller fails closed)
 */
export function buildAgentToml(name, model) {
  const cleanModel = normalizeCodexModel(model);
  if (!cleanModel) {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(coordinatorAgentCardPath(name), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseCard(raw);
  if (!parsed || !parsed.fm.name) {
    return null;
  }
  const { fm, body } = parsed;
  // Identity is the card's `name` field, NOT the filename (spike §10 rule).
  const identityName = fm.name;
  const description = fm.description || fm.role || identityName;
  const developerInstructions = buildDeveloperInstructions(fm, body, identityName);

  // Drift/idempotence fingerprint over the INPUTS that determine the output.
  const hash = sha256(
    [CONTRACT_TEMPLATE_VERSION, cleanModel, CHILD_SANDBOX_MODE, raw].join(' '),
  );

  const lines = [
    '# nassaj coordinator delegate — generated at launch (T-886). Do not hand-edit.',
    `# source card: ~/.claude/agents/${name}.md`,
    `# agentDefinitionHash = "${hash}"`,
    // JSON string escaping is a safe subset of TOML basic-string escaping for these
    // simple ASCII values (matches the spike). Identity name carries NO `@`.
    `name = ${JSON.stringify(identityName)}`,
    `description = ${JSON.stringify(description)}`,
    `sandbox_mode = ${JSON.stringify(CHILD_SANDBOX_MODE)}`,
    `model = ${JSON.stringify(cleanModel)}`,
    'developer_instructions = """',
    tomlMultiline(developerInstructions),
    '"""',
  ];
  return { toml: lines.join('\n') + '\n', hash, name: identityName };
}

/** Reads the embedded agentDefinitionHash from an existing TOML, or null. */
function existingAgentHash(tomlPath) {
  try {
    const content = fs.readFileSync(tomlPath, 'utf8');
    const m = content.match(/^# agentDefinitionHash = "([0-9a-f]{64})"$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Result of a coordinator-agents materialization.
 * @typedef {Object} MaterializeResult
 * @property {boolean} ok               true iff EVERY delegate TOML is present & current
 * @property {string}  agentsDir        the $CODEX_HOME/agents dir targeted
 * @property {string[]} agents          delegate names that ended up materialized/current
 * @property {string}  [reason]         diagnostic reason on failure
 */

/**
 * Materializes ALL coordinator delegate TOMLs into <codexHome>/agents/, bound to the
 * session-resolved `model`. Idempotent: a delegate whose embedded input-hash already
 * matches is left untouched; a missing/drifted one is (re)written. The first unusable
 * model, missing/malformed card, or write failure aborts with ok:false. Never throws.
 * The caller (openai-codex.js) is now FAIL-OPEN: on ok:false it logs and still launches
 * (coordination is a permanent textual layer), so ok:false degrades delegation rather
 * than blocking the whole Codex launch.
 *
 * @param {string} codexHome the effective CODEX_HOME whose agents/ to populate
 * @param {string} model     the session-resolved Codex model (bare or `@`-prefixed)
 * @returns {MaterializeResult}
 */
export function materializeCoordinatorAgents(codexHome, model) {
  const agentsDir = path.join(codexHome, CODEX_AGENTS_SUBDIR);

  if (!normalizeCodexModel(model)) {
    // Gate 1B: a custom agent REQUIRES an explicit Codex model; without it delegation
    // fails. Refuse before writing anything.
    return { ok: false, agentsDir, agents: [], reason: 'model_missing' };
  }

  try {
    fs.mkdirSync(agentsDir, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    console.error('[Codex] coordinator agents dir create FAILED — coordinator BLOCKED', {
      agentsDir,
      error: errMessage(err),
    });
    return { ok: false, agentsDir, agents: [], reason: 'agents_dir_unwritable' };
  }

  const materialized = [];
  for (const name of COORDINATOR_AGENT_NAMES) {
    const built = buildAgentToml(name, model);
    if (!built) {
      // A missing/malformed delegate card ⇒ the coordinator cannot delegate to it.
      return { ok: false, agentsDir, agents: materialized, reason: `card_unavailable:${name}` };
    }
    const tomlPath = path.join(agentsDir, `${name}.toml`);
    if (existingAgentHash(tomlPath) === built.hash) {
      // Same card + model + template already materialized — no rewrite (idempotent).
      materialized.push(name);
      continue;
    }
    try {
      // Remove whatever is there first (stale copy / hostile symlink / wrong type),
      // then write 0600. rmSync removes the directory ENTRY; it does not follow a
      // symlink to write its target.
      fs.rmSync(tomlPath, { force: true });
      fs.writeFileSync(tomlPath, built.toml, { mode: FILE_MODE });
    } catch (err) {
      console.error('[Codex] coordinator delegate write FAILED — coordinator BLOCKED', {
        tomlPath,
        error: errMessage(err),
      });
      return { ok: false, agentsDir, agents: materialized, reason: `write_failed:${name}` };
    }
    materialized.push(name);
  }

  return { ok: true, agentsDir, agents: materialized };
}
