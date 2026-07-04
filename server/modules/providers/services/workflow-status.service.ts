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
 * declared. Only "active" verdicts are returned — RUNNING, ORPHAN, plus UNKNOWN
 * (a restart survivor whose liveness is unproven, M1) and FROZEN (a stopped pid);
 * a COMPLETED workflow is dropped — so the payload is small. The status enum grew
 * additively: pre-M1 clients that only handle 'running'/'orphan' are unaffected.
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
import { classifyWorkflowLiveness, probeWorkflowLiveness } from '@/services/workflow-liveness.js';
// ADR-053 §ج-2: OPTIONAL scope-liveness precedence for supervisor-launched
// workflows. buildScopeLivenessResolver returns null when WORKFLOW_SUPERVISOR is
// off, so the resolver stays `undefined` and this service is byte-identical to
// its pid-only behavior. When a scope targets a workflow's project, its
// `systemctl is-active` verdict TAKES PRECEDENCE over the (blind-to-grandchildren)
// pid classifier — added BESIDE Layer-1, never inside classifyWorkflowLiveness.
import {
  buildScopeLivenessResolver,
  type ScopeLivenessResolver,
} from '@/modules/workflow-supervisor/index.js';

/**
 * Upper bound on how many of the caller's sessions are scanned per request. A
 * generous but finite cap: enough to cover an active user's live sessions while
 * bounding worst-case disk walks. When the caller owns more, `capped` is true so
 * the "no active workflow" answer is never mistaken for "did not look".
 */
const MAX_SESSIONS_SCANNED = 200;

/**
 * "Active" workflow states for the endpoint; COMPLETED is dropped.
 *
 *   - 'running' — pid alive, or dead-but-still-flushing (conservative).
 *   - 'orphan'  — a pid was recorded and died with work unfinished (real B-103).
 *   - 'unknown' — no pid ever recorded (a restart survivor): liveness unproven,
 *                 NOT a confirmed death (M1). ENUM GROWTH ONLY — a pre-M1 client
 *                 that only knows 'running'/'orphan' keeps working for those.
 *   - 'frozen'  — the recorded pid is STOPPED ('T'); mirrors the process badge.
 */
export type ActiveWorkflowStatus = 'running' | 'orphan' | 'unknown' | 'frozen';

/**
 * Maps a liveness verdict to the endpoint's status string, or null for a verdict
 * that is not "active" (COMPLETED) and must be dropped from the result set.
 */
function toActiveStatus(liveness: string): ActiveWorkflowStatus | null {
  switch (liveness) {
    case 'RUNNING':
      return 'running';
    case 'ORPHAN':
      return 'orphan';
    case 'UNKNOWN':
      return 'unknown';
    case 'FROZEN':
      return 'frozen';
    default:
      return null; // 'COMPLETED' (or any unexpected verdict) => not active.
  }
}

/**
 * Per-process LRU memo for {@link readJournalKeySets} results (M3), keyed by
 * `${path}:${mtimeMs}:${size}`. A COMPLETED workflow's journal never changes, so
 * its key is stable => a permanent cache hit => it is parsed at most once for the
 * process's life, collapsing per-scan cost to O(active workflows). This wraps the
 * CALL only — the shared parser is untouched, so the reconcile path stays
 * byte-identical. Bounded to MAX entries with oldest-first eviction; entries are
 * read-only Sets the callers never mutate, so sharing the reference is safe.
 */
type JournalKeySets = { startedKeys: Set<string>; resultKeys: Set<string> };
const JOURNAL_KEYSET_CACHE_MAX = 512;
const journalKeySetCache = new Map<string, JournalKeySets>();

async function readJournalKeySetsCached(
  journalPath: string,
  mtimeMs: number,
  size: number,
): Promise<JournalKeySets> {
  const cacheKey = `${journalPath}:${mtimeMs}:${size}`;
  const hit = journalKeySetCache.get(cacheKey);
  if (hit) {
    // LRU touch: re-insert so the most-recently-used key is last (evicted last).
    journalKeySetCache.delete(cacheKey);
    journalKeySetCache.set(cacheKey, hit);
    return hit;
  }

  const fresh = await readJournalKeySets(journalPath);
  journalKeySetCache.set(cacheKey, fresh);
  if (journalKeySetCache.size > JOURNAL_KEYSET_CACHE_MAX) {
    const oldest = journalKeySetCache.keys().next().value;
    if (oldest !== undefined) {
      journalKeySetCache.delete(oldest);
    }
  }
  return fresh;
}

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
  projectPath: string | null,
  scopeResolver: ScopeLivenessResolver | null,
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
  // `known` (a pid was ever recorded) is captured before pruning so the classifier
  // can tell a confirmed ORPHAN from an unproven UNKNOWN restart survivor (M1).
  const { alive, known, frozen } = probeWorkflowLiveness(sessionId);

  // ADR-053 §ج-2: if a supervisor scope targets this project, its is-active
  // verdict is AUTHORITATIVE for the session's workflows and PRECEDES the pid
  // classifier (which is blind to a scope grandchild). Null resolver / no scope
  // => undefined => pid path unchanged.
  let scopeLiveness: Awaited<ReturnType<ScopeLivenessResolver>> | null = null;
  if (scopeResolver && projectPath) {
    try {
      scopeLiveness = await scopeResolver(projectPath);
    } catch {
      scopeLiveness = null; // fail-safe: fall back to pid path
    }
  }

  const active: ActiveWorkflow[] = [];

  for (const entry of entries) {
    if (!entry.startsWith('wf_')) {
      continue;
    }

    const journalPath = path.join(workflowsDir, entry, 'journal.jsonl');

    let journalMtimeMs = 0;
    let journalSize = -1;
    let statOk = false;
    try {
      const journalStat: Stats = await fsp.stat(journalPath);
      journalMtimeMs = journalStat.mtimeMs;
      journalSize = journalStat.size; // M3: part of the memo cache key.
      statOk = true;
    } catch {
      // No journal yet for this workflow folder. mtime 0 => classifier treats it
      // as "quiet" (nothing being written); with a dead+known pid + no keys =>
      // ORPHAN, unknown pid => UNKNOWN, live pid => RUNNING. Surfaced, not
      // swallowed. No stat => no memo key => read directly (empty sets, cheap).
      journalMtimeMs = 0;
    }

    // M3: memoize the key-set read on (path, mtime, size). Only when stat
    // succeeded do we have a valid cache key; otherwise fall back to a direct read.
    const { startedKeys, resultKeys } = statOk
      ? await readJournalKeySetsCached(journalPath, journalMtimeMs, journalSize)
      : await readJournalKeySets(journalPath);
    let allStartedResulted = startedKeys.size >= 1;
    for (const key of startedKeys) {
      if (!resultKeys.has(key)) {
        allStartedResulted = false;
        break;
      }
    }

    // Scope liveness (is-active) PRECEDES the pid classifier for scope-launched
    // workflows (§ج-2). Only when there is no scope verdict do we fall back to
    // the unchanged Layer-1 pid path.
    const liveness =
      scopeLiveness ??
      classifyWorkflowLiveness({
        alive,
        known,
        frozen,
        startedKeyCount: startedKeys.size,
        resultKeyCount: resultKeys.size,
        allStartedResulted,
        journalMtimeMs,
        now,
        quietMs,
      });

    const status = toActiveStatus(liveness);
    if (status === null) {
      continue; // Not "active" (COMPLETED) — out of scope for this endpoint.
    }

    active.push({
      sessionId,
      wfId: entry,
      status,
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
      const jsonlBySession = new Map<string, string>();
      const projectBySession = new Map<string, string | null>();
      for (const row of pathRows) {
        jsonlBySession.set(row.session_id, row.jsonl_path);
        projectBySession.set(row.session_id, row.project_path);
      }

      // ADR-053 §ج-2: build the optional scope-liveness resolver ONCE per call.
      // Null when WORKFLOW_SUPERVISOR is off => scanner stays pid-only (no-op).
      const scopeResolver = await buildScopeLivenessResolver();

      const workflows: ActiveWorkflow[] = [];
      let scanned = 0;
      for (const sessionId of toScan) {
        scanned += 1;
        const workflowsDir = resolveWorkflowsDir(jsonlBySession.get(sessionId) ?? null);
        if (!workflowsDir) {
          continue; // No transcript path => no workflows dir to inspect.
        }
        // The session's real project cwd (== the intent's projectPath) is the
        // join key to a supervisor scope; null when unknown => pid path only.
        const projectPath = projectBySession.get(sessionId) ?? null;
        const sessionWorkflows = await scanSessionWorkflows(
          sessionId,
          workflowsDir,
          now,
          quietMs,
          projectPath,
          scopeResolver,
        );
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
