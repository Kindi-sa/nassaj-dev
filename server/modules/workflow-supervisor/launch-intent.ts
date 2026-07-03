/**
 * Chat → launch-intent bridge (ADR-053 §ج-1, T-53 M-BG-2-CODE step 1).
 *
 * THE ONE INJECTION POINT INTO THE CRITICAL PATH
 * ----------------------------------------------
 * This is the ONLY thing claude-sdk.js writes for the supervisor, and it is
 * called EXCLUSIVELY from AFTER the for-await loop closes (claude-sdk.js:1782-84,
 * beside removeSession) — NEVER inside the loop (:1635-1770), where any write or
 * stall is a 502 risk (the drain incidents). The write is atomic (tmp → rename,
 * the runner-bridge pattern) so the supervisor never reads a half-written intent.
 *
 * NO-OP WHEN THE FLAG IS OFF
 * --------------------------
 * When WORKFLOW_SUPERVISOR is off, `writeLaunchIntent` returns immediately having
 * touched nothing — the master no-op guarantee. It is also a no-op when there is
 * no authenticated user, no project path, or no workflow was even requested this
 * turn (pendingWorkflows === 0): the bridge only records a real, owned, requested
 * launch, and the supervisor re-validates ownership regardless.
 *
 * DEDUP SAFETY BELT — LAYER 2 IS DECOMMISSIONED (B-126, owner decision ب1 2026-07-03)
 * ----------------------------------------------------------------------------------
 * The durable supervisor (ADR-053 Layer 2) is DECOMMISSIONED and MUST NOT be
 * enabled: it cannot deliver structural durability (the launch-intent is injected
 * AFTER the for-await loop, downstream of the very process death it was meant to
 * survive). Only Layer 1 (orphan-workflow VISIBILITY) is kept live. Because the
 * inline workflow runner already executes the workflow in-process this turn
 * (ENABLE_ULTRACODE_WORKFLOWS => CLAUDE_CODE_WORKFLOWS=1), an intent written here
 * would make a mistakenly-enabled supervisor DOUBLE-EXECUTE the same workflow.
 * The `inlineWorkflowsActive` gate below is a fail-safe: when inline execution
 * already ran, we write NOTHING even if the flag is somehow ON. Do NOT re-enable
 * Layer 2; this bridge stays dormant by design.
 *
 * THE SERVER WRITES INTENT ONLY — IT LAUNCHES NOTHING
 * ---------------------------------------------------
 * Per the (ب) architecture decision, nassaj-dev never runs systemd-run. It drops
 * a validated-shape intent; the standalone supervisor owns validation-of-identity
 * and the privileged launch. This keeps the trust boundary out of the server.
 */

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { isSupervisorEnabled, userIntentDir } from './config.js';
import { validateIntent, type LaunchIntent } from './intent.js';

/** Write a file atomically (tmp + rename) — same contract as runner-bridge. */
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, filePath);
}

export type WriteIntentInput = {
  userId: number | null | undefined;
  projectPath: string | null | undefined;
  scriptOrPrompt: string | null | undefined;
  pendingWorkflows: number;
  model?: string | null;
  effort?: string | null;
  env?: NodeJS.ProcessEnv;
  /**
   * B-126 dedup safety belt: true when the inline workflow runner already
   * executed this workflow in-process this turn (ENABLE_ULTRACODE_WORKFLOWS on).
   * When set, the bridge writes nothing so a mistakenly-enabled supervisor can
   * never re-launch and double-execute an already-run workflow.
   */
  inlineWorkflowsActive?: boolean;
};

export type WriteIntentResult =
  | { written: true; wfLaunchId: string; path: string }
  | { written: false; reason: string };

/**
 * Drop a launch intent for the supervisor, IF and only IF the feature is on and
 * this turn actually requested a workflow for an authenticated user against a
 * project path. Returns a discriminated result; NEVER throws into the critical
 * path (all I/O errors are swallowed to a `written:false`).
 *
 * The written blob passes `validateIntent` before it is persisted — so the
 * supervisor never even sees a malformed intent from us; the supervisor's own
 * re-validation is defense-in-depth against a tampered file.
 */
export async function writeLaunchIntent(input: WriteIntentInput): Promise<WriteIntentResult> {
  const env = input.env ?? process.env;

  // Master no-op gate: OFF => touch nothing.
  if (!isSupervisorEnabled(env)) {
    return { written: false, reason: 'flag off' };
  }
  // B-126 dedup safety belt: if the workflow already ran inline this turn, writing
  // an intent would let a mistakenly-enabled supervisor re-launch and DOUBLE-EXECUTE
  // it. Refuse to write before touching disk. (Layer 2 is decommissioned; see header.)
  if (input.inlineWorkflowsActive) {
    return {
      written: false,
      reason: 'B-126: workflow executed inline (async_launched); supervisor re-launch would double-execute',
    };
  }
  // Only record a real, requested workflow launch.
  if (!Number.isInteger(input.pendingWorkflows) || input.pendingWorkflows <= 0) {
    return { written: false, reason: 'no workflow requested this turn' };
  }
  if (!Number.isInteger(input.userId)) {
    return { written: false, reason: 'no authenticated integer userId' };
  }
  if (typeof input.projectPath !== 'string' || input.projectPath.trim().length === 0) {
    return { written: false, reason: 'no project path' };
  }
  if (typeof input.scriptOrPrompt !== 'string' || input.scriptOrPrompt.trim().length === 0) {
    return { written: false, reason: 'no script/prompt' };
  }

  const wfLaunchId = randomUUID();
  const intent: LaunchIntent = {
    wfLaunchId,
    userId: input.userId as number,
    projectPath: input.projectPath,
    scriptOrPrompt: input.scriptOrPrompt,
    model: input.model ?? null,
    effort: input.effort ?? null,
    requestedAt: new Date().toISOString(),
  };

  // Validate our OWN write so a shape bug here never reaches the supervisor.
  const check = validateIntent(intent);
  if (!check.ok) {
    return { written: false, reason: `self-validation failed: ${check.reason}` };
  }

  const filePath = path.join(userIntentDir(intent.userId, env), `${wfLaunchId}.json`);
  try {
    await atomicWriteJson(filePath, intent);
    return { written: true, wfLaunchId, path: filePath };
  } catch (error) {
    // Non-fatal: a failed intent write must never break the chat completion path.
    return {
      written: false,
      reason: `intent write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
