/**
 * Workflow process liveness (ADR-053, T-53-B1 — visibility layer for B-103).
 *
 * WHY THIS EXISTS
 * ---------------
 * A background `Workflow` run executes ENTIRELY inside the child CLI process the
 * Agent SDK spawns via query(); nassaj owns no PID for it and cannot keep it
 * alive (ADR-021 — the SDK owns the process). When the coordinator process exits
 * (B-103: an ssh terminal `claude` session, killed on disconnect) the whole
 * process tree — including the workflow's grandchildren — dies, and the work is
 * lost SILENTLY: the existing reconcile only fires when a `run.stopped`
 * task-notification exists (restart incident wf_ef5ba242 only), never for B-103
 * (ح-1). This module is the ONLY source that can see a B-103 orphan: it derives
 * liveness from the CHILD PID itself, decoupled from the coordinator lifecycle.
 *
 * WHY THE CHILD PID (not the session registry)
 * --------------------------------------------
 * `SESSION_REGISTRY_claude` is enabled but its active flag drops the instant the
 * coordinator's for-await ends (claude-sdk.js:1792), and `activeSessions` is
 * deleted in the same window (removeSession:849). Neither survives to witness a
 * still-running workflow, so neither can be the liveness source. The decisive
 * signal is the direct child CLI PID (the ROOT of the workflow's process tree):
 * while that PID is alive the workflow tree is alive; once /proc proves it gone,
 * only then may the journal decide completed-vs-orphan. Hence this registry is
 * INDEPENDENT of the presence-coupled `runs` map in session-process-monitor.js
 * and is NOT torn down by removeSession — it self-prunes when the PID dies.
 *
 * PID + QUIET ARE COMPLEMENTARY, NOT ALTERNATIVES (م-3, the 6th mandatory rule)
 * ---------------------------------------------------------------------------
 *   - PID alive                        => RUNNING (authoritative "still going").
 *   - PID dead + journal NOT quiet     => RUNNING (conservative): a grandchild
 *     orphan may still be flushing its journal after the root died (the restart
 *     shape). Declaring COMPLETED here would announce completion prematurely.
 *   - PID dead + journal quiet + all started keys resulted => COMPLETED.
 *   - PID dead + journal quiet + output landed but a started key is unmatched,
 *     or nothing landed => ORPHAN (visible "died", user resumes manually).
 * PID decides "alive"; quiet+keys decide "finished cleanly" vs "died mid-flight".
 *
 * Linux-only by design (/proc). On a platform without /proc, `isPidAlive` falls
 * back to `process.kill(pid, 0)` alone (cannot detect a zombie), which is the
 * safe direction: it can only ever report a reaped-but-listed pid as alive =>
 * RUNNING (conservative), never a false COMPLETED. nassaj runs on Debian.
 *
 * Read-only and fail-safe end to end: every probe swallows its errors and, on
 * ambiguity, biases toward "alive"/"running" so a workflow is never falsely
 * declared finished. Never throws into a caller.
 */

import fs from 'node:fs';

/**
 * Terminal/liveness verdict for one workflow.
 * - 'RUNNING'   — process alive, OR process gone but the journal is still being
 *                 written (not quiet): treat as in-flight (conservative).
 * - 'COMPLETED' — process gone, journal quiet, every started key has a result.
 * - 'ORPHAN'    — process gone, journal quiet, but work did not complete cleanly
 *                 (a started key never resulted, or no result ever landed): the
 *                 workflow died. Surfaced to the user as a visible orphan.
 *
 * @typedef {'RUNNING' | 'COMPLETED' | 'ORPHAN'} WorkflowLiveness
 */

/** sessionId → resolved child CLI pid (root of the workflow process tree). */
const workflowPids = new Map();

/**
 * Zombie/dead process states in `/proc/<pid>/stat` (field after the last `)`):
 * `Z` = zombie (reaped-but-listed), `X`/`x` = dead. A pid in either state is NOT
 * a live workflow root even though `kill(pid, 0)` may still succeed on a zombie.
 */
const DEAD_PROC_STATES = new Set(['Z', 'X', 'x']);

/**
 * Reads the process state char from `/proc/<pid>/stat`, or null when unreadable
 * or absent. Mirrors session-process-monitor.js's parser: field 2 (comm) is
 * parenthesised and may contain ')'/spaces, so the state is the first token
 * AFTER the last ')'. Never throws.
 *
 * @param {number} pid
 * @returns {string | null}
 */
function readProcState(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close === -1) return null;
    const rest = raw.slice(close + 1).trim().split(/\s+/);
    if (rest.length < 1 || !rest[0]) return null;
    return rest[0];
  } catch {
    return null;
  }
}

/**
 * True when `pid` denotes a live workflow root process.
 *
 * Two independent gates, both fail-safe toward "alive":
 *   1. `process.kill(pid, 0)` — the portable existence probe. Throws ESRCH when
 *      the pid does not exist (=> dead); EPERM means it exists but is owned by
 *      another uid (=> alive, we simply cannot signal it). Any other error is
 *      treated as "cannot prove dead" => alive (conservative).
 *   2. `/proc/<pid>/stat` state — when readable, a `Z`/`X` state means the
 *      process was reaped/died, so it is NOT a live root even though (1) may
 *      still pass on a zombie. When /proc is unreadable/absent (non-Linux, or a
 *      pid owned by another uid), gate (2) is skipped and (1) alone decides.
 *
 * @param {number | null | undefined} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  let existsBySignal;
  try {
    process.kill(pid, 0);
    existsBySignal = true; // Signalable => exists and we own it.
  } catch (err) {
    if (err && err.code === 'ESRCH') {
      return false; // No such process => definitively dead.
    }
    // EPERM (exists, other uid) or anything else: cannot prove dead => alive.
    existsBySignal = true;
  }

  if (!existsBySignal) {
    return false;
  }

  // /proc refinement: a zombie/dead state is "not a live workflow root". Absent
  // /proc (non-Linux) or unreadable stat leaves the signal verdict (alive).
  const state = readProcState(pid);
  if (state !== null && DEAD_PROC_STATES.has(state)) {
    return false;
  }

  return true;
}

/**
 * Records the resolved child CLI pid for a session's workflow root. Called from
 * the run path once the pid is known. Idempotent; a falsy/invalid pid is
 * ignored. This registry is deliberately NOT cleared by removeSession — see the
 * module header — so a workflow whose coordinator turn already ended can still
 * be probed for liveness.
 *
 * @param {string} sessionId
 * @param {number} pid
 */
export function registerWorkflowPid(sessionId, pid) {
  if (!sessionId || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  workflowPids.set(sessionId, pid);
}

/**
 * Returns the recorded workflow pid for a session, or null. Self-prunes: if the
 * recorded pid is no longer alive, the mapping is dropped so the registry does
 * not grow without bound across the process's life. A dropped-but-dead pid still
 * returns its value ONCE via `isWorkflowProcessAlive` semantics through the
 * caller — here we only report the current mapping.
 *
 * @param {string} sessionId
 * @returns {number | null}
 */
export function resolveWorkflowPid(sessionId) {
  const pid = workflowPids.get(sessionId);
  return typeof pid === 'number' ? pid : null;
}

/**
 * Liveness of a session's workflow root by sessionId: looks up the recorded pid
 * and probes it. When the pid is dead the mapping is pruned (bounded registry).
 * Returns false when no pid was ever recorded for the session (unknown =>
 * cannot claim alive) — callers combine this with the journal-quiet check to
 * decide COMPLETED vs ORPHAN via {@link classifyWorkflowLiveness}.
 *
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isWorkflowProcessAlive(sessionId) {
  const pid = resolveWorkflowPid(sessionId);
  if (pid === null) {
    return false;
  }
  if (isPidAlive(pid)) {
    return true;
  }
  // Dead: prune so the map stays bounded. Safe — a resumed run re-registers.
  workflowPids.delete(sessionId);
  return false;
}

/**
 * Drops a session's recorded workflow pid. NOT called from removeSession (the
 * whole point is survival past turn-end); provided for explicit teardown/tests.
 *
 * @param {string} sessionId
 */
export function forgetWorkflowPid(sessionId) {
  workflowPids.delete(sessionId);
}

/** Current number of tracked workflow pids (diagnostics/tests). */
export function trackedWorkflowPidCount() {
  return workflowPids.size;
}

/**
 * Pure liveness classifier (م-3). No I/O; never throws. Combines the PID verdict
 * with the journal's key sets and freshness to produce the terminal state.
 *
 * @param {Object} input
 * @param {boolean} input.pidAlive        Result of the child-pid liveness probe.
 * @param {number}  input.startedKeyCount Unique `started` keys in the journal.
 * @param {number}  input.resultKeyCount  Unique `result` keys in the journal.
 * @param {boolean} input.allStartedResulted True iff every started key has a
 *   result (startedKeys ⊆ resultKeys). Precomputed by the caller from the SAME
 *   key sets `readJournalKeySets` returns so the semantics match reconcile.
 * @param {number}  input.journalMtimeMs  Journal mtime (epoch ms), or 0 when the
 *   journal is missing.
 * @param {number}  input.now             Reference epoch ms.
 * @param {number}  input.quietMs         Quiet window (defaults to the shared
 *   DEFAULT_QUIET_MS at the call site).
 * @returns {WorkflowLiveness}
 */
export function classifyWorkflowLiveness(input) {
  const {
    pidAlive,
    startedKeyCount,
    resultKeyCount,
    allStartedResulted,
    journalMtimeMs,
    now,
    quietMs,
  } = input;

  // 1) PID alive is authoritative: the workflow tree is still up.
  if (pidAlive) {
    return 'RUNNING';
  }

  // 2) PID dead but the journal is NOT quiet: a grandchild orphan may still be
  // flushing after the root died (the restart shape). Conservative RUNNING so
  // completion is never announced prematurely (م-3). A missing journal
  // (mtime 0) is treated as quiet — there is nothing being written.
  const hasJournal = Number.isFinite(journalMtimeMs) && journalMtimeMs > 0;
  if (hasJournal) {
    const idleFor = now - journalMtimeMs;
    if (!(idleFor >= quietMs)) {
      return 'RUNNING';
    }
  }

  // 3) PID dead AND journal quiet: the journal now decides finished-vs-died.
  //    - every started key resulted (and at least one started) => COMPLETED.
  //    - otherwise (a started key never resulted, or no result at all) => ORPHAN.
  if (startedKeyCount >= 1 && resultKeyCount >= 1 && allStartedResulted) {
    return 'COMPLETED';
  }

  return 'ORPHAN';
}
