/**
 * Launch-intent schema + strict validator (ADR-053 §ج-1).
 *
 * A launch intent is the ONLY thing the chat path writes; it is web-originated
 * (a user clicked "run a workflow" in the browser) and therefore UNTRUSTED. The
 * supervisor never acts on a field it has not re-validated. This module owns the
 * shape and the syntactic validation; SEMANTIC authorization (does this user own
 * the project?) lives in ownership.ts and is applied by the supervisor AFTER
 * this passes — the two are deliberately separate gates (§ج-3 distinguishes
 * "respect the given var" from "derive/authorize the identity").
 */

/** The launch intent the chat bridge writes atomically to disk. */
export type LaunchIntent = {
  /** Unique launch id (also the scope unit suffix). Must match /^[A-Za-z0-9_-]+$/. */
  wfLaunchId: string;
  /** Authenticated user id from the socket JWT. MUST be a real integer. */
  userId: number;
  /** Absolute project directory the workflow runs in (cwd for `claude -p`). */
  projectPath: string;
  /** The prompt/script text handed to `claude -p`. */
  scriptOrPrompt: string;
  /** Optional model override. */
  model?: string | null;
  /** Optional reasoning-effort override. */
  effort?: string | null;
  /** ISO timestamp the intent was written. */
  requestedAt: string;
};

/** Result of validating an untrusted intent blob. */
export type IntentValidation =
  | { ok: true; intent: LaunchIntent }
  | { ok: false; reason: string };

/** wfLaunchId charset: safe for a filesystem path AND a systemd unit name. */
const WF_LAUNCH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Syntactic validation of an untrusted intent object. Returns a discriminated
 * result — NEVER throws — so the supervisor can log-and-skip a malformed file
 * without crashing its loop.
 *
 * Enforced invariants (all fail-closed):
 *   - `userId` is an INTEGER (a string "123" or "abc" or missing => reject; the
 *     per-user config-dir isolation keys off a real integer id).
 *   - `wfLaunchId` matches the strict charset (no path traversal, no unit-name
 *     injection).
 *   - `projectPath` is a non-empty absolute path.
 *   - `scriptOrPrompt` is a non-empty string.
 * `model`/`effort` are optional strings; anything else is coerced to null.
 */
export function validateIntent(raw: unknown): IntentValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'intent is not an object' };
  }
  const o = raw as Record<string, unknown>;

  // userId MUST be a real integer — not a numeric string. Number.isInteger is
  // the same fail-closed gate the isolation seam and DB predicates use.
  if (!Number.isInteger(o.userId)) {
    return { ok: false, reason: 'userId is not an integer' };
  }
  const userId = o.userId as number;

  if (typeof o.wfLaunchId !== 'string' || !WF_LAUNCH_ID_RE.test(o.wfLaunchId)) {
    return { ok: false, reason: 'wfLaunchId missing or invalid charset' };
  }

  if (
    typeof o.projectPath !== 'string' ||
    o.projectPath.trim().length === 0 ||
    !o.projectPath.startsWith('/')
  ) {
    return { ok: false, reason: 'projectPath missing or not absolute' };
  }

  if (typeof o.scriptOrPrompt !== 'string' || o.scriptOrPrompt.trim().length === 0) {
    return { ok: false, reason: 'scriptOrPrompt missing or empty' };
  }

  const requestedAt =
    typeof o.requestedAt === 'string' && o.requestedAt.trim().length > 0
      ? o.requestedAt
      : new Date(0).toISOString();

  return {
    ok: true,
    intent: {
      wfLaunchId: o.wfLaunchId,
      userId,
      projectPath: o.projectPath,
      scriptOrPrompt: o.scriptOrPrompt,
      model: typeof o.model === 'string' ? o.model : null,
      effort: typeof o.effort === 'string' ? o.effort : null,
      requestedAt,
    },
  };
}
