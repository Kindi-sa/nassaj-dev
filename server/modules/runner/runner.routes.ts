/**
 * RUNNER BRIDGE API ROUTES
 * ========================
 *
 * The browser's only path to the runner. READ the merged status, WRITE control
 * files (start/stop/pause/resume/approve). Mounted at /api/runner.
 *
 * Architectural contract: ADR-RUNNER-BRIDGE-001. Control flows ONE direction —
 * the bridge writes control files and reads state files; the runner reads
 * control files and writes state files. Neither imports the other.
 *
 * Resilience: GET never 500s on a missing/corrupt runner file (returns
 * { registered:false } / per-file flags). projectId that does not exist in the
 * DB is a 404. A project that exists but has no runner registry entry returns
 * 200 { registered:false } for GET and 404 for the control verbs.
 */

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';

import {
  approveNextPhase,
  pauseRunner,
  readRunnerStatus,
  resolveRunnerProject,
  resumeRunner,
  startRunner,
  stopRunner,
} from './runner-bridge.service.js';
import { broadcastNow, ensureRunnerWatcher } from './runner-watcher.service.js';

const router = express.Router();

/**
 * Owner/admin gate for the control verbs (start/stop/pause/resume/approve).
 * These write control files that launch self-driving `claude -p` sessions which
 * consume Anthropic quota, mutate the repo and approve phase transitions — the
 * contract describes the actor as "the owner". GET stays open to any
 * authenticated user (read-only status). On a multi-user instance this stops a
 * plain user from driving any project's runner (ADR-RUNNER-BRIDGE-001).
 *
 * The gate is supplied by the caller (server/index.js mounts requireRole there)
 * to keep this module free of a direct middleware import — backend boundaries
 * route cross-cutting middleware through the app entry, not module routers.
 * Defaults to DENY (403): if the app entry ever forgets to inject the real gate,
 * the control verbs fail closed rather than silently open the self-driving runner
 * to any authenticated user. index.js always injects requireRole('owner','admin')
 * at mount; tests inject their own. Fail-closed is the safe default for a
 * state-changing security boundary.
 */
export type RunnerControlGuard = express.RequestHandler;

const denyGuard: RunnerControlGuard = (_req, res) => {
  res.status(403).json({ error: 'Runner control gate not configured' });
};

let requireRunnerControl: RunnerControlGuard = denyGuard;

/** Inject the owner/admin gate from the app entry (server/index.js). */
export function setRunnerControlGuard(guard: RunnerControlGuard): void {
  requireRunnerControl = guard;
}

/** Wrapper so the guard is resolved per-request (after setRunnerControlGuard). */
const controlGuard: express.RequestHandler = (req, res, next) =>
  requireRunnerControl(req, res, next);

type AuthenticatedRequest = express.Request & {
  user?: { id?: number | string; username?: string; role?: string };
};

/** Express route params are typed string | string[]; the board id is a scalar. */
function paramProjectId(req: express.Request): string {
  const value = req.params.projectId;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * GET /api/runner/:projectId
 * Canonical status the overlay renders. Resilience-wrapped.
 */
router.get('/:projectId', async (req, res) => {
  try {
    const projectId = paramProjectId(req);
    const projectPath = projectsDb.getProjectPathById(projectId);
    if (!projectPath) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const status = await readRunnerStatus(projectId);

    // Start the WS watcher only once the project is actually registered.
    if (status.registered && status.name) {
      ensureRunnerWatcher(projectId, status.name, req.app.locals.wss);
    }

    res.json(status);
  } catch (error) {
    console.error('Error building runner status response:', error);
    // Never 500 the overlay: degrade to "not registered".
    res.json({
      registered: false,
      name: null,
      dir: null,
      enabled: null,
      priority: null,
      paused: false,
      cycle: null,
      activity: null,
      verdict: null,
      config: null,
      stateError: true,
    });
  }
});

/**
 * Resolve the runner project for a control verb, or send the right error.
 * Returns null after responding when resolution fails.
 */
async function resolveOr404(
  req: express.Request,
  res: express.Response,
): Promise<{ name: string } | null> {
  const projectId = paramProjectId(req);
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  const resolved = await resolveRunnerProject(projectId);
  if (!resolved) {
    res.status(404).json({ error: 'Runner not configured for this project' });
    return null;
  }
  return { name: resolved.name };
}

/** Refetch-and-return the merged state after a control write. */
async function respondWithState(req: express.Request, res: express.Response): Promise<void> {
  const projectId = paramProjectId(req);
  broadcastNow(req.app.locals.wss, projectId);
  const status = await readRunnerStatus(projectId);
  res.json(status);
}

/** POST /api/runner/:projectId/start — registry.enabled = true. */
router.post('/:projectId/start', controlGuard, async (req, res) => {
  const resolved = await resolveOr404(req, res);
  if (!resolved) return;
  const ok = await startRunner(resolved.name);
  if (!ok) {
    return res.status(404).json({ error: 'No registry entry for this project' });
  }
  await respondWithState(req, res);
});

/** POST /api/runner/:projectId/stop — registry.enabled = false (hard disable). */
router.post('/:projectId/stop', controlGuard, async (req, res) => {
  const resolved = await resolveOr404(req, res);
  if (!resolved) return;
  const ok = await stopRunner(resolved.name);
  if (!ok) {
    return res.status(404).json({ error: 'No registry entry for this project' });
  }
  await respondWithState(req, res);
});

/** POST /api/runner/:projectId/pause — create the pause control file. */
router.post('/:projectId/pause', controlGuard, async (req, res) => {
  const resolved = await resolveOr404(req, res);
  if (!resolved) return;
  const user = (req as AuthenticatedRequest).user;
  await pauseRunner(resolved.name, user?.username ?? String(user?.id ?? 'owner'));
  await respondWithState(req, res);
});

/** POST /api/runner/:projectId/resume — remove the pause control file. */
router.post('/:projectId/resume', controlGuard, async (req, res) => {
  const resolved = await resolveOr404(req, res);
  if (!resolved) return;
  await resumeRunner(resolved.name);
  await respondWithState(req, res);
});

/**
 * POST /api/runner/:projectId/approve — create approve-next-phase.
 * 409 unless the current stage is awaiting_approval (guards a stale approval
 * from being consumed by a future awaiting_approval boundary).
 */
router.post('/:projectId/approve', controlGuard, async (req, res) => {
  const resolved = await resolveOr404(req, res);
  if (!resolved) return;

  const projectId = paramProjectId(req);
  const status = await readRunnerStatus(projectId);
  if (status.cycle?.stage !== 'awaiting_approval') {
    return res.status(409).json({
      error: 'Runner is not awaiting approval',
      stage: status.cycle?.stage ?? null,
    });
  }
  await approveNextPhase(resolved.name);
  await respondWithState(req, res);
});

export default router;
