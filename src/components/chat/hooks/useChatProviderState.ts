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
import {
  FALLBACK_DEFAULT_MODEL,
  PROVIDER_FALLBACK_MODELS,
  sanitizeStoredModel,
  sanitizeStoredProvider,
} from '../../../constants/providerModelFallbacks';
import { onApplyServerPreference } from '../../../preferences/preferencesSync';
import {
  filterDisabledProviders,
  isProviderGloballyDisabled,
} from '../../../../shared/disabledProviders';

import { pickStoredOrCurrent } from './normalizeProviderModel';

/**
 * The active "Claude engine on a vendor endpoint" selection (ADR-037). A vendor
 * id means the Claude engine runs against that vendor's Anthropic-compatible
 * endpoint; null is the normal official-Anthropic path.
 */
export type EngineProvider = VendorProvider | null;

const ENGINE_PROVIDER_STORAGE_KEY = 'claude-engine-provider';

/**
 * Reads the persisted engine provider, ignoring any stale/invalid value —
 * including a vendor that has since been globally disabled (T-864), so a stale
 * engineProvider never reaches the server.
 */
function readStoredEngineProvider(): EngineProvider {
  const stored = localStorage.getItem(ENGINE_PROVIDER_STORAGE_KEY);
  return stored &&
    (VENDOR_PROVIDERS as readonly string[]).includes(stored) &&
    !isProviderGloballyDisabled(stored)
    ? (stored as VendorProvider)
    : null;
}

// FALLBACK_DEFAULT_MODEL is imported from providerModelFallbacks.ts (single
// source of truth). The former local copy had claude:'opus' which is not a
// valid Claude model value, and was missing hermes and sakana entries.

export const getPermissionModesForProvider = (provider: LLMProvider): PermissionMode[] => {
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
  const [hermesModel, setHermesModel] = useState<string>(() => {
    return sanitizeStoredModel('hermes', localStorage.getItem('hermes-model'));
  });
  // Antigravity (agy) does not expose model selection from the UI; the real
  // model is chosen inside agy's own settings. We still carry a tiny piece of
  // state so the provider plugs into existing model-aware helpers uniformly.
  const [antigravityModel, setAntigravityModel] = useState<string>(() => {
    return sanitizeStoredModel('antigravity', localStorage.getItem('antigravity-model'));
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
  // Set of providers whose live catalog failed to load and are currently
  // serving the embedded fallback catalog. Empty when everything loaded live.
  const [providerModelsFallbackProviders, setProviderModelsFallbackProviders] = useState<
    LLMProvider[]
  >([]);

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

    if (targetProvider === 'hermes') {
      setHermesModel(model);
      localStorage.setItem('hermes-model', model);
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
    // Globally disabled providers (T-864) are dropped from the catalog fan-out:
    // no /models request is made for them at all.
    const providers: LLMProvider[] = filterDisabledProviders([
      'claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode', 'hermes',
      'kimi', 'deepseek', 'glm',
    ]);
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

  // Reflect account-sourced provider/model selections live after sign-in. The
  // sync layer has already written localStorage; we refresh React state and let
  // the per-provider reconcile effects above re-validate against the catalog.
  useEffect(() => {
    const offProvider = onApplyServerPreference('selected-provider', (raw) => {
      setProvider(sanitizeStoredProvider(raw));
    });
    const offClaude = onApplyServerPreference('claude-model', (raw) => {
      setClaudeModel(sanitizeStoredModel('claude', raw));
    });
    const offCursor = onApplyServerPreference('cursor-model', (raw) => {
      setCursorModel(sanitizeStoredModel('cursor', raw));
    });
    const offCodex = onApplyServerPreference('codex-model', (raw) => {
      setCodexModel(sanitizeStoredModel('codex', raw));
    });
    const offGemini = onApplyServerPreference('gemini-model', (raw) => {
      setGeminiModel(sanitizeStoredModel('gemini', raw));
    });
    const offOpencode = onApplyServerPreference('opencode-model', (raw) => {
      setOpenCodeModel(sanitizeStoredModel('opencode', raw));
    });
    const offAntigravity = onApplyServerPreference('antigravity-model', (raw) => {
      setAntigravityModel(sanitizeStoredModel('antigravity', raw));
    });
    const offHermes = onApplyServerPreference('hermes-model', (raw) => {
      setHermesModel(sanitizeStoredModel('hermes', raw));
    });
    return () => {
      offProvider();
      offClaude();
      offCursor();
      offCodex();
      offGemini();
      offOpencode();
      offAntigravity();
      offHermes();
    };
  }, []);

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
    reconcileProviderModel('hermes-model', providerModelCatalog.hermes, hermesModel, setHermesModel);
  }, [providerModelCatalog.hermes, hermesModel, reconcileProviderModel]);

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
    hermesModel,
    setHermesModel,
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
    providerModelsFallbackProviders,
    providerModelsHasError: providerModelsFallbackProviders.length > 0,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
  };
}
