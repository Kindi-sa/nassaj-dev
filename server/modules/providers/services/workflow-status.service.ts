/**
 * App-level workflow status (ADR-053, T-53-B3 — the B-103 visibility endpoint).
 *
 * WHAT IT ANSWERS
 * ---------------
 * "Which of MY background workflows are still running, and which have been
 * orphaned?" — across all sessions the authenticated caller owns/participates
 * in. This is the ONLY surface that can reveal a B-103 orphan (a workflow whose
 * coordinator process — an ssh `claude` terminal — exited): the existing
 * reconcile fires only when a `run.stopped` notification exists (restart
 * incident only, ح-1), so the whole burden of B-103 visibility is here + the
 * liveness classifier.
 *
 * FAIL-CLOSED OWNERSHIP (never leak an unowned session)
 * -----------------------------------------------------
 *   - `userId = null` (anonymous/unresolved) => [] immediately. No scan.
 *   - Only sessions returned by `participantsDb.getSessionIdsForUser(userId)` are
 *     ever inspected; an unowned session's id/path/workflow never enters the
 *     result set because it never enters the scan. There is no code path that
 *     lists workflows outside the caller's own sessions.
 *
 * DECLARED SCAN CAP (distinguish "not scanned" from "no workflow")
 * ---------------------------------------------------------------
 * Scanning every owned session's `subagents/workflows/` directory is unbounded
 * disk I/O, so the number of sessions inspected per call is capped
 * (`MAX_SESSIONS_SCANNED`, newest-first by the DB's ordering). The response
 * carries `scanned`, `eligible`, and `capped` so a caller can tell "we scanned
 * all your sessions and found no active workflow" from "we hit the cap and did
 * NOT scan everything" — the cap never silently swallows an orphan; it is
 * declared. RUNNING/ORPHAN only are returned (a COMPLETED workflow is not
 * "active"), so the payload is small.
 *
 * READ-ONLY / FAIL-SAFE
 * ---------------------
 * Pure disk reads through the same journal parser as reconcile
 * (`readJournalKeySets`) and the pid liveness registry (`isWorkflowProcessAlive`
 * / `classifyWorkflowLiveness`). Any per-session/per-workflow anomaly (missing
 * dir, unreadable journal, failed stat) degrades that item to "skipped", never
 * throws, and never blocks the rest of the scan. Touches nothing on the
 * critical/query()/drain path.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { participantsDb, sessionsDb } from '@/modules/database/index.js';
import {
  DEFAULT_QUIET_MS,
  readJournalKeySets,
} from '@/modules/providers/list/claude/workflow-reconcile.service.js';
// JS module (allowJs): the workflow pid-liveness registry is a cross-cutting
// service outside the modules tree, shared with session-process-monitor.js. Same
// blessed seam as participants.service.ts → transcript-parser.js.
// eslint-disable-next-line boundaries/no-unknown
import { classifyWorkflowLiveness, isWorkflowProcessAlive } from '@/services/workflow-liveness.js';

/**
 * Upper bound on how many of the caller's sessions are scanned per request. A
 * generous but finite cap: enough to cover an active user's live sessions while
 * bounding worst-case disk walks. When the caller owns more, `capped` is true so
 * the "no active workflow" answer is never mistaken for "did not look".
 */
const MAX_SESSIONS_SCANNED = 200;

/** Only RUNNING and ORPHAN are "active" for the endpoint; COMPLETED is dropped. */
export type ActiveWorkflowStatus = 'running' | 'orphan';

/** One active (running or orphaned) workflow owned by the caller. */
export type ActiveWorkflow = {
  sessionId: string;
  wfId: string;
  status: ActiveWorkflowStatus;
  /** Unique result keys observed so far (progress numerator). */
  agentsDone: number;
  /** Unique started keys (progress denominator; >= agentsDone). */
  agentsTotal: number;
  /** Journal mtime (ISO), or null when the journal was unreadable. */
  updatedAt: string | null;
};

/**
 * Envelope for the active-workflow query. `workflows` is the running/orphan set;
 * the counters make the declared scan cap observable to the caller.
 */
export type ActiveWorkflowsResult = {
  workflows: ActiveWorkflow[];
  /** Distinct sessions the caller owns (before the cap). */
  eligible: number;
  /** Sessions actually inspected this call (<= eligible, <= cap). */
  scanned: number;
  /** True when eligible > scanned: NOT every owned session was scanned. */
  capped: boolean;
};

/**
 * Resolves a session's on-disk `subagents/workflows` directory from its
 * transcript path, using the exact derivation getSessionMessages uses:
 * `<projectDir>/<transcriptSessionId>/subagents/workflows`. Returns null when
 * the session has no transcript path on record.
 */
function resolveWorkflowsDir(jsonlPath: string | null): string | null {
  if (!jsonlPath) {
    return null;
  }
  const projectDir = path.dirname(jsonlPath);
  const transcriptSessionId = path.basename(jsonlPath, '.jsonl');
  return path.join(projectDir, transcriptSessionId, 'subagents', 'workflows');
}

/**
 * Classifies every `wf_*` workflow under one session directory and returns only
 * the RUNNING/ORPHAN ones. Liveness comes from the child pid (shared registry)
 * combined with the journal's key sets + quiet window (م-3). Per-workflow
 * fail-safe: an unreadable journal/stat drops that workflow, never the session.
 */
async function scanSessionWorkflows(
  sessionId: string,
  workflowsDir: string,
  now: number,
  quietMs: number,
): Promise<ActiveWorkflow[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(workflowsDir);
  } catch {
    // No workflows dir (the common case) or an unreadable one => nothing active.
    return [];
  }

  // One liveness probe per session: the child pid is the ROOT of the whole
  // workflow process tree, so its state applies to every wf_* under the session.
  const pidAlive = isWorkflowProcessAlive(sessionId);
  const active: ActiveWorkflow[] = [];

  for (const entry of entries) {
    if (!entry.startsWith('wf_')) {
      continue;
    }

    const journalPath = path.join(workflowsDir, entry, 'journal.jsonl');

    let journalMtimeMs = 0;
    try {
      const journalStat: Stats = await fsp.stat(journalPath);
      journalMtimeMs = journalStat.mtimeMs;
    } catch {
      // No journal yet for this workflow folder. mtime 0 => classifier treats it
      // as "quiet" (nothing being written); with a dead pid + no keys => ORPHAN,
      // with a live pid => RUNNING. Either way it is surfaced, not swallowed.
      journalMtimeMs = 0;
    }

    const { startedKeys, resultKeys } = await readJournalKeySets(journalPath);
    let allStartedResulted = startedKeys.size >= 1;
    for (const key of startedKeys) {
      if (!resultKeys.has(key)) {
        allStartedResulted = false;
        break;
      }
    }

    const liveness = classifyWorkflowLiveness({
      pidAlive,
      startedKeyCount: startedKeys.size,
      resultKeyCount: resultKeys.size,
      allStartedResulted,
      journalMtimeMs,
      now,
      quietMs,
    });

    if (liveness === 'COMPLETED') {
      continue; // Not "active" — a completed workflow is out of scope here.
    }

    active.push({
      sessionId,
      wfId: entry,
      status: liveness === 'RUNNING' ? 'running' : 'orphan',
      agentsDone: resultKeys.size,
      agentsTotal: Math.max(startedKeys.size, resultKeys.size),
      updatedAt: journalMtimeMs > 0 ? new Date(journalMtimeMs).toISOString() : null,
    });
  }

  return active;
}

export const workflowStatusService = {
  /**
   * Returns the caller's running/orphaned workflows across the sessions they
   * own, with the declared scan cap surfaced in the envelope.
   *
   * Fail-closed: a null/unresolved `userId` yields an empty envelope with no
   * scan. Read-only and fail-safe: any anomaly degrades the affected item, never
   * the whole call, and never throws.
   *
   * @param userId  Authenticated numeric user id, or null when unresolved.
   * @param options Test seams: `now` (reference epoch ms) and `quietMs`.
   */
  async getActiveWorkflows(
    userId: number | null,
    options: { now?: number; quietMs?: number } = {},
  ): Promise<ActiveWorkflowsResult> {
    const empty: ActiveWorkflowsResult = { workflows: [], eligible: 0, scanned: 0, capped: false };

    // Fail-closed: no usable identity => reveal nothing, do not scan.
    if (!Number.isInteger(userId)) {
      return empty;
    }

    const now = options.now ?? Date.now();
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;

    try {
      const ownedSessionIds = participantsDb.getSessionIdsForUser(userId as number);
      const eligible = ownedSessionIds.length;
      if (eligible === 0) {
        return empty;
      }

      // Declared cap: inspect at most MAX_SESSIONS_SCANNED sessions. `capped`
      // tells the caller whether the "no active workflow" answer is complete.
      const toScan = ownedSessionIds.slice(0, MAX_SESSIONS_SCANNED);
      const capped = eligible > toScan.length;

      // Batched transcript-path lookup (no N+1) for exactly the capped id set.
      const pathRows = sessionsDb.getSessionFilePathsByIds(toScan);
      const pathBySession = new Map<string, string>();
      for (const row of pathRows) {
        pathBySession.set(row.session_id, row.jsonl_path);
      }

      const workflows: ActiveWorkflow[] = [];
      let scanned = 0;
      for (const sessionId of toScan) {
        scanned += 1;
        const workflowsDir = resolveWorkflowsDir(pathBySession.get(sessionId) ?? null);
        if (!workflowsDir) {
          continue; // No transcript path => no workflows dir to inspect.
        }
        const sessionWorkflows = await scanSessionWorkflows(sessionId, workflowsDir, now, quietMs);
        for (const wf of sessionWorkflows) {
          workflows.push(wf);
        }
      }

      return { workflows, eligible, scanned, capped };
    } catch (error) {
      // Defensive top-level guard: status must never break, only degrade.
      console.debug(
        '[workflow-status] unexpected failure, returning empty:',
        error instanceof Error ? error.message : String(error),
      );
      return empty;
    }
  },
};
