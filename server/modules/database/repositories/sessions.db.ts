import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type SessionMetadataLookupRow = Pick<
  SessionRow,
  'session_id' | 'provider' | 'project_path' | 'jsonl_path' | 'custom_name' | 'isArchived' | 'created_at' | 'updated_at'
>;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

/**
 * "Native" session predicate (B-29): a session is shown in the conversations
 * list only when it was actually started through this server — i.e. the server
 * run path recorded a participant row (`recordSpawn`) or a message-author row
 * (`recordUserMessage`) for it. Both are written exclusively on the spawn path
 * and never by an external `claude -p` invocation, so any transcript dropped
 * into the project folder by an out-of-band CLI/agent run (an "orphan" session)
 * is excluded from the list instead of being silently adopted.
 *
 * Applied as a correlated EXISTS so it never duplicates session rows and stays a
 * pure visibility filter — it does not touch ownership, deletion, or archival
 * paths, which must still see every row.
 */
const NATIVE_SESSION_PREDICATE_SQL = `(
  EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = sessions.session_id)
  OR EXISTS (SELECT 1 FROM message_authors ma WHERE ma.session_id = sessions.session_id)
)`;

export const sessionsDb = {
  createSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // Wrap the project-upsert + session-upsert in a single transaction so a
    // concurrent UNIQUE violation or mid-flight crash never leaves the sessions
    // table with a dangling project_path reference or a partial row.  (B-38.)
    const run = db.transaction(() => {
      // Ensure the project path exists in the projects table before writing the
      // session row that carries the FK reference.
      projectsDb.createProjectPath(normalizedProjectPath);

      db.prepare(
        `INSERT INTO sessions (session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
         ON CONFLICT(session_id) DO UPDATE SET
           provider = excluded.provider,
           updated_at = excluded.updated_at,
           project_path = excluded.project_path,
           jsonl_path = excluded.jsonl_path,
           isArchived = 0,
           custom_name = COALESCE(excluded.custom_name, sessions.custom_name)`
      ).run(
        sessionId,
        provider,
        customName ?? null,
        normalizedProjectPath,
        jsonlPath ?? null,
        createdAtValue,
        updatedAtValue
      );
    });

    run();
    return sessionId;
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionMetadataLookupRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionMetadataLookupRow | undefined;

    return row ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    // Sidebar order: newest-created first (creation date, NOT last activity).
    // `created_at` comes from the session's first transcript timestamp /
    // file birthtime at index time and never changes on upsert, so pagination
    // pages stay stable while a session is active.
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}
         ORDER BY datetime(COALESCE(created_at, updated_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /**
   * Ghost-session cleanup reads every row for one provider (archived included)
   * with a stored transcript path, so the synchronizer can prune entries whose
   * file vanished from disk (e.g. Claude's ~30-day retention sweep).
   */
  getSessionFilePathsByProvider(provider: string): Array<{ session_id: string; jsonl_path: string }> {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, jsonl_path
         FROM sessions
         WHERE provider = ?
           AND jsonl_path IS NOT NULL`
      )
      .all(provider) as Array<{ session_id: string; jsonl_path: string }>;
  },

  /**
   * Removes every row indexed from one transcript file and returns the deleted
   * session ids, so watcher `unlink` events can drop ghost sessions immediately.
   */
  deleteSessionsByJsonlPath(jsonlPath: string): string[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT session_id FROM sessions WHERE jsonl_path = ?`)
      .all(jsonlPath) as Array<{ session_id: string }>;

    if (rows.length === 0) {
      return [];
    }

    db.prepare(`DELETE FROM sessions WHERE jsonl_path = ?`).run(jsonlPath);
    return rows.map((row) => row.session_id);
  },
};
