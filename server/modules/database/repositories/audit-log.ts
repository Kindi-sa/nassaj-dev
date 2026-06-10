/**
 * Audit log repository.
 *
 * Append-only store of security-relevant auth events (login success/failure,
 * invite created/accepted/revoked, bootstrap, user disabled, etc.).
 *
 * IMPORTANT: never pass passwords, JWTs, or raw PII into `metadata`. Callers
 * must sanitize before recording. `metadata` is stored as a JSON string.
 */

import { getConnection } from '@/modules/database/connection.js';

export type AuditAction =
  | 'login_success'
  | 'login_failure'
  | 'token_refresh'
  | 'bootstrap_owner'
  | 'invite_created'
  | 'invite_accepted'
  | 'invite_revoked'
  | 'invite_rejected'
  | 'user_disabled'
  | 'user_enabled'
  | 'role_changed'
  | 'user_dirs_provisioned'
  | 'password_changed'
  | 'username_changed'
  | 'password_reset'
  | 'avatar_updated'
  | 'admin_provider_sharing_update'
  | 'passkey_registered'
  | 'passkey_removed';

type AuditLogRow = {
  id: number;
  user_id: number | null;
  action: string;
  metadata: string | null;
  ip_address: string | null;
  created_at: string;
};

export const auditLogDb = {
  /**
   * Records an audit event. Never throws — auditing must not break the request
   * path. `metadata` is JSON-stringified; pass only non-sensitive fields.
   */
  record(
    action: AuditAction,
    options: {
      userId?: number | null;
      metadata?: Record<string, unknown>;
      ipAddress?: string | null;
    } = {}
  ): void {
    try {
      const db = getConnection();
      const metadataJson =
        options.metadata === undefined ? null : JSON.stringify(options.metadata);
      db.prepare(
        'INSERT INTO audit_log (user_id, action, metadata, ip_address) VALUES (?, ?, ?, ?)'
      ).run(options.userId ?? null, action, metadataJson, options.ipAddress ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to write audit log', { action, error: message });
    }
  },

  /** Returns the most recent audit entries (newest first), capped by limit. */
  recent(limit = 100): AuditLogRow[] {
    const db = getConnection();
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    return db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(safeLimit) as AuditLogRow[];
  },
};
