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

export type ParticipantRole = 'owner' | 'participant';

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
  recordSpawn(sessionId: string, userId: number): void {
    if (!sessionId || !Number.isInteger(userId)) {
      return;
    }

    try {
      const db = getConnection();
      db.prepare(
        `INSERT INTO session_participants (session_id, user_id, role, message_count)
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
           message_count = message_count + 1`
      ).run(sessionId, userId, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
};
