import express, { type Request, type Response } from 'express';

import { antigravityActiveModelService } from '@/modules/providers/services/antigravity-active-model.service.js';
import { claudeUsageService } from '@/modules/providers/services/claude-usage.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerCredentialsService } from '@/modules/providers/services/provider-credentials.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { workflowStatusService } from '@/modules/providers/services/workflow-status.service.js';
import { coerceUserId } from '@/modules/projects/index.js';
import type {
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderChangeActiveModelInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse, isCliInstalled } from '@/shared/utils.js';

const router = express.Router();

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

// Pulls the authenticated user id off the request. `req.user` is populated by the
// authenticateToken middleware that guards this whole router (see index.js mount).
// A null id maps the per-user secrets store to its single-operator shared file.
const readAuthenticatedUserId = (req: Request): string | number | null =>
  (req as Request & { user?: { id?: string | number } }).user?.id ?? null;

// Normalized numeric id of the authenticated caller, or null when unresolved.
// Used by ownership-gated session reads (B-105) where the value must be a DB
// user id, not the raw secrets-store key. `req.user` is set by authenticateToken
// (the whole router is mounted behind it), so a null here means no usable
// identity and the gate downstream refuses access fail-closed.
const readRequesterUserId = (req: Request): number | null =>
  coerceUserId((req as Request & { user?: { id?: string | number } }).user?.id ?? null);

// Reads the raw API key from a key-set body without ever logging or echoing it.
// Presence/emptiness is enforced by the service so the 400 contract lives in one place.
const readApiKeyFromBody = (payload: unknown): unknown => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  return (payload as Record<string, unknown>).apiKey;
};

// Reads the authenticated caller's role (owner/admin/member). Set by
// authenticateToken alongside req.user.id. Absent → treated as no elevated role.
const readAuthenticatedUserRole = (req: Request): string | null =>
  (req as Request & { user?: { role?: string } }).user?.role ?? null;

// Optional credential target (opencode: anthropic|openai|openrouter). Read from
// the body on writes and from the query string on read/delete. Absent → the
// writer's default target.
const readOptionalTarget = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

// Enforces the T-866 authorization gate: a write that would touch the OPERATOR's
// shared credentials (provider not isolated per policy) is restricted to
// owner/admin. Isolated per-user writes are allowed for any authenticated
// member (their own tree — userId comes from the token only). Throws 403.
const assertCredentialWriteAllowed = (req: Request, provider: string): void => {
  if (!providerCredentialsService.requiresElevatedRole(provider)) {
    return;
  }
  const role = readAuthenticatedUserRole(req);
  if (role !== 'owner' && role !== 'admin') {
    throw new AppError('Configuring shared provider credentials requires an admin or owner.', {
      code: 'CREDENTIAL_WRITE_FORBIDDEN',
      statusCode: 403,
    });
  }
};

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

const readOptionalQueryString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const parseOptionalBooleanQuery = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new AppError(`${name} must be "true" or "false".`, {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

const parseMcpTransport = (value: unknown): McpTransport => {
  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    throw new AppError('transport is required.', {
      code: 'MCP_TRANSPORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalized === 'stdio' || normalized === 'http' || normalized === 'sse') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP transport "${normalized}".`, {
    code: 'INVALID_MCP_TRANSPORT',
    statusCode: 400,
  });
};

const parseMcpUpsertPayload = (payload: unknown): UpsertProviderMcpServerInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const name = readOptionalQueryString(body.name);
  if (!name) {
    throw new AppError('name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const transport = parseMcpTransport(body.transport);
  const scope = parseMcpScope(body.scope);
  const workspacePath = readOptionalQueryString(body.workspacePath);

  return {
    name,
    transport,
    scope,
    workspacePath,
    command: readOptionalQueryString(body.command),
    args: Array.isArray(body.args) ? body.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
    env: typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    cwd: readOptionalQueryString(body.cwd),
    url: readOptionalQueryString(body.url),
    headers: typeof body.headers === 'object' && body.headers !== null
      ? Object.fromEntries(
        Object.entries(body.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    bearerTokenEnvVar: readOptionalQueryString(body.bearerTokenEnvVar),
    envHttpHeaders: typeof body.envHttpHeaders === 'object' && body.envHttpHeaders !== null
      ? Object.fromEntries(
        Object.entries(body.envHttpHeaders as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
  };
};

const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'cursor'
    || normalized === 'gemini'
    || normalized === 'antigravity'
    || normalized === 'opencode'
    || normalized === 'hermes'
    || normalized === 'kimi'
    || normalized === 'deepseek'
    || normalized === 'glm'
    || normalized === 'sakana'
  ) {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

const parseSessionSearchQuery = (value: unknown): string => {
  const query = readOptionalQueryString(value) ?? '';
  if (query.length < 2) {
    throw new AppError('Query must be at least 2 characters', {
      code: 'INVALID_SEARCH_QUERY',
      statusCode: 400,
    });
  }

  return query;
};

const parseSessionSearchLimit = (value: unknown): number => {
  const raw = readOptionalQueryString(value);
  if (!raw) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('limit must be a valid integer.', {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return Math.max(1, Math.min(parsed, 100));
};

// ----------------- Claude usage route -----------------
// Specific path declared before the generic `/:provider/*` routes so it is not
// shadowed. Calls Anthropic from the backend only; the OAuth token never leaves
// the server. Cached >= 180s per resolved credential with stale fallback on 429.
// The authenticated user is forwarded so an isolated user sees THEIR own
// subscription usage, not the operator's (ADR-014).
router.get(
  '/claude/usage',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const userId = (req as Request & { user?: { id?: string | number } }).user?.id ?? null;
      const usage = await claudeUsageService.getUsage(userId);
      res.json(usage);
    } catch (error) {
      // Emit the flat frontend error contract `{ error, code }` with a real
      // status (never a silent 500). User-facing messages stay generic.
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      res.status(502).json({
        error: 'Claude usage is currently unavailable.',
        code: 'CLAUDE_USAGE_UNAVAILABLE',
      });
    }
  }),
);

// ----------------- Antigravity active-model route -----------------
// Specific path declared before the generic `/:provider/*` routes so it is not
// shadowed. Read-only: reflects the model the agy CLI last propagated to its
// backend (parsed from the session log). Never changes the selection.
router.get(
  '/antigravity/active-model',
  asyncHandler(async (_req: Request, res: Response) => {
    const activeModel = await antigravityActiveModelService.getActiveModel();
    res.json(activeModel);
  }),
);

// ----------------- Active background workflows (ADR-053, T-53-B3) -----------------
// Specific path declared BEFORE the generic `/:provider/*` routes so it is not
// shadowed. Read-only visibility for B-103: the caller's still-running / orphaned
// background workflows across the sessions they own, with the declared scan cap
// surfaced in the envelope. Fail-closed — `readRequesterUserId` returns a real DB
// user id or null; a null caller yields an empty envelope and NO scan, so an
// unowned session's workflow can never leak. The whole router sits behind
// authenticateToken (mounted in index.js), so `req.user` is the authenticated
// caller. Never throws: the service degrades to an empty envelope on any anomaly.
router.get(
  '/workflows/active',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readRequesterUserId(req);
    const result = await workflowStatusService.getActiveWorkflows(userId);
    res.json(result);
  }),
);

const parseChangeActiveModelPayload = (payload: unknown): ProviderChangeActiveModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return {
    sessionId: '',
    model,
  };
};

const STUB_CLI_PROVIDERS = new Set<string>();
// Only providers with NO real backend registration belong here. kimi/deepseek/glm
// are now fully-registered hosted vendor providers (VendorAuthProvider reads the
// encrypted per-user secrets store), so they must fall through to the real
// getProviderAuthStatus path below — never short-circuit as stubs. `sakana`
// remains a union-only placeholder with no provider folder/registry entry.
const STUB_API_PROVIDERS = new Set<string>(['sakana']);

router.get(
  '/:provider/auth/status',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = (req as Request & { user?: { id?: string | number } }).user?.id ?? null;

    // Stub CLI providers: check installation only — no registry entry yet.
    if (STUB_CLI_PROVIDERS.has(provider)) {
      const installed = isCliInstalled(provider);
      res.json(createApiSuccessResponse({
        installed,
        authenticated: false,
        email: null,
        method: null,
        provider,
        error: installed ? 'Authentication not yet supported' : `${provider} is not installed`,
      }));
      return;
    }

    // Stub API providers: no CLI to probe — always not-configured.
    if (STUB_API_PROVIDERS.has(provider)) {
      res.json(createApiSuccessResponse({
        installed: false,
        authenticated: false,
        email: null,
        method: null,
        provider,
        error: 'Configure via Setup tab',
      }));
      return;
    }

    // Pass the authenticated user so credential-isolating providers report the
    // status of THIS user's resolved environment (CLAUDE_CONFIG_DIR), not the
    // operator's fixed home. `req.user` is set by authenticateToken middleware.
    // `userId` is already resolved at the top of this handler.
    const status = await providerAuthService.getProviderAuthStatus(provider, userId);
    res.json(createApiSuccessResponse(status));
  }),
);

// ----------------- Provider API-key management routes (T-866) -----------------
// Generalized per-user CRUD over provider credentials. Dispatch (in
// provider-credentials.service) is one of three cases per provider:
//   - facet  (claude/codex/opencode): the key is merged into that provider's OWN
//            credential file inside the caller's resolved (isolated) tree;
//   - vendor (kimi/deepseek/glm): the legacy encrypted per-user secrets store;
//   - none   (hermes/cursor/antigravity/gemini): 400 TERMINAL_ONLY.
// The whole router sits behind authenticateToken, so userId is the caller's and
// keys are isolated per user. These routes NEVER return or log the key value —
// only `{ provider, configured }`. Once a key is set, GET /:provider/auth/status
// flips authenticated=true (the auth facet reads the same surface).
//
// Authorization: a write that would touch the OPERATOR's shared credentials
// (provider marked 'shared'/unenrolled in the sharing policy) is restricted to
// owner/admin (403 otherwise); isolated per-user writes are open to any member
// for their OWN tree. Terminal-only providers short-circuit to 400 before any
// role/DB check.

// POST and PUT are equivalent here: both upsert the key (set-or-replace).
const setProviderApiKey = asyncHandler(async (req: Request, res: Response) => {
  const provider = parseProvider(req.params.provider);
  if (providerCredentialsService.getCapability(provider).method === 'none') {
    throw new AppError(`Provider "${provider}" is configured from the terminal only.`, {
      code: 'TERMINAL_ONLY',
      statusCode: 400,
    });
  }
  assertCredentialWriteAllowed(req, provider);
  const userId = readAuthenticatedUserId(req);
  const apiKey = readApiKeyFromBody(req.body);
  const target = readOptionalTarget((req.body as Record<string, unknown> | undefined)?.target);
  const result = await providerCredentialsService.setKey(userId, provider, apiKey, target);
  res.json(createApiSuccessResponse(result));
});

router.post('/:provider/api-key', setProviderApiKey);
router.put('/:provider/api-key', setProviderApiKey);

router.delete(
  '/:provider/api-key',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    if (providerCredentialsService.getCapability(provider).method === 'none') {
      throw new AppError(`Provider "${provider}" is configured from the terminal only.`, {
        code: 'TERMINAL_ONLY',
        statusCode: 400,
      });
    }
    assertCredentialWriteAllowed(req, provider);
    const userId = readAuthenticatedUserId(req);

    const target = readOptionalTarget(req.query.target);
    const result = await providerCredentialsService.deleteKey(userId, provider, target);
    res.json(createApiSuccessResponse(result));
  }),
);

// GET reports existence only — `{ provider, configured }` — never the key.
router.get(
  '/:provider/api-key',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = readAuthenticatedUserId(req);
    const target = readOptionalTarget(req.query.target);
    const result = await providerCredentialsService.getStatus(userId, provider, target);
    res.json(createApiSuccessResponse(result));
  }),
);

// Advertises how a provider's key is configured so the UI renders the right
// entry surface: { method: 'native_file'|'cli_stdin'|'none', targets? }.
// Read-only and role-free (leaks no secret, exposes no per-user state).
router.get(
  '/:provider/api-key/capability',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const capability = providerCredentialsService.getCapability(provider);
    res.json(createApiSuccessResponse({ provider, ...capability }));
  }),
);

router.get(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const bypassCache = parseOptionalBooleanQuery(req.query.bypassCache, 'bypassCache') ?? false;
    // Forward the authenticated user so a credential-isolating provider (Claude)
    // probes its catalog under THIS user's subscription and caches it per user.
    // `req.user` is set by authenticateToken; null for anonymous/platform mode,
    // which uses the operator's shared environment (unchanged behaviour).
    const userId = (req as Request & { user?: { id?: string | number } }).user?.id ?? null;
    const result = await providerModelsService.getProviderModels(provider, { bypassCache }, userId);
    res.json(createApiSuccessResponse({ provider, models: result.models, cache: result.cache }));
  }),
);

router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const payload = parseChangeActiveModelPayload(req.body);
    const result = await providerModelsService.changeActiveModel(provider, {
      ...payload,
      sessionId,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- Skills routes -----------------
router.get(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const skills = await providerSkillsService.listProviderSkills(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

// ----------------- MCP routes -----------------
router.get(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const scope = parseMcpScope(req.query.scope);
    const userId = readAuthenticatedUserId(req);

    if (provider === 'codex' && (!scope || scope === 'user')) {
      assertCredentialWriteAllowed(req, provider);
    }

    if (scope) {
      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, { workspacePath, userId });
      res.json(createApiSuccessResponse({ provider, scope, servers }));
      return;
    }

    const groupedServers = await providerMcpService.listProviderMcpServers(provider, { workspacePath, userId });
    res.json(createApiSuccessResponse({ provider, scopes: groupedServers }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    if (provider === 'codex' && (payload.scope ?? 'project') === 'user') {
      assertCredentialWriteAllowed(req, provider);
    }
    const server = await providerMcpService.upsertProviderMcpServer(provider, {
      ...payload,
      userId: readAuthenticatedUserId(req),
    });
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const scope = parseMcpScope(req.query.scope);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    if (provider === 'codex' && (scope ?? 'project') === 'user') {
      assertCredentialWriteAllowed(req, provider);
    }
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
      userId: readAuthenticatedUserId(req),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/mcp/servers/global',
  asyncHandler(async (req: Request, res: Response) => {
    const role = readAuthenticatedUserRole(req);
    if (role !== 'owner' && role !== 'admin') {
      throw new AppError('Adding an MCP server to all providers requires an admin or owner.', {
        code: 'MCP_GLOBAL_WRITE_FORBIDDEN',
        statusCode: 403,
      });
    }
    const payload = parseMcpUpsertPayload(req.body);
    if (payload.scope === 'local') {
      throw new AppError('Global MCP add supports only "user" or "project" scopes.', {
        code: 'INVALID_GLOBAL_MCP_SCOPE',
        statusCode: 400,
      });
    }

    // Forward the authenticated caller so per-user-isolated providers (e.g.
    // codex writing into the caller's CODEX_HOME) target THIS user's tree
    // rather than the operator's. userId is token-sourced only, never trusted
    // from the body. The service spreads it into each provider's upsertServer.
    const results = await providerMcpService.addMcpServerToAllProviders({
      ...payload,
      scope: payload.scope === 'user' ? 'user' : 'project',
      userId: readAuthenticatedUserId(req),
    });
    res.status(201).json(createApiSuccessResponse({ results }));
  }),
);

// ----------------- Session routes -----------------
router.get(
  '/sessions/archived',
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = sessionsService.listArchivedSessions();
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, {
      force,
      deletedFromDisk,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.restoreSessionById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const result = sessionsService.renameSessionById(sessionId, summary);
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/:sessionId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const limitRaw = readOptionalQueryString(req.query.limit);
    const offsetRaw = readOptionalQueryString(req.query.offset);

    let limit: number | null = null;
    if (limitRaw !== undefined) {
      const parsedLimit = Number.parseInt(limitRaw, 10);
      if (Number.isNaN(parsedLimit) || parsedLimit < 0) {
        throw new AppError('limit must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      limit = parsedLimit;
    }

    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsedOffset = Number.parseInt(offsetRaw, 10);
      if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
        throw new AppError('offset must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      offset = parsedOffset;
    }

    const result = await sessionsService.fetchHistory(sessionId, readRequesterUserId(req), {
      limit,
      offset,
    });
    res.json(result);
  }),
);

router.get('/search/sessions', asyncHandler(async (req: Request, res: Response) => {
  const query = parseSessionSearchQuery(req.query.q);
  const limit = parseSessionSearchLimit(req.query.limit);
  // Authorization scope for the search (B-106, widened by B-111): only sessions
  // the caller may see are ever scanned or streamed — those they participate in
  // OR that live in a project visible to them (public / shared / owned), the
  // same predicate the sidebar list layer uses. A private project the caller is
  // not a member of stays excluded (B-106 isolation preserved). Resolved from
  // req.user (set by authenticateToken guarding this router); null here means no
  // usable identity → zero results.
  const requesterUserId = readRequesterUserId(req);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abortController = new AbortController();
  req.on('close', () => {
    closed = true;
    abortController.abort();
  });

  try {
    await sessionConversationsSearchService.search({
      query,
      limit,
      requesterUserId,
      signal: abortController.signal,
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }

        if (projectResult) {
          res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
          return;
        }

        res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
      },
    });

    if (!closed) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (error) {
    console.error('Error searching conversations:', error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));

export default router;
