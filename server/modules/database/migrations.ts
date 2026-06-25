import { Database } from 'better-sqlite3';

import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  AUDIT_LOG_TABLE_SCHEMA_SQL,
  INVITES_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  MESSAGE_AUTHORS_TABLE_SCHEMA_SQL,
  PROJECT_MEMBERS_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL,
  SESSION_AGENTS_META_TABLE_SCHEMA_SQL,
  SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  STARRED_SESSIONS_TABLE_SCHEMA_SQL,
  USER_IDENTITIES_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
  WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'visibility', "TEXT NOT NULL DEFAULT 'public'");
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'created_by', 'INTEGER');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const visibilityExpression = columnNames.includes('visibility')
    ? "COALESCE(visibility, 'public')"
    : "'public'";

  const createdByExpression = columnNames.includes('created_by') ? 'created_by' : 'NULL';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'public',
        created_by INTEGER
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${visibilityExpression} AS visibility,
          ${createdByExpression} AS created_by,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          visibility,
          created_by,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          visibility,
          created_by
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived,
        visibility,
        created_by
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived,
        visibility,
        created_by
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

/**
 * Phase-MU migration: extend `users` with multi-user columns and create the
 * `audit_log` + `invites` tables. Idempotent and non-destructive — existing
 * rows keep their data and gain the new columns with safe defaults. The first
 * pre-existing user (lowest id) is promoted to `owner` so a single-user install
 * upgrading to multi-user does not lose admin access.
 */
const migrateMultiUserAuth = (db: Database, userColumnNames: string[]): void => {
  // SQLite cannot add a column with a non-constant default or a FK inline via
  // ALTER, so invited_by is added as a plain nullable INTEGER (FK enforced on
  // fresh installs via CREATE TABLE; logically references users.id).
  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'role', "TEXT NOT NULL DEFAULT 'user'");
  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'invited_by', 'INTEGER');

  db.exec(AUDIT_LOG_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)');

  db.exec(INVITES_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status)');

  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)');

  // Promote the earliest pre-existing user to owner if no owner exists yet.
  const ownerRow = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'")
    .get() as { count: number };
  if (ownerRow.count === 0) {
    const firstUser = db
      .prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1')
      .get() as { id: number } | undefined;
    if (firstUser) {
      console.log('Running migration: Promoting first existing user to owner', { userId: firstUser.id });
      db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(firstUser.id);
    }
  }
};

/**
 * audit_log diagnostic enrichment (T-182). Adds the `user_agent` column to the
 * audit_log table on existing installs so auth events can record the caller's
 * User-Agent string for forensics (e.g. distinguishing a real browser from a
 * scripted client during an account-takeover investigation). Fresh installs get
 * the column from AUDIT_LOG_TABLE_SCHEMA_SQL; this migration is the additive,
 * idempotent backstop for upgraded databases.
 *
 * Forward-only: no backfill (historical rows keep NULL), no index (the column is
 * read for inspection, never filtered/joined on). Guarded by tableExists so it
 * is a no-op on a pre-bootstrap database that has not created audit_log yet.
 */
const migrateAuditLogUserAgent = (db: Database): void => {
  if (!tableExists(db, 'audit_log')) {
    return;
  }
  const cols = (db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]).map(
    (r) => r.name
  );
  addColumnToTableIfNotExists(db, 'audit_log', cols, 'user_agent', 'TEXT DEFAULT NULL');
};

/**
 * Password-lifecycle migration (C-1): adds the columns backing JWT invalidation
 * on password change and forced password rotation.
 *
 *   - password_changed_at: unix epoch (ms) of the last password change. Tokens
 *     minted before this instant carry a stale `pwd_iat` and are rejected.
 *   - must_change_password: 1 when an admin has reset the password and the user
 *     must set a new one before normal use.
 *
 * Existing users are backfilled with the current time so their live sessions
 * are not invalidated by the introduction of the `pwd_iat` check.
 */
const migratePasswordLifecycle = (db: Database, userColumnNames: string[]): void => {
  const hadPasswordChangedAt = userColumnNames.includes('password_changed_at');

  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'password_changed_at', 'INTEGER');
  addColumnToTableIfNotExists(
    db,
    'users',
    userColumnNames,
    'must_change_password',
    'INTEGER NOT NULL DEFAULT 0'
  );

  // Backfill only on first introduction of the column: stamp existing users with
  // "now" so their currently valid tokens (pwd_iat == now at issue) are not
  // retroactively invalidated. Idempotent: skipped once the column exists.
  if (!hadPasswordChangedAt) {
    console.log('Running migration: Backfilling password_changed_at for existing users');
    db.prepare(
      'UPDATE users SET password_changed_at = ? WHERE password_changed_at IS NULL'
    ).run(Date.now());
  }
};

/**
 * Participant & agent tracking migration. Creates the three tracking tables and
 * their indexes (indexes live here, never in INIT_SCHEMA_SQL — see the 502
 * lesson where indexing migration-added columns at init broke fresh boots), then
 * backfills every existing session with the install owner as its 'owner'
 * participant so historical conversations are not left without an attributed
 * human. Idempotent: tables use IF NOT EXISTS and the backfill uses
 * INSERT OR IGNORE, so re-runs are no-ops. The backfill is recorded once in the
 * audit log per run that actually inserts rows.
 */
const migrateParticipantsAndAgents = (db: Database): void => {
  db.exec(SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL);
  db.exec(SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL);
  db.exec(SESSION_AGENTS_META_TABLE_SCHEMA_SQL);

  db.exec('CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_participants_user ON session_participants(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_agents_cache_session ON session_agents_cache(session_id)');

  // Backfill: attribute every existing session to the install owner so the
  // participant view is complete from day one. Skip silently when no owner
  // exists yet (pre-bootstrap install) or no sessions are present.
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as
    | { id: number }
    | undefined;

  if (!owner) {
    return;
  }

  const sessions = db.prepare('SELECT session_id FROM sessions').all() as { session_id: string }[];
  if (sessions.length === 0) {
    return;
  }

  const insertOwner = db.prepare(
    `INSERT OR IGNORE INTO session_participants (session_id, user_id, role)
     VALUES (?, ?, 'owner')`
  );

  let inserted = 0;
  const runBackfill = db.transaction((rows: { session_id: string }[]) => {
    for (const s of rows) {
      inserted += insertOwner.run(s.session_id, owner.id).changes;
    }
  });
  runBackfill(sessions);

  if (inserted > 0) {
    console.log('Running migration: Backfilled session participants', { inserted });
    db.prepare(
      'INSERT INTO audit_log (user_id, action, metadata) VALUES (?, ?, ?)'
    ).run(owner.id, 'participants_backfilled', JSON.stringify({ inserted }));
  }
};

/**
 * Per-message sender attribution (B-MU-UX-FIX-MSG-AUTHOR). Creates the
 * message_authors sidecar table the run path writes a row into for every user
 * prompt, plus the session lookup index the history-stamping path reads.
 * Idempotent (IF NOT EXISTS); no backfill is possible — pre-existing messages
 * have no recorded author and stay unattributed by design.
 */
const migrateMessageAuthors = (db: Database): void => {
  db.exec(MESSAGE_AUTHORS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_authors_session ON message_authors(session_id)');
};

/**
 * Private-project visibility (B-PRIV-1). Ensures the `visibility` + `created_by`
 * columns exist on `projects` and creates the visibility lookup index.
 *
 * The columns are normally added by rebuildProjectsTableWithPrimaryKeySchema
 * (which also keeps the table-rebuild path in sync — critical so they are not
 * dropped on a future legacy rebuild). This function is a defensive, idempotent
 * backstop that also owns the index (index lives in migrations, never in
 * INIT_SCHEMA_SQL — see the 502 lesson). Existing rows default to 'public', so
 * the introduction of private projects never retroactively hides any project.
 */
const migrateProjectVisibility = (db: Database): void => {
  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'projects', columnNames, 'visibility', "TEXT NOT NULL DEFAULT 'public'");
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'created_by', 'INTEGER');

  // Defensive backfill: any NULL visibility (e.g. from a partial legacy rebuild)
  // resolves to the safe 'public' default so it is never silently hidden.
  db.exec("UPDATE projects SET visibility = 'public' WHERE visibility IS NULL");

  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_visibility ON projects(visibility)');
};

/**
 * Explicit project membership (B-PRIV-1). Creates the project_members table and
 * its user lookup index (index lives here, never in INIT_SCHEMA_SQL — see the
 * 502 lesson). Idempotent (IF NOT EXISTS); no backfill — membership is derived
 * for legacy private conversions at conversion time, and public projects need
 * no rows. Must run AFTER both `projects` and `users` exist so the FKs resolve.
 */
const migrateProjectMembers = (db: Database): void => {
  db.exec(PROJECT_MEMBERS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)');
};

/**
 * Passkey support (B-PK-1). Creates the webauthn_credentials table and its
 * user lookup index (index lives here, never in INIT_SCHEMA_SQL — see the 502
 * lesson). Idempotent (IF NOT EXISTS); no backfill — users register passkeys
 * explicitly from their account settings.
 */
const migrateWebAuthnCredentials = (db: Database): void => {
  db.exec(WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id)'
  );
};

/**
 * Per-user session stars/favorites (B-STAR). Creates the starred_sessions table
 * and its user lookup index (index lives here, never in INIT_SCHEMA_SQL — see
 * the 502 lesson). Idempotent (IF NOT EXISTS); no backfill — stars are an
 * explicit user action, so existing sessions start unstarred for everyone. Must
 * run AFTER users exists so the user_id FK resolves.
 */
const migrateStarredSessions = (db: Database): void => {
  db.exec(STARRED_SESSIONS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_starred_sessions_user ON starred_sessions(user_id)');
};

/**
 * Adds ON DELETE CASCADE from session_agents_cache and session_agents_meta to
 * sessions. SQLite does not support ALTER TABLE … ADD CONSTRAINT, so we use
 * the safe rename-and-rebuild pattern inside an explicit transaction.
 *
 * Idempotent: checks whether the FK already carries the CASCADE action by
 * inspecting `PRAGMA foreign_key_list` — a rebuild is only performed when
 * needed, so this function is always safe to call during boot.
 *
 * Data preservation is guaranteed: all existing rows are copied to the new
 * tables before the old ones are dropped. The operation runs under a single
 * transaction so a partial failure leaves the original tables intact.
 *
 * (B-38 / ADR-023.)
 */
const migrateSessionAgentsCascade = (db: Database): void => {
  type FkListRow = { table: string; on_delete: string };

  const cascadeNeededFor = (tableName: string): boolean => {
    if (!tableExists(db, tableName)) {
      return false;
    }
    const fkList = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as FkListRow[];
    // Look for the FK that points at sessions — if it's already CASCADE we're done.
    const sessionFk = fkList.find((row) => row.table === 'sessions');
    return !sessionFk || sessionFk.on_delete !== 'CASCADE';
  };

  const needsCacheRebuild = cascadeNeededFor('session_agents_cache');
  const needsMetaRebuild = cascadeNeededFor('session_agents_meta');

  if (!needsCacheRebuild && !needsMetaRebuild) {
    return;
  }

  console.log('Running migration: Adding ON DELETE CASCADE to session_agents tables');

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');

    if (needsCacheRebuild) {
      db.exec('DROP TABLE IF EXISTS session_agents_cache__new');
      db.exec(`
        CREATE TABLE session_agents_cache__new (
          session_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          agent_kind TEXT NOT NULL,
          invocation_count INTEGER DEFAULT 1,
          PRIMARY KEY (session_id, agent_name, agent_kind),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO session_agents_cache__new
          (session_id, agent_name, agent_kind, invocation_count)
        SELECT session_id, agent_name, agent_kind, invocation_count
        FROM session_agents_cache
      `);
      db.exec('DROP TABLE session_agents_cache');
      db.exec('ALTER TABLE session_agents_cache__new RENAME TO session_agents_cache');
      // Recreate the index that normally lives in migrateParticipantsAndAgents.
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_agents_cache_session ON session_agents_cache(session_id)'
      );
    }

    if (needsMetaRebuild) {
      db.exec('DROP TABLE IF EXISTS session_agents_meta__new');
      db.exec(`
        CREATE TABLE session_agents_meta__new (
          session_id TEXT PRIMARY KEY,
          transcript_mtime INTEGER NOT NULL,
          parsed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO session_agents_meta__new
          (session_id, transcript_mtime, parsed_at)
        SELECT session_id, transcript_mtime, parsed_at
        FROM session_agents_meta
      `);
      db.exec('DROP TABLE session_agents_meta');
      db.exec('ALTER TABLE session_agents_meta__new RENAME TO session_agents_meta');
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

/**
 * Adds the `agent_model` column to `session_agents_cache` so that the
 * transcript parser can record the resolved model string for each agent
 * (coordinator model and per-subagent model when recoverable from subagent
 * JSONL files). Idempotent — uses `addColumnToTableIfNotExists`.
 *
 * Fresh installs already have this column from SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL;
 * this migration handles existing databases that were created before the column
 * was added.
 */
const migrateSessionAgentsModel = (db: Database): void => {
  if (!tableExists(db, 'session_agents_cache')) {
    return;
  }
  const cols = (db.prepare('PRAGMA table_info(session_agents_cache)').all() as { name: string }[]).map(
    (r) => r.name
  );
  addColumnToTableIfNotExists(db, 'session_agents_cache', cols, 'agent_model', 'TEXT DEFAULT NULL');
};

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'avatar_url', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );

    migrateMultiUserAuth(db, userColumnNames);
    // audit_log.user_agent (T-182) — after migrateMultiUserAuth has ensured the
    // audit_log table exists, so the additive column migration finds its target.
    migrateAuditLogUserAgent(db);
    migratePasswordLifecycle(db, userColumnNames);

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    ensureProjectsForSessionPaths(db);

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    db.exec(LAST_SCANNED_AT_SQL);

    // Participant & agent tracking — must run after sessions/users exist so the
    // FKs resolve and the owner backfill can find both tables.
    migrateParticipantsAndAgents(db);

    // Message sender attribution — after users exist so the FK resolves.
    migrateMessageAuthors(db);

    // Private-project visibility + membership — after the projects table has its
    // project_id primary key (rebuildProjectsTableWithPrimaryKeySchema, above)
    // and after users exist so the project_members FKs resolve.
    migrateProjectVisibility(db);
    migrateProjectMembers(db);

    // Passkeys (WebAuthn) — after users exist so the FK resolves.
    migrateWebAuthnCredentials(db);

    // Per-user session stars — after users exist so the FK resolves.
    migrateStarredSessions(db);

    // OIDC identity linking (P-IDP-3, ADR-046) — after users exist so the
    // user_id FK resolves. Idempotent (IF NOT EXISTS); no backfill (links are
    // created explicitly when a user authenticates through or connects an IdP).
    if (!tableExists(db, 'user_identities')) {
      console.log('Running migration: Creating user_identities table');
      db.exec(USER_IDENTITIES_TABLE_SCHEMA_SQL);
    }

    // FK CASCADE on session_agents tables — must run after sessions exist so
    // the REFERENCES sessions(session_id) constraint is satisfiable. (B-38.)
    migrateSessionAgentsCascade(db);

    // agent_model column on session_agents_cache — stores the resolved model
    // string for each agent row so the UI can display per-agent model badges.
    migrateSessionAgentsModel(db);

    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

/** Retention horizon for audit_log rows (T-182, qa-critic D-3): 90 days. */
const AUDIT_LOG_RETENTION_DAYS = 90;

/**
 * Prunes audit_log rows older than the retention horizon (T-182, qa-critic D-3).
 * The audit log is append-only and grows unbounded otherwise; this bounds it to
 * a rolling 90-day window. Called once at boot after runMigrations (best-effort:
 * a prune failure must never block startup). Parameterized + guarded by
 * tableExists so it is a safe no-op on a pre-bootstrap database.
 */
export const pruneAuditLog = (db: Database): void => {
  try {
    if (!tableExists(db, 'audit_log')) {
      return;
    }
    const cutoff = `-${AUDIT_LOG_RETENTION_DAYS} days`;
    const result = db
      .prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
      .run(cutoff);
    if (result.changes > 0) {
      console.log('Pruned old audit_log rows', { deleted: result.changes });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to prune audit_log (non-fatal)', { error: message });
  }
};
