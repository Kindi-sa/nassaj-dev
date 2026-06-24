import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, Settings } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { useAntigravityActiveModel } from "../../hooks/useAntigravityActiveModel";
import { usePaletteOps } from "../../../../contexts/PaletteOpsContext";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
import type { ProviderAuthStatusMap } from "../../../provider-auth/types";
import { isProviderVisible, isProviderDisabled } from "../../../provider-auth/providerAuthFilter";
import { NextTaskBanner } from "../../../task-master";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Card,
} from "../../../../shared/view/ui";

const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "gemini", name: "Google" },
  { id: "antigravity", name: "Antigravity (agy)" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
  { id: "hermes", name: "Hermes (Nous)" },
];

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  antigravityModel: string;
  setAntigravityModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  hermesModel: string;
  setHermesModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  providerModelsRefreshing: boolean;
  providerAuthStatus: ProviderAuthStatusMap;
  onHardRefreshProviderModels: () => void;
  onRefreshAuthStatus: () => Promise<void>;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

type ProviderGroup = {
  id: LLMProvider;
  name: string;
  models: { value: string; label: string; description?: string }[];
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

function getCurrentModel(
  p: LLMProvider,
  c: string,
  cu: string,
  co: string,
  g: string,
  a: string,
  o: string,
  h: string,
) {
  if (p === "claude") return c;
  if (p === "codex") return co;
  if (p === "gemini") return g;
  if (p === "antigravity") return a;
  if (p === "opencode") return o;
  if (p === "hermes") return h;
  return cu;
}

function getProviderDisplayName(p: LLMProvider) {
  if (p === "claude") return "Claude";
  if (p === "cursor") return "Cursor";
  if (p === "codex") return "Codex";
  if (p === "antigravity") return "Antigravity (agy)";
  if (p === "opencode") return "OpenCode";
  if (p === "hermes") return "Hermes (Nous)";
  return "Gemini";
}

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
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
  providerModelCatalog,
  providerModelsLoading,
  providerModelsRefreshing,
  providerAuthStatus,
  onHardRefreshProviderModels,
  onRefreshAuthStatus,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const { openSettings } = usePaletteOps();
  const [dialogOpen, setDialogOpen] = useState(false);

  // in-flight guard for the combined refresh button (models + auth status)
  const refreshInFlightRef = useRef(false);

  // Trigger a refresh of both models catalog and auth status when the dialog opens.
  useEffect(() => {
    if (!dialogOpen) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    Promise.all([onRefreshAuthStatus()]).finally(() => {
      refreshInFlightRef.current = false;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  const handleRefreshClick = useCallback(async () => {
    if (providerModelsRefreshing || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      await Promise.all([
        onHardRefreshProviderModels(),
        onRefreshAuthStatus(),
      ]);
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [providerModelsRefreshing, onHardRefreshProviderModels, onRefreshAuthStatus]);

  // agy supports model selection (CLI `--model`), so antigravity is a fully
  // selectable provider like the others: the chosen catalog model is stored in
  // `antigravity-model` and sent to the backend. We additionally surface agy's
  // currently-active model (from the active-model hook) as an informational
  // banner. The backend serves the live agy catalog with a fallback.
  const isAntigravity = provider === "antigravity";
  const {
    label: antigravityActiveLabel,
    loading: antigravityActiveLoading,
    error: antigravityActiveError,
  } = useAntigravityActiveModel(isAntigravity);

  // Compute per-provider visibility and disabled state via shared filter helpers.
  // Logic lives in providerAuthFilter.ts — no inline duplication here.
  const providerVisibilityMap = useMemo<Record<LLMProvider, boolean>>(() => {
    const result = {} as Record<LLMProvider, boolean>;
    for (const p of PROVIDER_META) {
      result[p.id] = isProviderVisible(providerAuthStatus[p.id]);
    }
    return result;
  }, [providerAuthStatus]);

  const providerDisabledMap = useMemo<Record<LLMProvider, boolean>>(() => {
    const result = {} as Record<LLMProvider, boolean>;
    for (const p of PROVIDER_META) {
      result[p.id] = isProviderDisabled(providerAuthStatus[p.id]);
    }
    return result;
  }, [providerAuthStatus]);

  const visibleProviderGroups = useMemo<ProviderGroup[]>(() => {
    return PROVIDER_META
      .filter((p) => providerVisibilityMap[p.id])
      .map((p) => {
        const models = providerModelCatalog[p.id]?.OPTIONS ?? [];
        return {
          id: p.id,
          name: p.name,
          // Hide models for disabled (not-authenticated) providers so the group
          // appears but no models are selectable. After catalog load, also hide
          // groups that have 0 models (empty catalog + no loading).
          models: providerDisabledMap[p.id] ? [] : models,
        };
      })
      // Post-load: drop groups with 0 models when catalog has finished loading
      // and the group is not just disabled-awaiting-auth.
      .filter((g) => {
        if (providerDisabledMap[g.id]) return true; // keep disabled groups for CTA
        if (providerModelsLoading) return true; // fail-open during load
        return g.models.length > 0;
      });
  }, [providerModelCatalog, providerVisibilityMap, providerDisabledMap, providerModelsLoading]);

  // Resolve the read-only label shown for antigravity: live agy value, a clear
  // loading placeholder, or an "unknown" fallback when agy reports nothing.
  const antigravityModelDisplay = useMemo(() => {
    if (antigravityActiveLoading) {
      return t("providerSelection.antigravity.loading", { defaultValue: "Loading…" });
    }
    if (antigravityActiveError || !antigravityActiveLabel) {
      return t("providerSelection.antigravity.unknown", { defaultValue: "Unknown" });
    }
    return antigravityActiveLabel;
  }, [antigravityActiveLoading, antigravityActiveError, antigravityActiveLabel, t]);

  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const currentModel = getCurrentModel(
    provider,
    claudeModel,
    cursorModel,
    codexModel,
    geminiModel,
    antigravityModel,
    opencodeModel,
    hermesModel,
  );

  const currentModelLabel = useMemo(() => {
    const config = getModelConfig(provider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, currentModel, providerModelCatalog]);

  const setModelForProvider = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      if (providerId === "claude") {
        setClaudeModel(modelValue);
        localStorage.setItem("claude-model", modelValue);
      } else if (providerId === "codex") {
        setCodexModel(modelValue);
        localStorage.setItem("codex-model", modelValue);
      } else if (providerId === "gemini") {
        setGeminiModel(modelValue);
        localStorage.setItem("gemini-model", modelValue);
      } else if (providerId === "antigravity") {
        setAntigravityModel(modelValue);
        localStorage.setItem("antigravity-model", modelValue);
      } else if (providerId === "opencode") {
        setOpenCodeModel(modelValue);
        localStorage.setItem("opencode-model", modelValue);
      } else if (providerId === "hermes") {
        setHermesModel(modelValue);
        localStorage.setItem("hermes-model", modelValue);
      } else {
        setCursorModel(modelValue);
        localStorage.setItem("cursor-model", modelValue);
      }
    },
    [setClaudeModel, setCursorModel, setCodexModel, setGeminiModel, setAntigravityModel, setOpenCodeModel, setHermesModel],
  );

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      setProvider(providerId);
      localStorage.setItem("selected-provider", providerId);
      setModelForProvider(providerId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, setModelForProvider, textareaRef],
  );

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("providerSelection.description")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Card
                className="group mx-auto max-w-xs cursor-pointer border-border/60 transition-all duration-150 hover:border-border hover:shadow-md active:scale-[0.99]"
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center gap-2 p-3">
                  <SessionProviderLogo
                    provider={provider}
                    className="h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        {getProviderDisplayName(provider)}
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {/* Show the selected catalog model for every provider,
                            including agy (now fully selectable). */}
                        {currentModelLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                    {isAntigravity && (
                      <p
                        className="mt-0.5 truncate text-[11px] text-muted-foreground/70"
                        aria-live="polite"
                      >
                        {t("providerSelection.antigravity.activeModel", {
                          defaultValue: "agy active model: {{model}}",
                          model: antigravityModelDisplay,
                        })}
                      </p>
                    )}
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle>Model Selector</DialogTitle>
              <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Choose a model</p>
                <button
                  type="button"
                  onClick={handleRefreshClick}
                  disabled={providerModelsRefreshing}
                  aria-label={
                    providerModelsRefreshing
                      ? t("providerSelection.refresh.refreshing", { defaultValue: "Refreshing…" })
                      : t("providerSelection.refresh.button", { defaultValue: "Refresh models and auth status" })
                  }
                  title={
                    providerModelsRefreshing
                      ? t("providerSelection.refresh.refreshing", { defaultValue: "Refreshing…" })
                      : t("providerSelection.refresh.button", { defaultValue: "Refresh models and auth status" })
                  }
                  className="flex h-7 w-7 items-center justify-center rounded border border-border/50 bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <RefreshCw
                    className={["h-3.5 w-3.5", providerModelsRefreshing ? "animate-spin" : ""].join(" ").trim()}
                    aria-hidden="true"
                  />
                </button>
              </div>
              <Command>
                <CommandInput
                  placeholder={t("providerSelection.searchModels", {
                    defaultValue: "Search models...",
                  })}
                />
                <CommandList className="max-h-[350px]">
                  <CommandEmpty>
                    {t("providerSelection.noModelsFound", {
                      defaultValue: "No models found.",
                    })}
                  </CommandEmpty>
                  {visibleProviderGroups.map((group, idx) => {
                    const isProviderDisabled = providerDisabledMap[group.id];
                    return (
                      <CommandGroup
                        key={group.id}
                        className={
                          idx > 0
                            ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                            : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                        }
                        heading={
                          <span className="flex items-center gap-1.5">
                            <SessionProviderLogo provider={group.id} className={["h-3.5 w-3.5 shrink-0", isProviderDisabled ? "opacity-50" : ""].join(" ").trim()} />
                            <span className={isProviderDisabled ? "opacity-50" : ""}>{group.name}</span>
                          </span>
                        }
                      >
                        {isProviderDisabled ? (
                          // Provider is installed but not authenticated — show CTA only.
                          <div className="ms-4 border-s border-border/40 ps-4 py-2">
                            <p className="mb-1.5 text-[11px] text-muted-foreground">
                              {t("providerSelection.providerUnavailable", { defaultValue: "Provider not available" })}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setDialogOpen(false);
                                openSettings('agents');
                              }}
                              className="inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={t("providerSelection.signIn", { defaultValue: "Sign in" })}
                            >
                              <Settings className="h-3 w-3" aria-hidden="true" />
                              {t("providerSelection.signIn", { defaultValue: "Sign in" })}
                            </button>
                          </div>
                        ) : (
                          <>
                            {group.models.length === 0 && providerModelsLoading ? (
                              <CommandItem disabled className="ms-4 border-s border-border/40 ps-4 text-muted-foreground">
                                {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                              </CommandItem>
                            ) : null}
                            {group.models.map((model) => {
                              const isSelected = provider === group.id && currentModel === model.value;
                              return (
                                <CommandItem
                                  key={`${group.id}-${model.value}`}
                                  value={`${group.name} ${model.label} ${model.description || ''}`}
                                  onSelect={() => handleModelSelect(group.id, model.value)}
                                  className="ms-4 border-s border-border/40 ps-4"
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate">{model.label}</div>
                                    {model.description && (
                                      <div className="truncate text-xs text-muted-foreground">
                                        {model.description}
                                      </div>
                                    )}
                                  </div>
                                  {isSelected && (
                                    <Check className="ms-auto h-4 w-4 shrink-0 text-primary" />
                                  )}
                                </CommandItem>
                              );
                            })}
                          </>
                        )}
                      </CommandGroup>
                    );
                  })}
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>

          <p className="mt-4 text-center text-sm text-muted-foreground/70">
            {
              {
                claude: t("providerSelection.readyPrompt.claude", {
                  model: claudeModel,
                }),
                cursor: t("providerSelection.readyPrompt.cursor", {
                  model: cursorModel,
                }),
                codex: t("providerSelection.readyPrompt.codex", {
                  model: codexModel,
                }),
                gemini: t("providerSelection.readyPrompt.gemini", {
                  model: geminiModel,
                }),
                antigravity: t("providerSelection.readyPrompt.antigravity", {
                  model: antigravityModel,
                  defaultValue: "Ready with Antigravity (agy) {{model}}",
                }),
                opencode: t("providerSelection.readyPrompt.opencode", {
                  model: opencodeModel,
                  defaultValue: "Ready with OpenCode {{model}}",
                }),
                hermes: t("providerSelection.readyPrompt.hermes", {
                  model: hermesModel,
                  defaultValue: "Ready with Hermes {{model}}",
                }),
                // Placeholder providers: not surfaced in PROVIDER_META yet, so
                // these branches are unreachable at runtime; present only to keep
                // the lookup exhaustive over the LLMProvider union.
                deepseek: t("providerSelection.readyPrompt.deepseek", {
                  defaultValue: "Ready with DeepSeek",
                }),
                glm: t("providerSelection.readyPrompt.glm", {
                  defaultValue: "Ready with GLM 5.2",
                }),
                sakana: t("providerSelection.readyPrompt.sakana", {
                  defaultValue: "Ready with Sakana",
                }),
              }[provider]
            }
          </p>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
            <Trans
              i18nKey="providerSelection.pressToSearch"
              values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
              components={{
                kbd: (
                  <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                ),
              }}
            />
          </p>

          {provider && tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
