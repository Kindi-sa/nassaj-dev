const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
`;

/**
 * audit_log — append-only record of security-relevant auth events.
 * Never stores passwords, tokens, or raw PII; metadata is sanitized JSON.
 */
export const AUDIT_LOG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    metadata TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
`;

/**
 * invites — invite-only registration tokens. Only the SHA-256 hash of the
 * token is stored (token_hash); the plaintext token is shown once at creation.
 * status: pending | accepted | revoked. Expiry enforced at acceptance time.
 */
export const INVITES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    invited_by INTEGER NOT NULL,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at DATETIME NOT NULL,
    accepted_by INTEGER,
    accepted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
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
);
`;

/**
 * session_participants — records every authenticated human user who has
 * spawned a run inside a session. The first participant is flagged 'owner';
 * subsequent users are 'participant'. message_count is a coarse activity
 * counter incremented on each spawn.
 *
 * NOTE: created via migration (migrateParticipantsAndAgents), NOT included in
 * INIT_SCHEMA_SQL. Its indexes likewise live only in the migration.
 */
export const SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_participants (
    session_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'participant',
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    PRIMARY KEY (session_id, user_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * message_authors — per-message sender attribution for multi-user sessions
 * (B-MU-UX-FIX-MSG-AUTHOR). One row is written on the run path for every user
 * prompt an authenticated user sends; history loads join user-authored text
 * messages back to their author by (session_id, content_hash) plus timestamp
 * proximity. The transcript .jsonl itself is written by the provider CLI/SDK
 * (not by this server), so authorship cannot be embedded in the transcript
 * line without breaking format compatibility — this table is the sidecar.
 *
 * No FK on session_id on purpose: the run path can outrace the session
 * synchronizer (the sessions row may not exist yet at spawn time) and stale
 * rows for deleted sessions are harmless (matched by session_id only).
 * Messages recorded before this table existed simply have no row — the
 * frontend treats a missing userId as "unknown author" and falls back.
 *
 * NOTE: created via migration (migrateMessageAuthors), NOT in INIT_SCHEMA_SQL.
 */
export const MESSAGE_AUTHORS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS message_authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * session_agents_cache — parsed-on-demand inventory of the non-human actors in
 * a session transcript: the base model ('model') and any spawned subagents
 * ('subagent'). Populated by the transcript parser and keyed so repeated parses
 * upsert counts rather than duplicate rows.
 *
 * NOTE: created via migration only.
 */
export const SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_agents_cache (
    session_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    invocation_count INTEGER DEFAULT 1,
    PRIMARY KEY (session_id, agent_name, agent_kind)
);
`;

/**
 * session_agents_meta — freshness sentinel for session_agents_cache. Stores the
 * transcript file mtime at last parse so getSessionAgents can skip re-parsing
 * an unchanged transcript.
 *
 * NOTE: created via migration only.
 */
export const SESSION_AGENTS_META_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_agents_meta (
    session_id TEXT PRIMARY KEY,
    transcript_mtime INTEGER NOT NULL,
    parsed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * webauthn_credentials — registered passkeys (WebAuthn credentials) per user.
 * id is the credential ID as a base64url string (what the authenticator returns
 * and what login responses are looked up by). public_key is the COSE public key
 * bytes used to verify assertion signatures; counter backs clone detection.
 * transports is a JSON array of hint strings (e.g. ["internal","hybrid"]).
 *
 * NOTE: created via migration (migrateWebAuthnCredentials), NOT included in
 * INIT_SCHEMA_SQL. Its index likewise lives only in the migration.
 */
export const WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    device_type TEXT,
    backed_up INTEGER NOT NULL DEFAULT 0,
    aaguid TEXT,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
-- NOTE: idx_users_role / idx_users_status moved to migrations.ts (migrateMultiUserAuth)
-- because the role/status columns are added there, AFTER initial schema creation.
-- Creating them here breaks fresh init on legacy DBs ("no such column: role").

${AUDIT_LOG_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

${INVITES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}
`;
