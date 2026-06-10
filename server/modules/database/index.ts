export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { auditLogDb } from '@/modules/database/repositories/audit-log.js';
export { invitesDb } from '@/modules/database/repositories/invites.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { hashMessageAuthorContent, messageAuthorsDb } from '@/modules/database/repositories/message-authors.db.js';
export type { MessageAuthorRow } from '@/modules/database/repositories/message-authors.db.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
export { participantsDb } from '@/modules/database/repositories/participants.db.js';
export type { ParticipantRole, SessionParticipantRow } from '@/modules/database/repositories/participants.db.js';
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { sessionAgentsDb } from '@/modules/database/repositories/session-agents.db.js';
export type { AgentKind, SessionAgentRow } from '@/modules/database/repositories/session-agents.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export { webauthnCredentialsDb } from '@/modules/database/repositories/webauthn-credentials.js';
export type {
  WebAuthnCredentialRow,
  WebAuthnCredentialSummary,
} from '@/modules/database/repositories/webauthn-credentials.js';
