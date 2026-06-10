/**
 * Session participants repository.
 *
 * Tracks the authenticated human users who have spawned runs inside a session
 * (table: session_participants). The earliest participant of a session is
 * flagged 'owner'; later distinct users are 'participant'. All access uses
 * prepared statements — no string interpolation of caller input.
 *
 * The agent side of participation (models / subagents parsed from the
 * transcript) lives in the transcript parser service and the
 * session_agents_cache / session_agents_meta tables, not here.
 */

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

export type ParticipantRole = 'owner' | 'participant';

/**
 * Spawn-site context used to self-heal a missing parent sessions row. The run
 * path can outrace the session synchronizer: on the FIRST spawn of a fresh
 * conversation the sessions row (created later from the transcript file) does
 * not exist yet, so the participant insert fails its FOREIGN KEY. With this
 * context we create the parent row ourselves (the synchronizer's later upsert
 * fills in the real jsonl_path / timestamps) and retry once.
 */
export type SpawnContext = {
  provider: string;
  projectPath: string;
};

const RECORD_SPAWN_SQL = `INSERT INTO session_participants (session_id, user_id, role, message_count)
   VALUES (
     ?,
     ?,
     CASE
       WHEN NOT EXISTS (SELECT 1 FROM session_participants WHERE session_id = ?)
       THEN 'owner'
       ELSE 'participant'
     END,
     1
   )
   ON CONFLICT(session_id, user_id) DO UPDATE SET
     last_seen = CURRENT_TIMESTAMP,
     message_count = message_count + 1`;

export type SessionParticipantRow = {
  userId: number;
  username: string;
  role: ParticipantRole;
  first_seen: string;
  last_seen: string;
  message_count: number;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) or null. Joined
  // from the users table so the participant UI can render real avatars instead of
  // the coloured initial fallback.
  avatarUrl: string | null;
};

/**
 * Minimal owner identity for a single session, used to attribute each session
 * in the projects/sessions listing to the human who first spawned it.
 */
export type SessionOwnerRow = {
  sessionId: string;
  userId: number;
  username: string;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) or null, so
  // owner badges can render the real avatar instead of the coloured initial.
  avatarUrl: string | null;
};

export const participantsDb = {
  /**
   * Records (or refreshes) a human participant on a session spawn.
   *
   * First writer for a session becomes 'owner'; any subsequent distinct user is
   * 'participant'. On a repeat spawn by an existing participant the row's
   * last_seen is bumped and message_count incremented — the role is never
   * downgraded. Never throws: participation tracking must not break the run
   * path, so failures are logged and swallowed.
   */
  recordSpawn(sessionId: string, userId: number, context?: SpawnContext): void {
    if (!sessionId || !Number.isInteger(userId)) {
      return;
    }

    try {
      const db = getConnection();
      db.prepare(RECORD_SPAWN_SQL).run(sessionId, userId, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // FK failure = the parent sessions row does not exist yet (run path beat
      // the synchronizer). Create it from the spawn context and retry once; the
      // synchronizer's upsert later replaces the stub fields with real values.
      if (context && /FOREIGN KEY/i.test(message)) {
        try {
          sessionsDb.createSession(sessionId, context.provider, context.projectPath);
          getConnection().prepare(RECORD_SPAWN_SQL).run(sessionId, userId, sessionId);
          return;
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error('Failed to record session participant after creating session row', {
            sessionId,
            userId,
            error: retryMessage,
          });
          return;
        }
      }

      console.error('Failed to record session participant', { sessionId, userId, error: message });
    }
  },

  /**
   * Lists the human participants of a session, joined to their current
   * username. Ordered owner-first then by first appearance so the UI renders a
   * stable, meaningful sequence.
   */
  listBySession(sessionId: string): SessionParticipantRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT
           sp.user_id      AS userId,
           u.username      AS username,
           u.avatar_url    AS avatarUrl,
           sp.role         AS role,
           sp.first_seen   AS first_seen,
           sp.last_seen    AS last_seen,
           sp.message_count AS message_count
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = ?
         ORDER BY CASE sp.role WHEN 'owner' THEN 0 ELSE 1 END, datetime(sp.first_seen) ASC`
      )
      .all(sessionId) as SessionParticipantRow[];
  },

  /**
   * Aggregates human participants across many sessions (a project view).
   * Distinct users are returned once; message_count is summed and the earliest
   * first_seen / latest last_seen are kept. The 'owner' role is preserved if the
   * user owned at least one of the project's sessions.
   */
  aggregateBySessionIds(sessionIds: string[]): SessionParticipantRow[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT
           sp.user_id AS userId,
           u.username AS username,
           MAX(u.avatar_url) AS avatarUrl,
           CASE WHEN MAX(sp.role = 'owner') = 1 THEN 'owner' ELSE 'participant' END AS role,
           MIN(sp.first_seen)  AS first_seen,
           MAX(sp.last_seen)   AS last_seen,
           SUM(sp.message_count) AS message_count
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id IN (${placeholders})
         GROUP BY sp.user_id, u.username
         ORDER BY CASE WHEN MAX(sp.role = 'owner') = 1 THEN 0 ELSE 1 END, datetime(MIN(sp.first_seen)) ASC`
      )
      .all(...sessionIds) as SessionParticipantRow[];
  },

  /**
   * Batched owner lookup for a page of sessions (avoids N+1 in the listing
   * path). Returns at most one owner row per session_id — the 'owner' role row.
   * Sessions without any participant row (legacy / pre-multi-user) simply do
   * not appear in the result, and the caller falls back to a null owner.
   */
  getOwnersBySessionIds(sessionIds: string[]): SessionOwnerRow[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT
           sp.session_id AS sessionId,
           sp.user_id    AS userId,
           u.username     AS username,
           u.avatar_url   AS avatarUrl
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.role = 'owner'
           AND sp.session_id IN (${placeholders})`
      )
      .all(...sessionIds) as SessionOwnerRow[];
  },

  /**
   * Distinct project paths in which the given user participates (as owner or
   * participant) in at least one session. Used by the projects listing to set a
   * per-project "current user participates" flag without filtering the list.
   * One set-based query joined through sessions — no per-project lookups.
   */
  getProjectPathsForUser(userId: number): string[] {
    if (!Number.isInteger(userId)) {
      return [];
    }

    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT DISTINCT s.project_path AS projectPath
         FROM session_participants sp
         JOIN sessions s ON s.session_id = sp.session_id
         WHERE sp.user_id = ?
           AND s.project_path IS NOT NULL`
      )
      .all(userId) as Array<{ projectPath: string | null }>;

    return rows
      .map((row) => row.projectPath)
      .filter((projectPath): projectPath is string => typeof projectPath === 'string' && projectPath.length > 0);
  },
};
