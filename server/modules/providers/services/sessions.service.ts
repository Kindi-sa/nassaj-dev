import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  hashMessageAuthorContent,
  messageAuthorsDb,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import type { MessageAuthorRow } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Stamps sender identity onto messages loaded from provider history
 * (B-MU-UX-FIX-MSG-AUTHOR + B-MU-UX-FIX-ASSISTANT-AUTHOR).
 *
 * The run path records one message_authors row per sent prompt (sidecar
 * attribution — the transcript itself is written by the provider CLI/SDK and
 * carries no identity). This pass walks the transcript in order and:
 *
 * 1. user messages — each kind:'text' role:'user' message is matched back to a
 *    recorded row by content hash; when the same text was recorded more than
 *    once (e.g. two users sent identical prompts) the row closest in time wins
 *    and is consumed so the next identical message maps to the next row. The
 *    matched author is stamped as `userId`.
 * 2. assistant messages — every assistant-authored message inherits the
 *    coordinator of the most recent preceding attributed user prompt as
 *    `coordinatorId`. A run's assistant output always follows the prompt that
 *    spawned it in transcript order, so the running "current coordinator"
 *    correctly attributes the reply without a second sidecar table.
 *
 * Messages with no resolvable author (recorded before attribution existed,
 * provider-rewritten prompts, or assistant output before the first attributed
 * prompt) keep no userId/coordinatorId — clients fall back to the session owner.
 *
 * Mutates `messages` in place; never throws (attribution is best-effort and
 * must not break history loading).
 */
function stampMessageAuthors(sessionId: string, messages: NormalizedMessage[]): void {
  let authorRows: MessageAuthorRow[];
  try {
    authorRows = messageAuthorsDb.listBySession(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to load message authors for history stamping', { sessionId, error: message });
    return;
  }
  if (authorRows.length === 0) {
    return;
  }
  applyMessageAuthorAttribution(messages, authorRows);
}

/**
 * Pure transcript-walk that applies user/coordinator attribution given the
 * session's recorded author rows. Separated from the DB read so it can be unit
 * tested in isolation. Mutates `messages` in place. See stampMessageAuthors for
 * the full attribution contract.
 */
export function applyMessageAuthorAttribution(
  messages: NormalizedMessage[],
  authorRows: MessageAuthorRow[],
): void {
  const candidatesByHash = new Map<string, MessageAuthorRow[]>();
  for (const row of authorRows) {
    const list = candidatesByHash.get(row.contentHash);
    if (list) {
      list.push(row);
    } else {
      candidatesByHash.set(row.contentHash, [row]);
    }
  }

  // Coordinator carried forward in transcript order: assistant output is
  // attributed to whoever spawned the most recent attributed user prompt.
  let currentCoordinator: number | null = null;

  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'user') {
      if (message.originKind) {
        // Machine-routed prompt (coordinator → subagent, peer, channel…):
        // never attribute it to a human — even if its text coincidentally
        // hash-matches a recorded human prompt — and never adopt it as the
        // running coordinator for subsequent assistant output.
        continue;
      }
      if (message.userId != null) {
        // Already attributed (live-stamped echo) — adopt it as the coordinator
        // for any assistant output that follows.
        currentCoordinator = message.userId;
        continue;
      }
      const content = typeof message.content === 'string' ? message.content : '';
      if (!content.trim()) {
        continue;
      }

      const candidates = candidatesByHash.get(hashMessageAuthorContent(content));
      if (!candidates || candidates.length === 0) {
        continue;
      }

      // Closest recorded timestamp wins when several rows share the hash.
      let bestIndex = 0;
      const messageTime = Date.parse(message.timestamp);
      if (candidates.length > 1 && Number.isFinite(messageTime)) {
        let bestDelta = Number.POSITIVE_INFINITY;
        for (let index = 0; index < candidates.length; index++) {
          const rowTime = Date.parse(candidates[index].createdAt);
          const delta = Number.isFinite(rowTime)
            ? Math.abs(rowTime - messageTime)
            : Number.POSITIVE_INFINITY;
          if (delta < bestDelta) {
            bestDelta = delta;
            bestIndex = index;
          }
        }
      }

      message.userId = candidates[bestIndex].userId;
      currentCoordinator = candidates[bestIndex].userId;
      // Consume the matched row (but always keep the last one) so repeated
      // identical texts map one-to-one while a lone row still covers transcript
      // echoes of the same prompt.
      if (candidates.length > 1) {
        candidates.splice(bestIndex, 1);
      }
      continue;
    }

    // Assistant-authored output: inherit the active coordinator. Only stamp when
    // known and not already present, so a future live-stamped coordinatorId
    // (should one ever reach this path) is never overwritten.
    if (message.role !== 'user' && currentCoordinator != null && message.coordinatorId == null) {
      message.coordinatorId = currentCoordinator;
    }
  }
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Fetches persisted history by session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
    });

    // Sender attribution for multi-user sessions: providers normalize history
    // without identity (the transcript has none), so the sidecar stamping runs
    // here — the single choke point every history read flows through.
    stampMessageAuthors(sessionId, result.messages);

    return result;
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
