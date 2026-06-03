import type {
  IProvider,
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';
import type {
  FetchHistoryResult,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  ProviderAuthStatus,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderMcpServer,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
  ProviderSkill,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Fail-safe provider stub for a temporarily-disabled provider.
 *
 * Registered in `provider.registry` under the disabled provider's key so that
 * `resolveProvider(<key>)` keeps returning a concrete `IProvider` instead of
 * throwing `UNSUPPORTED_PROVIDER`. Existing sessions for the disabled provider
 * (e.g. agy/antigravity sessions persisted in the DB) therefore resume into a
 * graceful "temporarily disabled" state rather than a runtime 400/500.
 *
 * Every read operation degrades gracefully (empty catalog/lists/history, an
 * `installed: false` auth status). Every write/mutation operation throws a
 * single, explicit `PROVIDER_TEMPORARILY_DISABLED` AppError (400) with a
 * user-facing-safe message — never an `UNSUPPORTED_PROVIDER`, never a silent
 * 500. UI surfaces the disabled state from the read paths; explicit attempts
 * to act on the provider get a clear, contained error.
 */
export class DisabledProvider implements IProvider {
  readonly id: LLMProvider;
  readonly models: IProviderModels;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;

  /**
   * @param id     the provider key this stub stands in for (e.g. 'antigravity')
   * @param reason short, user-facing-safe disabled reason for write attempts
   */
  constructor(id: LLMProvider, reason = 'This provider is temporarily disabled.') {
    this.id = id;

    const disabledError = (): AppError =>
      new AppError(reason, {
        code: 'PROVIDER_TEMPORARILY_DISABLED',
        statusCode: 400,
      });

    const emptyModels: ProviderModelsDefinition = { OPTIONS: [], DEFAULT: '' };

    this.models = {
      // Read paths degrade gracefully so model pickers render an empty,
      // clearly-disabled catalog instead of crashing.
      async getSupportedModels(): Promise<ProviderModelsDefinition> {
        return emptyModels;
      },
      async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
        return { model: '' };
      },
      async changeActiveModel(
        _input: ProviderChangeActiveModelInput,
      ): Promise<ProviderSessionActiveModelChange> {
        // Session-scoped override write: report unsupported (provider off)
        // instead of throwing so the resume path stays graceful.
        return {
          provider: id,
          sessionId: _input.sessionId,
          supported: false,
          changed: false,
          model: null,
        };
      },
    };

    this.auth = {
      async getStatus(): Promise<ProviderAuthStatus> {
        return {
          installed: false,
          provider: id,
          authenticated: false,
          email: null,
          method: null,
          error: reason,
        };
      },
    };

    this.skills = {
      async listSkills(): Promise<ProviderSkill[]> {
        return [];
      },
    };

    this.mcp = {
      async listServers(): Promise<Record<McpScope, ProviderMcpServer[]>> {
        return { user: [], local: [], project: [] };
      },
      async listServersForScope(): Promise<ProviderMcpServer[]> {
        return [];
      },
      async upsertServer(_input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
        throw disabledError();
      },
      async removeServer(input: {
        name: string;
        scope?: McpScope;
        workspacePath?: string;
      }): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
        return { removed: false, provider: id, name: input.name, scope: input.scope ?? 'user' };
      },
    };

    this.sessions = {
      // Existing agy/antigravity sessions resume here: return empty/no history
      // gracefully so the UI shows the session as disabled, never a 400/500.
      normalizeMessage(_raw: unknown, _sessionId: string | null): NormalizedMessage[] {
        return [];
      },
      async fetchHistory(): Promise<FetchHistoryResult> {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    };

    this.sessionSynchronizer = {
      // Background scan loop calls this for every registered provider; a
      // disabled provider indexes nothing and reports zero processed.
      async synchronize(): Promise<number> {
        return 0;
      },
      async synchronizeFile(): Promise<string | null> {
        return null;
      },
    };
  }
}
