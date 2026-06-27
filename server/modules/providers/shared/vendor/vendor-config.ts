import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';

import type { VendorTextualToolCall } from './vendor-sessions.provider.js';

/**
 * Single source of truth for the three hosted vendor providers' static runtime
 * config: the hard-coded base URL, the derived endpoints, the env var their HTTP
 * client reads, and the conservative fallback model catalog.
 *
 * BASE URLs ARE HARD-CODED HERE, NOT READ FROM ENV. This is deliberate and is
 * part of the iron-rule boundary: the only per-user value that ever flows from
 * config is the API key (injected by resolveProviderEnv as KIMI_API_KEY /
 * DEEPSEEK_API_KEY / GLM_API_KEY). No base URL is overridable, and none of these
 * values live under the ANTHROPIC/CLAUDE namespace.
 *
 * Model ids track the providers' current generation at authoring time; they are
 * only a fallback — the live `/v1/models` catalog is authoritative when reachable
 * (see VendorCatalogClient), so a newer id (e.g. a promoted code model) surfaces
 * automatically without a code change.
 */

export type VendorRuntimeConfig = {
  provider: LLMProvider;
  /** Anthropic-compatible base, ending in `/anthropic`. */
  baseUrl: string;
  /** `<baseUrl>/v1/messages` — the chat/stream endpoint the seam POSTs to. */
  messagesUrl: string;
  /** `<baseUrl>/v1/models` — the live catalog endpoint. */
  modelsUrl: string;
  /** Env var holding the API key (provider-specific, never ANTHROPIC_*). */
  keyEnv: string;
  /** Conservative built-in catalog used when the live fetch is unavailable. */
  fallbackModels: ProviderModelsDefinition;
};

const KIMI_BASE = 'https://api.moonshot.ai/anthropic';
const DEEPSEEK_BASE = 'https://api.deepseek.com/anthropic';
const GLM_BASE = 'https://api.z.ai/api/anthropic';

export const KIMI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'kimi-k2.6', label: 'Kimi K2.6', description: 'Moonshot Kimi K2.6 (256K context)' },
    { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'Moonshot Kimi K2.7 Code' },
  ],
  DEFAULT: 'kimi-k2.6',
};

export const DEEPSEEK_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'DeepSeek V4 Pro (1M context)' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'DeepSeek V4 Flash (1M context)' },
  ],
  DEFAULT: 'deepseek-v4-pro',
};

export const GLM_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'glm-5.2', label: 'GLM 5.2', description: 'Zhipu/Z.ai GLM 5.2' },
    { value: 'glm-5.2[1m]', label: 'GLM 5.2 (1M context)', description: 'Zhipu/Z.ai GLM 5.2 long context' },
  ],
  DEFAULT: 'glm-5.2',
};

export const VENDOR_RUNTIME: Record<'kimi' | 'deepseek' | 'glm', VendorRuntimeConfig> = {
  kimi: {
    provider: 'kimi',
    baseUrl: KIMI_BASE,
    messagesUrl: `${KIMI_BASE}/v1/messages`,
    modelsUrl: `${KIMI_BASE}/v1/models`,
    keyEnv: 'KIMI_API_KEY',
    fallbackModels: KIMI_FALLBACK_MODELS,
  },
  deepseek: {
    provider: 'deepseek',
    baseUrl: DEEPSEEK_BASE,
    messagesUrl: `${DEEPSEEK_BASE}/v1/messages`,
    modelsUrl: `${DEEPSEEK_BASE}/v1/models`,
    keyEnv: 'DEEPSEEK_API_KEY',
    fallbackModels: DEEPSEEK_FALLBACK_MODELS,
  },
  glm: {
    provider: 'glm',
    baseUrl: GLM_BASE,
    messagesUrl: `${GLM_BASE}/v1/messages`,
    modelsUrl: `${GLM_BASE}/v1/models`,
    keyEnv: 'GLM_API_KEY',
    fallbackModels: GLM_FALLBACK_MODELS,
  },
};

/**
 * DeepSeek quirk: ~11% of tool calls can arrive as plain assistant text that is
 * really a JSON tool_call object. This best-effort extractor recognizes a JSON
 * payload shaped like `{ "name": "...", "arguments"|"input": {...} }` (optionally
 * wrapped in a ```json fence or a <tool_call> tag) and converts it to a tool_use
 * descriptor. Anything that does not clearly look like a tool call is left as
 * ordinary text (returns null), so normal prose is never misclassified.
 */
export function extractDeepSeekTextualToolCall(text: string): VendorTextualToolCall | null {
  const trimmed = text.trim();
  if (!trimmed.includes('"name"') || (!trimmed.includes('"arguments"') && !trimmed.includes('"input"'))) {
    return null;
  }

  const candidate = unwrapToolCallCandidate(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const toolName = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null;
  if (!toolName) {
    return null;
  }

  const toolInput = record.arguments ?? record.input ?? {};
  const toolId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
  return { toolName, toolInput, toolId };
}

/** Strips a ```json fence or <tool_call> wrapper, returning the inner JSON text. */
function unwrapToolCallCandidate(text: string): string {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  const tagMatch = /<tool_call>\s*([\s\S]*?)<\/tool_call>/.exec(text);
  if (tagMatch?.[1]) {
    return tagMatch[1].trim();
  }
  return text;
}
