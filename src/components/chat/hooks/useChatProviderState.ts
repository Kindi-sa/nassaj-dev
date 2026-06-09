import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';
import {
  PROVIDER_FALLBACK_MODELS,
  sanitizeStoredModel,
  sanitizeStoredProvider,
} from '../../../constants/providerModelFallbacks';
import { pickStoredOrCurrent } from './normalizeProviderModel';

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
    return sanitizeStoredProvider(localStorage.getItem('selected-provider'));
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return sanitizeStoredModel('cursor', localStorage.getItem('cursor-model'));
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return sanitizeStoredModel('claude', localStorage.getItem('claude-model'));
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return sanitizeStoredModel('codex', localStorage.getItem('codex-model'));
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return sanitizeStoredModel('gemini', localStorage.getItem('gemini-model'));
  });
  const [opencodeModel, setOpenCodeModel] = useState<string>(() => {
    return sanitizeStoredModel('opencode', localStorage.getItem('opencode-model'));
  });
  // Antigravity (agy) does not expose model selection from the UI; the real
  // model is chosen inside agy's own settings. We still carry a tiny piece of
  // state so the provider plugs into existing model-aware helpers uniformly.
  const [antigravityModel, setAntigravityModel] = useState<string>(() => {
    return sanitizeStoredModel('antigravity', localStorage.getItem('antigravity-model'));
  });

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);
  // Set of providers whose live catalog failed to load and are currently
  // serving the embedded fallback catalog. Empty when everything loaded live.
  const [providerModelsFallbackProviders, setProviderModelsFallbackProviders] = useState<
    LLMProvider[]
  >([]);

  const lastProviderRef = useRef(provider);
  const providerModelsRequestIdRef = useRef(0);

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

    setOpenCodeModel(model);
    localStorage.setItem('opencode-model', model);
  }, []);

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const providers: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'];
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    // A single provider that errors out (HTTP failure, malformed body, or a
    // thrown fetch) must not blank the catalog for the others, and must never
    // leave a catalog entry undefined — an undefined entry disables the
    // self-sanitizer and lets stale values like "auto" leak to the server.
    // Each provider therefore resolves independently and falls back to the
    // embedded catalog on any failure.
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          const params = new URLSearchParams();
          if (options.bypassCache) {
            params.set('bypassCache', 'true');
          }

          const queryString = params.toString();
          const response = await authenticatedFetch(
            `/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`,
          );
          const body = (await response.json()) as ProviderModelsApiResponse;
          if (!response.ok || !body.success || !body.data?.models || !body.data?.cache) {
            return { provider: p, data: null as ProviderModelsApiResponse['data'] | null };
          }

          return { provider: p, data: body.data };
        } catch (error) {
          console.warn(`Failed to load live models for provider "${p}"; using fallback catalog.`, error);
          return { provider: p, data: null as ProviderModelsApiResponse['data'] | null };
        }
      }),
    );

    if (providerModelsRequestIdRef.current !== requestId) {
      return;
    }

    const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
    const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};
    const fallbackProviders: LLMProvider[] = [];

    results.forEach(({ provider: p, data }) => {
      if (data?.models && data?.cache) {
        nextCatalog[p] = data.models;
        nextCacheCatalog[p] = data.cache;
        return;
      }

      // Failed provider: keep the catalog populated with the embedded fallback
      // so the sanitizer always has a valid option list to work against.
      nextCatalog[p] = PROVIDER_FALLBACK_MODELS[p];
      fallbackProviders.push(p);
    });

    if (fallbackProviders.length > 0) {
      console.warn(
        `Provider model catalog using embedded fallback for: ${fallbackProviders.join(', ')}.`,
      );
    }

    setProviderModelCatalog(nextCatalog);
    setProviderModelCacheCatalog(nextCacheCatalog);
    setProviderModelsFallbackProviders(fallbackProviders);

    if (providerModelsRequestIdRef.current === requestId) {
      setProviderModelsLoading(false);
      setProviderModelsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  // Normalize a stored/current model against the authoritative catalog entry
  // and persist the result. The catalog is always populated (live or fallback),
  // so this runs even when the live API fails — which is what prevents a stuck
  // "auto" value from ever reaching the server.
  const reconcileProviderModel = useCallback(
    (
      storageKey: string,
      def: ProviderModelsDefinition | undefined,
      current: string,
      setter: (value: string) => void,
    ) => {
      if (!def) {
        return;
      }
      const next = pickStoredOrCurrent(localStorage.getItem(storageKey), current, def);
      if (next !== current) {
        setter(next);
      }
      if (localStorage.getItem(storageKey) !== next) {
        localStorage.setItem(storageKey, next);
      }
    },
    [],
  );

  useEffect(() => {
    reconcileProviderModel('claude-model', providerModelCatalog.claude, claudeModel, setClaudeModel);
  }, [providerModelCatalog.claude, claudeModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel('cursor-model', providerModelCatalog.cursor, cursorModel, setCursorModel);
  }, [providerModelCatalog.cursor, cursorModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel('codex-model', providerModelCatalog.codex, codexModel, setCodexModel);
  }, [providerModelCatalog.codex, codexModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel('gemini-model', providerModelCatalog.gemini, geminiModel, setGeminiModel);
  }, [providerModelCatalog.gemini, geminiModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel(
      'opencode-model',
      providerModelCatalog.opencode,
      opencodeModel,
      setOpenCodeModel,
    );
  }, [providerModelCatalog.opencode, opencodeModel, reconcileProviderModel]);

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
    lastProviderRef.current = provider;
  }, [provider]);

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
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    providerModelsFallbackProviders,
    providerModelsHasError: providerModelsFallbackProviders.length > 0,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
  };
}
