import type { McpFormState, McpProvider, McpScope, McpTransport } from './types';

// `antigravity` entries below are placeholders. The provider is declared in
// the LLMProvider union before its UI integration lands; these literals only
// exist to satisfy the exhaustive `Record<McpProvider, X>` type constraint.

export const MCP_PROVIDER_NAMES: Record<McpProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
};

// Hosted vendor providers (kimi/deepseek/glm) are remote HTTP APIs with no
// local MCP config store, so — like antigravity — they support no MCP scopes or
// transports (see VendorMcpProvider). The entries exist only to satisfy the
// exhaustive Record<McpProvider, X> constraint; the empty lists hide MCP for them.
export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude: ['user', 'project', 'local'],
  cursor: ['user', 'project'],
  codex: ['user', 'project'],
  gemini: ['user', 'project'],
  antigravity: [],
  opencode: ['user', 'project'],
  kimi: [],
  deepseek: [],
  glm: [],
};

export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  cursor: ['stdio', 'http'],
  codex: ['stdio', 'http'],
  gemini: ['stdio', 'http', 'sse'],
  antigravity: [],
  opencode: ['stdio', 'http'],
  kimi: [],
  deepseek: [],
  glm: [],
};

export const MCP_GLOBAL_SUPPORTED_SCOPES: McpScope[] = ['user', 'project'];

export const MCP_GLOBAL_SUPPORTED_TRANSPORTS: McpTransport[] = ['stdio', 'http'];

export const MCP_PROVIDER_BUTTON_CLASSES: Record<McpProvider, string> = {
  claude: 'bg-purple-600 text-white hover:bg-purple-700',
  cursor: 'bg-purple-600 text-white hover:bg-purple-700',
  codex: 'bg-gray-800 text-white hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600',
  gemini: 'bg-blue-600 text-white hover:bg-blue-700',
  antigravity: 'bg-slate-600 text-white hover:bg-slate-700',
  opencode: 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-700 dark:hover:bg-zinc-600',
  kimi: 'bg-rose-600 text-white hover:bg-rose-700',
  deepseek: 'bg-sky-600 text-white hover:bg-sky-700',
  glm: 'bg-violet-600 text-white hover:bg-violet-700',
};

export const MCP_SUPPORTS_WORKING_DIRECTORY: Record<McpProvider, boolean> = {
  claude: false,
  cursor: false,
  codex: true,
  gemini: true,
  antigravity: false,
  opencode: false,
  kimi: false,
  deepseek: false,
  glm: false,
};

export const DEFAULT_MCP_FORM: McpFormState = {
  name: '',
  scope: 'user',
  workspacePath: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
};
