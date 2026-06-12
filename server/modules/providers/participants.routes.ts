/**
 * Participant tracking routes (mounted at /api/sessions).
 *
 *   GET  /api/sessions/starred                 → the caller's starred sessions
 *   POST /api/sessions/star                     → star/unstar a session for the caller
 *   GET  /api/sessions/:sessionId/participants  → human participants of a session
 *   GET  /api/sessions/:sessionId/agents        → model + subagents of a session
 *
 * All are auth-protected by the mount point in index.js. Handlers stay thin:
 * validate input, delegate to the relevant service/repository, shape response.
 */

import express, { type Request, type Response } from 'express';

import { starredSessionsDb } from '@/modules/database/index.js';
import { participantsService } from '@/modules/providers/services/participants.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._/-]{1,400}$/;

function parseSessionId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!SESSION_ID_PATTERN.test(raw)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }
  return raw;
}

/** Optional projectName from a request body; null when absent, validated when present. */
function parseOptionalProjectName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!PROJECT_NAME_PATTERN.test(raw)) {
    throw new AppError('Invalid projectName.', {
      code: 'INVALID_PROJECT_NAME',
      statusCode: 400,
    });
  }
  return raw;
}

type AuthenticatedUser = { id?: number | string };

/**
 * Reads the authenticated user's numeric id from req.user (set by
 * authenticateToken at the mount point). Stars are ALWAYS scoped to this id —
 * never to any user identifier taken from request input.
 */
function readAuthenticatedUserId(req: Request): number {
  const rawId = (req as Request & { user?: AuthenticatedUser }).user?.id;
  const userId =
    typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && rawId.trim() !== ''
        ? Number.parseInt(rawId, 10)
        : NaN;

  if (!Number.isInteger(userId)) {
    throw new AppError('Authentication required.', {
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

router.get(
  '/starred',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    const sessions = starredSessionsDb.listStarredSessions(userId);
    res.json(createApiSuccessResponse({ sessions }));
  })
);

router.post(
  '/star',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const sessionId = parseSessionId(body.sessionId);
    const projectName = parseOptionalProjectName(body.projectName);

    if (typeof body.starred !== 'boolean') {
      throw new AppError('Field "starred" must be a boolean.', {
        code: 'INVALID_STARRED_FLAG',
        statusCode: 400,
      });
    }

    const starred = starredSessionsDb.setStarred(userId, sessionId, body.starred, projectName);
    res.json(createApiSuccessResponse({ sessionId, projectName, starred }));
  })
);

router.get(
  '/:sessionId/participants',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const participants = participantsService.listSessionParticipants(sessionId);
    res.json(createApiSuccessResponse({ participants }));
  })
);

router.get(
  '/:sessionId/agents',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const agents = await participantsService.listSessionAgents(sessionId);
    res.json(createApiSuccessResponse({ agents }));
  })
);

export default router;
