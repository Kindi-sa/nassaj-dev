/**
 * Participant tracking routes (mounted at /api/sessions).
 *
 *   GET /api/sessions/:sessionId/participants  → human participants of a session
 *   GET /api/sessions/:sessionId/agents        → model + subagents of a session
 *
 * Both are auth-protected by the mount point in index.js. Handlers stay thin:
 * validate the sessionId, delegate to participantsService, shape the response.
 */

import express, { type Request, type Response } from 'express';

import { participantsService } from '@/modules/providers/services/participants.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

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
