import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { VENDOR_PROVIDERS, type VendorProvider } from '../../provider-auth/vendorProviders';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';

/**
 * The active "Claude engine on a vendor endpoint" selection (ADR-037). A vendor
 * id means the Claude engine runs against that vendor's Anthropic-compatible
 * endpoint; null is the normal official-Anthropic path.
 */
export type EngineProvider = VendorProvider | null;

const ENGINE_PROVIDER_STORAGE_KEY = 'claude-engine-provider';

/** Reads the persisted engine provider, ignoring any stale/invalid value. */
function readStoredEngineProvider(): EngineProvider {
  const stored = localStorage.getItem(ENGINE_PROVIDER_STORAGE_KEY);
  return stored && (VENDOR_PROVIDERS as readonly string[]).includes(stored)
    ? (stored as VendorProvider)
    : null;
}

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'opus',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  gemini: 'gemini-3.1-pro-preview',
  // Antigravity (agy) default preserved from the fork's former
  // ANTIGRAVITY_MODELS.DEFAULT; see antigravity-models.provider.ts (backend).
  antigravity: 'auto',
  opencode: 'anthropic/claude-sonnet-4-5',
  // Hosted vendor defaults mirror the backend <ID>_FALLBACK_MODELS.DEFAULT in
  // shared/vendor/vendor-config.ts; the live /v1/models catalog overrides these.
  kimi: 'kimi-k2.6',
  deepseek: 'deepseek-v4-pro',
  glm: 'glm-5.2',
};

const getPermissionModesForProvider = (provider: LLMProvider): PermissionMode[] => {
  if (provider === 'codex') {
    return ['default', 'acceptEdits', 'bypassPermissions'];
  }
  if (provider === 'claude') {
    return ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'];
  }
  if (provider === 'opencode') {
    return ['default'];
  }
  return ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
};

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
}

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
    cache?: ProviderModelsCacheInfo;
  };
};

type ChangeActiveModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string;
    supported?: boolean;
    changed?: boolean;
    model?: string | null;
  };
};

export function useChatProviderState({ selectedSession, selectedProject }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<LLMProvider>(() => {
    return (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
  });
  // "Claude engine on a vendor endpoint" (ADR-037, m-FE-9). When set to a vendor
  // id (kimi/deepseek/glm) the Claude engine is driven through that vendor's
  // Anthropic-compatible endpoint: the chat keeps provider='claude' but sends
  // options.engineProvider=<p> + the vendor model id. null = the normal Claude
  // path (official Anthropic). Persisted next to selected-provider; only ever
  // meaningful while provider==='claude'.
  const [engineProvider, setEngineProvider] = useState<EngineProvider>(() => {
    return readStoredEngineProvider();
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return localStorage.getItem('cursor-model') || FALLBACK_DEFAULT_MODEL.cursor;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || FALLBACK_DEFAULT_MODEL.claude;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || FALLBACK_DEFAULT_MODEL.codex;
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return localStorage.getItem('gemini-model') || FALLBACK_DEFAULT_MODEL.gemini;
  });
  const [opencodeModel, setOpenCodeModel] = useState<string>(() => {
    return localStorage.getItem('opencode-model') || FALLBACK_DEFAULT_MODEL.opencode;
  });
  // Antigravity (agy) does not expose model selection from the UI; the real
  // model is chosen inside agy's own settings. We still carry a tiny piece of
  // state so the provider plugs into existing model-aware helpers uniformly.
  const [antigravityModel, setAntigravityModel] = useState<string>(() => {
    return localStorage.getItem('antigravity-model') || FALLBACK_DEFAULT_MODEL.antigravity;
  });
  // Hosted vendor providers (ADR-036). Selection persists in localStorage and is
  // reconciled against the live catalog below, exactly like the CLI providers.
  const [kimiModel, setKimiModel] = useState<string>(() => {
    return localStorage.getItem('kimi-model') || FALLBACK_DEFAULT_MODEL.kimi;
  });
  const [deepseekModel, setDeepSeekModel] = useState<string>(() => {
    return localStorage.getItem('deepseek-model') || FALLBACK_DEFAULT_MODEL.deepseek;
  });
  const [glmModel, setGlmModel] = useState<string>(() => {
    return localStorage.getItem('glm-model') || FALLBACK_DEFAULT_MODEL.glm;
  });

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);

  const lastProviderRef = useRef(provider);
  const providerModelsRequestIdRef = useRef(0);

  // Persisted setter for the engine provider so the choice survives reloads.
  const persistEngineProvider = useCallback((next: EngineProvider) => {
    setEngineProvider(next);
    if (next) {
      localStorage.setItem(ENGINE_PROVIDER_STORAGE_KEY, next);
    } else {
      localStorage.removeItem(ENGINE_PROVIDER_STORAGE_KEY);
    }
  }, []);

  // Selects "Claude engine on <vendor>": keeps provider='claude' but routes the
  // engine through the vendor endpoint and pins the chosen vendor model id as the
  // Claude model (passed through unchanged server-side because an engine host is
  // engaged — ADR-037). Reused by the picker.
  const selectClaudeEngineProvider = useCallback(
    (vendor: VendorProvider, model: string) => {
      setProvider('claude');
      localStorage.setItem('selected-provider', 'claude');
      persistEngineProvider(vendor);
      setClaudeModel(model);
      localStorage.setItem('claude-model', model);
    },
    [persistEngineProvider],
  );

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    if (targetProvider === 'claude') {
      setClaudeModel(model);
      localStorage.setItem('claude-model', model);
      return;
    }

    if (targetProvider === 'cursor') {
      setCursorModel(model);
      localStorage.setItem('cursor-model', model);
      return;
    }

    if (targetProvider === 'codex') {
      setCodexModel(model);
      localStorage.setItem('codex-model', model);
      return;
    }

    if (targetProvider === 'gemini') {
      setGeminiModel(model);
      localStorage.setItem('gemini-model', model);
      return;
    }

    if (targetProvider === 'kimi') {
      setKimiModel(model);
      localStorage.setItem('kimi-model', model);
      return;
    }

    if (targetProvider === 'deepseek') {
      setDeepSeekModel(model);
      localStorage.setItem('deepseek-model', model);
      return;
    }

    if (targetProvider === 'glm') {
      setGlmModel(model);
      localStorage.setItem('glm-model', model);
      return;
    }

    setOpenCodeModel(model);
    localStorage.setItem('opencode-model', model);
  }, []);

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const providers: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini', 'opencode', 'kimi', 'deepseek', 'glm'];
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    try {
      const results = await Promise.all(
        providers.map(async (p) => {
          const params = new URLSearchParams();
          if (options.bypassCache) {
            params.set('bypassCache', 'true');
          }

          const queryString = params.toString();
          const response = await authenticatedFetch(`/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`);
          const body = (await response.json()) as ProviderModelsApiResponse;
          if (!body.success || !body.data?.models || !body.data?.cache) {
            return null;
          }

          return body.data;
        }),
      );

      if (providerModelsRequestIdRef.current !== requestId) {
        return;
      }

      const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
      const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};

      providers.forEach((p, i) => {
        const entry = results[i];
        if (!entry) {
          return;
        }

        nextCatalog[p] = entry.models;
        nextCacheCatalog[p] = entry.cache;
      });

      setProviderModelCatalog(nextCatalog);
      setProviderModelCacheCatalog(nextCacheCatalog);
    } catch (error) {
      console.error('Error loading provider models:', error);
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
        setProviderModelsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = localStorage.getItem(storageKey);
    if (stored && def.OPTIONS.some((o) => o.value === stored)) {
      return stored;
    }
    if (current && def.OPTIONS.some((o) => o.value === current)) {
      return current;
    }
    return def.DEFAULT;
  };

  useEffect(() => {
    const claude = providerModelCatalog.claude;
    if (claude) {
      const next = pickStoredOrCurrent('claude-model', claudeModel, claude);
      if (next !== claudeModel) {
        setClaudeModel(next);
      }
      if (localStorage.getItem('claude-model') !== next) {
        localStorage.setItem('claude-model', next);
      }
    }
  }, [providerModelCatalog.claude, claudeModel]);

  useEffect(() => {
    const cursor = providerModelCatalog.cursor;
    if (cursor) {
      const next = pickStoredOrCurrent('cursor-model', cursorModel, cursor);
      if (next !== cursorModel) {
        setCursorModel(next);
      }
      if (localStorage.getItem('cursor-model') !== next) {
        localStorage.setItem('cursor-model', next);
      }
    }
  }, [providerModelCatalog.cursor, cursorModel]);

  useEffect(() => {
    const codex = providerModelCatalog.codex;
    if (codex) {
      const next = pickStoredOrCurrent('codex-model', codexModel, codex);
      if (next !== codexModel) {
        setCodexModel(next);
      }
      if (localStorage.getItem('codex-model') !== next) {
        localStorage.setItem('codex-model', next);
      }
    }
  }, [providerModelCatalog.codex, codexModel]);

  useEffect(() => {
    const gemini = providerModelCatalog.gemini;
    if (gemini) {
      const next = pickStoredOrCurrent('gemini-model', geminiModel, gemini);
      if (next !== geminiModel) {
        setGeminiModel(next);
      }
      if (localStorage.getItem('gemini-model') !== next) {
        localStorage.setItem('gemini-model', next);
      }
    }
  }, [providerModelCatalog.gemini, geminiModel]);

  useEffect(() => {
    const opencode = providerModelCatalog.opencode;
    if (opencode) {
      const next = pickStoredOrCurrent('opencode-model', opencodeModel, opencode);
      if (next !== opencodeModel) {
        setOpenCodeModel(next);
      }
      if (localStorage.getItem('opencode-model') !== next) {
        localStorage.setItem('opencode-model', next);
      }
    }
  }, [providerModelCatalog.opencode, opencodeModel]);

  useEffect(() => {
    const kimi = providerModelCatalog.kimi;
    if (kimi) {
      const next = pickStoredOrCurrent('kimi-model', kimiModel, kimi);
      if (next !== kimiModel) {
        setKimiModel(next);
      }
      if (localStorage.getItem('kimi-model') !== next) {
        localStorage.setItem('kimi-model', next);
      }
    }
  }, [providerModelCatalog.kimi, kimiModel]);

  useEffect(() => {
    const deepseek = providerModelCatalog.deepseek;
    if (deepseek) {
      const next = pickStoredOrCurrent('deepseek-model', deepseekModel, deepseek);
      if (next !== deepseekModel) {
        setDeepSeekModel(next);
      }
      if (localStorage.getItem('deepseek-model') !== next) {
        localStorage.setItem('deepseek-model', next);
      }
    }
  }, [providerModelCatalog.deepseek, deepseekModel]);

  useEffect(() => {
    const glm = providerModelCatalog.glm;
    if (glm) {
      const next = pickStoredOrCurrent('glm-model', glmModel, glm);
      if (next !== glmModel) {
        setGlmModel(next);
      }
      if (localStorage.getItem('glm-model') !== next) {
        localStorage.setItem('glm-model', next);
      }
    }
  }, [providerModelCatalog.glm, glmModel]);

  useEffect(() => {
    if (!selectedSession?.id) {
      return;
    }

    const savedMode = localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null;
    const validModes = getPermissionModesForProvider(provider);
    setPermissionMode(savedMode && validModes.includes(savedMode) ? savedMode : 'default');
  }, [selectedSession?.id, provider]);

  // Provider is driven solely by explicit user selection (localStorage).
  // Session's __provider is informational only — we never auto-override the
  // user's active choice when navigating to a project that has old sessions.

  useEffect(() => {
    if (lastProviderRef.current === provider) {
      return;
    }
    setPendingPermissionRequests([]);
    // Engine-on-vendor only applies to the Claude path; selecting any other
    // provider clears it so we never send a stale engineProvider with, e.g.,
    // a Gemini run. (Switching back to Claude does NOT auto-restore it.)
    if (provider !== 'claude') {
      persistEngineProvider(null);
    }
    lastProviderRef.current = provider;
  }, [provider, persistEngineProvider]);

  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedSession?.id]);

  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setStoredProviderModel(targetProvider, model);
      return {
        scope: 'default' as const,
        changed: false,
        model,
      };
    }

    const response = await authenticatedFetch(
      `/api/providers/${targetProvider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
      },
    );

    const body = (await response.json()) as ChangeActiveModelApiResponse;
    if (!response.ok || !body.success || !body.data?.supported) {
      throw new Error('Unable to change the active model for this session.');
    }

    return {
      scope: 'session' as const,
      changed: body.data.changed === true,
      model: body.data.model || model,
    };
  }, [setStoredProviderModel]);

  return {
    provider,
    setProvider,
    engineProvider,
    setEngineProvider: persistEngineProvider,
    selectClaudeEngineProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    antigravityModel,
    setAntigravityModel,
    opencodeModel,
    setOpenCodeModel,
    kimiModel,
    setKimiModel,
    deepseekModel,
    setDeepSeekModel,
    glmModel,
    setGlmModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
  };
}
