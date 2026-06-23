import { AppError } from '@/shared/utils.js';
import type {
  IProvider,
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  McpScope,
  NormalizedMessage,
  ProviderMcpServer,
  ProviderSkill,
  ProviderSkillListOptions,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { HermesProviderAuth } from './hermes-auth.provider.js';
import { CLAUDE_FALLBACK_MODELS } from '../claude/claude-models.provider.js';

const notSupported = (method: string): never => {
  throw new AppError(`Hermes provider: ${method} is not yet implemented.`, {
    code: 'NOT_IMPLEMENTED',
    statusCode: 501,
  });
};

class HermesModels implements IProviderModels {
  async getSupportedModels() { return { ...CLAUDE_FALLBACK_MODELS, degraded: true as const }; }
  async getCurrentActiveModel() { return { model: 'default', source: 'fallback' as const }; }
  async changeActiveModel() { return notSupported('changeActiveModel'); }
}

class HermesMcp implements IProviderMcp {
  async listServers(): Promise<Record<McpScope, ProviderMcpServer[]>> {
    return { user: [], local: [], project: [] };
  }
  async listServersForScope(): Promise<ProviderMcpServer[]> { return []; }
  async upsertServer(_input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    return notSupported('upsertServer');
  }
  async removeServer() { return notSupported('removeServer'); }
}

class HermesSkills implements IProviderSkills {
  async listSkills(_options?: ProviderSkillListOptions): Promise<ProviderSkill[]> { return []; }
}

class HermesSessions implements IProviderSessions {
  normalizeMessage(_raw: unknown, _sessionId: string | null): NormalizedMessage[] { return []; }
  async fetchHistory(_sessionId: string, _options?: FetchHistoryOptions): Promise<FetchHistoryResult> {
    return notSupported('fetchHistory');
  }
}

class HermesSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(): Promise<number> { return 0; }
  async synchronizeFile(): Promise<string | null> { return null; }
}

export class HermesProvider implements IProvider {
  readonly id = 'hermes' as const;
  readonly auth: IProviderAuth = new HermesProviderAuth();
  readonly models: IProviderModels = new HermesModels();
  readonly mcp: IProviderMcp = new HermesMcp();
  readonly skills: IProviderSkills = new HermesSkills();
  readonly sessions: IProviderSessions = new HermesSessions();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new HermesSessionSynchronizer();
}
