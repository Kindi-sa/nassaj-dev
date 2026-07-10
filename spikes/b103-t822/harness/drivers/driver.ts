/**
 * T-822 shadow driver — runs the SHIPPED Tier-B code (source, via tsx) against a
 * REAL `claude -p --resume` on a REAL transcript. NOT a reimplementation: it wires
 * the exact `injectForConversation` / chat-lock functions the supervisor + the
 * claude-sdk.js seam use. Subcommands:
 *
 *   inject     --conv --project --jsonl --tasks t1,t2 [--outcome SUCCEEDED]
 *              Runs one injectForConversation (real defaultRunResumeTurn). Prints
 *              the ConversationInjectResult as JSON. Honors WORKFLOW_SUPERVISOR_
 *              INJECT_WIDEN_MS (kill-window / lock-hold widen).
 *
 *   live-turn  --conv --project --user [--tag N]
 *              The LIVE chat-turn simulator: mirrors the claude-sdk.js seam EXACTLY
 *              (isChatTurnLockEnabled() && sessionId ? await
 *              acquireChatTurnLockForLiveTurn(...) : null; run the turn; release in
 *              finally). Runs a real `claude -p --resume` under the human's env.
 *              Prints {lockReason, waitedMs, exitCode} JSON.
 *
 * Env: WORKFLOW_SUPERVISOR=1, WORKFLOW_SUPERVISOR_CHAT_LOCK=1, WORKFLOW_SUPERVISOR_
 * STATE_DIR, HOME (temp), WORKFLOW_SUPERVISOR_HANDOFF_MODEL=haiku.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { injectForConversation, type InjectTaskInput } from '@/modules/workflow-supervisor/handoff-injector.js';
import { wrapUntrustedResultForInjection, handoffId } from '@/modules/workflow-supervisor/handoff.js';
import { defaultRunResumeTurn } from '@/modules/workflow-supervisor/resume-turn-runner.js';
import { deliverTierBOnce, type TierBDeps } from '@/modules/workflow-supervisor/tierb-pass.js';
import { systemctlShowState } from '@/modules/workflow-supervisor/systemd.js';
import { acquireChatTurnLockForLiveTurn } from '@/modules/workflow-supervisor/chat-turn-lock.js';
import { isChatTurnLockEnabled, taskArtifactDir, reconcileGraceMs } from '@/modules/workflow-supervisor/config.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { initializeDatabase, sessionsDb, projectsDb } from '@/modules/database/index.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function cmdInject(): Promise<void> {
  const conv = arg('conv');
  const projectPath = arg('project');
  const jsonlPath = arg('jsonl');
  const taskIds = arg('tasks').split(',').filter(Boolean);
  const outcome = (arg('outcome', 'SUCCEEDED') as InjectTaskInput['outcome']);
  const tasks: InjectTaskInput[] = taskIds.map((taskId) => {
    const taskDir = taskArtifactDir(taskId, process.env);
    const rec = readJson(path.join(taskDir, 'task.json')) as { userId?: number } | null;
    const resultObj = readJson(path.join(taskDir, 'result.json')) ?? { note: 'no result' };
    return { taskId, userId: rec?.userId ?? 0, outcome, resultObj, taskDir };
  });
  const r = await injectForConversation(
    { env: process.env, runResumeTurn: defaultRunResumeTurn },
    { conversationId: conv, projectPath, jsonlPath, tasks },
  );
  process.stdout.write(JSON.stringify(r) + '\n');
}

function runClaude(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve({ code: null, out });
    });
  });
}

/** Mirrors the claude-sdk.js seam EXACTLY (acquire → turn → finally release). */
async function cmdLiveTurn(): Promise<void> {
  const conv = arg('conv');
  const projectPath = arg('project');
  const userId = Number.parseInt(arg('user'), 10);
  const tag = arg('tag', '0');
  const sessionId = conv; // the resume target, as in runClaudeSDKQuery(options.sessionId)

  const t0 = Date.now();
  const chatTurnLock =
    isChatTurnLockEnabled() && sessionId
      ? await acquireChatTurnLockForLiveTurn(sessionId, userId)
      : null;
  const waitedMs = Date.now() - t0;

  let code: number | null = null;
  try {
    const env = resolveProviderEnv(userId, 'claude', process.env);
    const bin = process.env.WORKFLOW_SUPERVISOR_CLAUDE_BIN || 'claude';
    const res = await runClaude(
      bin,
      ['-r', conv, '--output-format', 'json', '--model', process.env.WORKFLOW_SUPERVISOR_HANDOFF_MODEL || 'haiku', '-p', `قل فقط: دور بشري ${tag}`],
      projectPath,
      env,
      120000,
    );
    code = res.code;
  } finally {
    if (chatTurnLock) {
      chatTurnLock.release();
    }
  }
  process.stdout.write(
    JSON.stringify({ lockReason: chatTurnLock ? chatTurnLock.reason : 'null', held: !!(chatTurnLock && chatTurnLock.held), waitedMs, code }) + '\n',
  );
}

/** The FULL supervisor Tier-B pass with DB-backed C2 (routing + on-demand +
 * coalescing + real injection) — the exact deliverTierBOnce the supervisor runs. */
async function cmdTierbPass(): Promise<void> {
  // Keep stdout PURE JSON: the DB layer logs migration/schema notices to stdout on
  // init, so redirect console.log to stderr for the init only.
  const realLog = console.log;
  console.log = (...a: unknown[]): void => process.stderr.write(a.join(' ') + '\n');
  try {
    await initializeDatabase();
  } finally {
    console.log = realLog;
  }
  const verifyDeliveryTarget: TierBDeps['verifyDeliveryTarget'] = (conversationId, userId) => {
    try {
      const row = sessionsDb.getSessionById(conversationId);
      if (!row) return { ok: false, reason: 'no session' };
      if (row.provider && row.provider !== 'claude') return { ok: false, reason: 'provider' };
      if (!row.jsonl_path || !row.project_path) return { ok: false, reason: 'missing path' };
      if (!projectsDb.isProjectPathOwnedOrMemberedBy(row.project_path, userId)) {
        return { ok: false, reason: 'not owned' };
      }
      return { ok: true, jsonlPath: row.jsonl_path, projectPath: row.project_path };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };
  const r = await deliverTierBOnce({
    probeUnitState: systemctlShowState,
    verifyDeliveryTarget,
    graceMs: reconcileGraceMs(process.env),
    onAudit: (rec) => process.stderr.write('audit ' + JSON.stringify(rec) + '\n'),
  });
  process.stdout.write(JSON.stringify(r) + '\n');
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'inject') {
    await cmdInject();
  } else if (cmd === 'live-turn') {
    await cmdLiveTurn();
  } else if (cmd === 'tierb-pass') {
    await cmdTierbPass();
  } else if (cmd === 'wrap-probe') {
    // Proves the §هـ-3 size cap on the payload WE build (before send), independent
    // of how the CLI stores the user turn: a >32KB body ⇒ truncated + a marker.
    const bytes = Number.parseInt(arg('bytes', '40000'), 10);
    const wrapped = wrapUntrustedResultForInjection('X'.repeat(bytes), handoffId('probe'));
    process.stdout.write(
      JSON.stringify({ inputBytes: bytes, wrappedBytes: Buffer.byteLength(wrapped), truncated: wrapped.includes('مقصوص') }) + '\n',
    );
  } else if (cmd === 'lock-probe') {
    // Flag-gating probe (criterion 6): reflects isChatTurnLockEnabled + whether a
    // real lock is taken, honoring the ambient WORKFLOW_SUPERVISOR_CHAT_LOCK flag.
    const conv = arg('conv', 'conv-probe');
    const lock = await acquireChatTurnLockForLiveTurn(conv, 1);
    process.stdout.write(JSON.stringify({ enabled: isChatTurnLockEnabled(), reason: lock.reason, held: lock.held }) + '\n');
    lock.release();
  } else {
    process.stderr.write(`unknown driver command: ${String(cmd)}\n`);
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`driver error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
