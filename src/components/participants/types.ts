// Shared types for the multi-user participation UI (Phase-MU).
// Mirrors the backend contract:
//   GET /api/sessions/:sessionId/participants
//   GET /api/sessions/:sessionId/agents
//   GET /api/projects/:projectId/participants

export type ParticipantRole = 'owner' | 'admin' | 'user' | string;

export type SessionParticipant = {
  // The backend returns a numeric primary key; we keep it loose and coerce to
  // string at the boundary for stable React keys and deterministic colours.
  userId: string | number;
  username: string;
  role: ParticipantRole;
  first_seen: string;
  last_seen: string;
  message_count: number;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) when the user
  // has uploaded an avatar; null/undefined falls back to the coloured initial.
  avatarUrl?: string | null;
};

export type AgentKind = 'model' | 'subagent';

export type SessionAgent = {
  agent_name: string;
  agent_kind: AgentKind;
  invocation_count: number;
};

export type ProjectParticipants = {
  users: SessionParticipant[];
  agents: SessionAgent[];
};

export type AsyncResourceStatus = 'idle' | 'loading' | 'success' | 'error';
