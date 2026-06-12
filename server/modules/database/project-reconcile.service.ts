/**
 * Project-reconcile service (B-38).
 *
 * At server boot (and every 6 hours thereafter) this service scans every
 * active project row in the database and checks whether its directory exists
 * on disk.  Projects whose folder is gone are soft-archived (isArchived = 1)
 * — no rows are deleted, so data is never lost.
 *
 * Design constraints:
 *  - No deletion: missing folder → isArchived = 1 + log. Hard-delete is a
 *    user action (project-delete.service.ts).
 *  - No conflict with the session synchronizer: the synchronizer operates on
 *    the sessions table; this service touches only the projects table. Writes
 *    are one-row UPDATE statements — no structural table changes.
 *  - The timer is intentionally coarse (6 h): it is not a realtime watcher.
 *    The filesystem check is async so it never blocks the event loop.
 *  - `stopReconcileScheduler()` cancels the interval — used in tests and
 *    graceful shutdown.
 */

import fs from 'node:fs/promises';

import { getConnection } from '@/modules/database/connection.js';

// ---------------------------------------------------------------------------
// Core reconcile logic (exported for direct use + tests)
// ---------------------------------------------------------------------------

export type ReconcileResult = {
  /** Total active (non-archived) projects inspected. */
  checked: number;
  /** Projects newly archived because their folder was missing. */
  archived: number;
  /** project_ids that were archived in this run. */
  archivedIds: string[];
};

/**
 * Checks every active project in the database and archives those whose
 * directory no longer exists on disk.
 *
 * Safe to call concurrently: each UPDATE is keyed by project_id and operates
 * only on rows where isArchived = 0, so a double-run is idempotent.
 */
export async function reconcileProjects(): Promise<ReconcileResult> {
  const db = getConnection();

  type ProjectRow = { project_id: string; project_path: string };
  const activeProjects = db
    .prepare(
      `SELECT project_id, project_path
       FROM projects
       WHERE isArchived = 0`
    )
    .all() as ProjectRow[];

  const archiveStmt = db.prepare(
    `UPDATE projects
     SET isArchived = 1
     WHERE project_id = ? AND isArchived = 0`
  );

  const archivedIds: string[] = [];

  // Check existence in parallel — avoids sequential disk round-trips for
  // large project lists while staying non-blocking on the event loop.
  const checks = activeProjects.map(async (row) => {
    let exists = false;
    try {
      await fs.access(row.project_path);
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) {
      const changes = archiveStmt.run(row.project_id).changes;
      if (changes > 0) {
        console.log('[reconcile] Project folder missing — archived:', {
          project_id: row.project_id,
          project_path: row.project_path,
        });
        archivedIds.push(row.project_id);
      }
    }
  });

  await Promise.all(checks);

  return {
    checked: activeProjects.length,
    archived: archivedIds.length,
    archivedIds,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the project-reconcile scheduler.
 *
 * Runs one reconcile pass immediately on boot, then again every 6 hours.
 * Calling this more than once is safe — a running scheduler is stopped and
 * replaced so there is never more than one timer.
 *
 * Integration note (server/index.js): call `startReconcileScheduler()` after
 * `initializeDatabase()` completes. No import of server/index.js is required
 * here — the coupling is one-directional.
 */
export function startReconcileScheduler(): void {
  // Clear any existing timer so hot-reloads or double-init are safe.
  stopReconcileScheduler();

  // Immediate first pass — catches stale paths on boot without waiting 6 h.
  void reconcileProjects().then((result) => {
    if (result.archived > 0) {
      console.log('[reconcile] Boot pass complete:', result);
    }
  }).catch((err: unknown) => {
    console.error('[reconcile] Boot pass failed:', err);
  });

  reconcileTimer = setInterval(() => {
    void reconcileProjects().then((result) => {
      if (result.archived > 0) {
        console.log('[reconcile] Scheduled pass complete:', result);
      }
    }).catch((err: unknown) => {
      console.error('[reconcile] Scheduled pass failed:', err);
    });
  }, RECONCILE_INTERVAL_MS);

  // Allow the Node.js process to exit even if this timer is still pending.
  reconcileTimer.unref();
}

/**
 * Cancels the reconcile scheduler. Used in tests and graceful shutdown.
 */
export function stopReconcileScheduler(): void {
  if (reconcileTimer !== null) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}
