import React, { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, KeyRound } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { useAntigravityActiveModel } from "../../hooks/useAntigravityActiveModel";
import { useVendorKeyStatuses } from "../../../provider-auth/hooks/useVendorKeyStatuses";
import {
  VENDOR_PROVIDERS,
  VENDOR_PROVIDER_META,
  isVendorProvider,
  type VendorProvider,
} from "../../../provider-auth/vendorProviders";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
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
  { id: "kimi", name: "Kimi" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "glm", name: "GLM" },
];

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  /** Active "Claude engine on a vendor endpoint" selection (ADR-037), or null. */
  engineProvider: VendorProvider | null;
  /** Sets/clears the engine provider; used to clear it when a plain model is picked. */
  setEngineProvider: (next: VendorProvider | null) => void;
  /** Selects the Claude engine routed through a vendor endpoint + a vendor model. */
  onSelectClaudeEngineProvider: (vendor: VendorProvider, model: string) => void;
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
  kimiModel: string;
  setKimiModel: (model: string) => void;
  deepseekModel: string;
  setDeepSeekModel: (model: string) => void;
  glmModel: string;
  setGlmModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  /** Opens settings so the operator can add a vendor API key (ADR-030 CTA). */
  onShowSettings?: () => void;
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

function getCurrentModel(p: LLMProvider, models: Record<LLMProvider, string>): string {
  return models[p];
}

function getProviderDisplayName(p: LLMProvider) {
  if (p === "claude") return "Claude";
  if (p === "cursor") return "Cursor";
  if (p === "codex") return "Codex";
  if (p === "antigravity") return "Antigravity (agy)";
  if (p === "opencode") return "OpenCode";
  if (p === "kimi") return "Kimi";
  if (p === "deepseek") return "DeepSeek";
  if (p === "glm") return "GLM";
  return "Gemini";
}

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  engineProvider,
  setEngineProvider,
  onSelectClaudeEngineProvider,
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
  kimiModel,
  setKimiModel,
  deepseekModel,
  setDeepSeekModel,
  glmModel,
  setGlmModel,
  providerModelCatalog,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  onShowSettings,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const [dialogOpen, setDialogOpen] = useState(false);
  // ADR-030: gate the three hosted vendor providers in the picker behind a
  // configured API key. Fetch existence only (never the value).
  const { statuses: vendorKeyStatuses } = useVendorKeyStatuses();

  // agy ignores UI model selection: it picks the model from its own settings.
  // So for antigravity we hide the selectable picker and show a read-only label
  // sourced from the active-model hook (degrades gracefully when agy reports
  // nothing). The backend now serves the live agy catalog with a fallback.
  const isAntigravity = provider === "antigravity";
  const {
    label: antigravityActiveLabel,
    loading: antigravityActiveLoading,
    error: antigravityActiveError,
  } = useAntigravityActiveModel(isAntigravity);

  const visibleProviderGroups = useMemo<ProviderGroup[]>(() => {
    return PROVIDER_META.map((p) => ({
      id: p.id,
      name: p.name,
      models: providerModelCatalog[p.id]?.OPTIONS ?? [],
    }));
  }, [providerModelCatalog]);

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

  const modelByProvider = useMemo<Record<LLMProvider, string>>(
    () => ({
      claude: claudeModel,
      cursor: cursorModel,
      codex: codexModel,
      gemini: geminiModel,
      antigravity: antigravityModel,
      opencode: opencodeModel,
      kimi: kimiModel,
      deepseek: deepseekModel,
      glm: glmModel,
    }),
    [
      claudeModel,
      cursorModel,
      codexModel,
      geminiModel,
      antigravityModel,
      opencodeModel,
      kimiModel,
      deepseekModel,
      glmModel,
    ],
  );

  const currentModel = getCurrentModel(provider, modelByProvider);

  const currentModelLabel = useMemo(() => {
    // In engine-on-vendor mode the active model id is a vendor model, so resolve
    // its label against the vendor catalog rather than the Claude one.
    const lookupProvider =
      provider === "claude" && engineProvider ? engineProvider : provider;
    const config = getModelConfig(lookupProvider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, engineProvider, currentModel, providerModelCatalog]);

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
      } else if (providerId === "kimi") {
        setKimiModel(modelValue);
        localStorage.setItem("kimi-model", modelValue);
      } else if (providerId === "deepseek") {
        setDeepSeekModel(modelValue);
        localStorage.setItem("deepseek-model", modelValue);
      } else if (providerId === "glm") {
        setGlmModel(modelValue);
        localStorage.setItem("glm-model", modelValue);
      } else {
        setCursorModel(modelValue);
        localStorage.setItem("cursor-model", modelValue);
      }
    },
    [
      setClaudeModel,
      setCursorModel,
      setCodexModel,
      setGeminiModel,
      setAntigravityModel,
      setOpenCodeModel,
      setKimiModel,
      setDeepSeekModel,
      setGlmModel,
    ],
  );

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      setProvider(providerId);
      localStorage.setItem("selected-provider", providerId);
      // Picking any plain model leaves engine-on-vendor mode. (Switching to a
      // non-Claude provider also clears it in the hook, but a plain *Claude*
      // model keeps provider==='claude', so clear it explicitly here.)
      setEngineProvider(null);
      setModelForProvider(providerId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, setEngineProvider, setModelForProvider, textareaRef],
  );

  // ADR-037 (m-FE-9): "Claude engine on <vendor>" entries. Each vendor that has a
  // configured key (ADR-030) lists its Anthropic-compatible models — the same
  // live catalog the standalone vendor path uses — but selecting one keeps the
  // provider as Claude and routes the engine through that vendor endpoint.
  const claudeEngineGroups = useMemo(
    () =>
      VENDOR_PROVIDERS.map((vendorId) => ({
        id: vendorId,
        name: VENDOR_PROVIDER_META[vendorId].name,
        models: providerModelCatalog[vendorId]?.OPTIONS ?? [],
      })),
    [providerModelCatalog],
  );

  const handleEngineSelect = useCallback(
    (vendorId: VendorProvider, modelValue: string) => {
      onSelectClaudeEngineProvider(vendorId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [onSelectClaudeEngineProvider, textareaRef],
  );

  // True only while the Claude engine is actively pointed at a vendor endpoint.
  const isEngineActive = provider === "claude" && engineProvider != null;
  const engineProviderName = engineProvider ? VENDOR_PROVIDER_META[engineProvider].name : null;

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

          {isAntigravity ? (
            <Card
              className="mx-auto max-w-xs border-border/60"
              role="group"
              aria-label={t("providerSelection.antigravity.activeModel", {
                defaultValue: "Active model",
              })}
            >
              <div className="flex items-center gap-2 p-3">
                <SessionProviderLogo provider={provider} className="h-5 w-5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-semibold text-foreground">
                      {getProviderDisplayName(provider)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t("providerSelection.antigravity.activeModelLabel", {
                      defaultValue: "Active model",
                    })}
                    {": "}
                    <span
                      className="font-medium text-foreground"
                      aria-live="polite"
                    >
                      {antigravityModelDisplay}
                    </span>
                  </p>
                </div>
              </div>
            </Card>
          ) : (
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
                        {isEngineActive
                          ? t("providerSelection.engineOnVendor", {
                              provider: engineProviderName,
                              defaultValue: "Claude engine on {{provider}}",
                            })
                          : getProviderDisplayName(provider)}
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {currentModelLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle>Model Selector</DialogTitle>
              <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Choose a model</p>
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
                  {visibleProviderGroups
                    .map((group) =>
                      group.id === "antigravity"
                        ? { ...group, models: group.models.slice(0, 1) }
                        : group,
                    )
                    .map((group, idx) => {
                    // ADR-030: a vendor provider with no configured API key is
                    // shown but locked, with a CTA to add a key instead of models.
                    const isLockedVendor =
                      isVendorProvider(group.id) && !vendorKeyStatuses[group.id];
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
                          <SessionProviderLogo provider={group.id} className="h-3.5 w-3.5 shrink-0" />
                          {group.name}
                        </span>
                      }
                    >
                      {isLockedVendor ? (
                        <CommandItem
                          value={`${group.name} add api key`}
                          onSelect={() => {
                            setDialogOpen(false);
                            onShowSettings?.();
                          }}
                          className="ml-4 border-l border-border/40 pl-4"
                        >
                          <KeyRound className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {t("providerSelection.addApiKey", {
                              provider: group.name,
                              defaultValue: "Add {{provider}} API key to enable",
                            })}
                          </span>
                        </CommandItem>
                      ) : null}
                      {!isLockedVendor && group.models.length === 0 && providerModelsLoading ? (
                        <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                          {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                        </CommandItem>
                      ) : null}
                      {(isLockedVendor ? [] : group.models).map((model) => {
                        // While the engine runs on a vendor, the plain Claude
                        // models are never the active selection (the engine entry
                        // below owns the check mark).
                        const isSelected =
                          provider === group.id &&
                          currentModel === model.value &&
                          !(group.id === "claude" && isEngineActive);
                        return (
                          <CommandItem
                            key={`${group.id}-${model.value}`}
                            value={`${group.name} ${model.label} ${model.description || ''}`}
                            onSelect={() => handleModelSelect(group.id, model.value)}
                            className="ml-4 border-l border-border/40 pl-4"
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
                              <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                    );
                  })}

                  {/* ADR-037 (m-FE-9): Claude engine routed through a vendor's
                      Anthropic-compatible endpoint. Same ADR-030 gate as the
                      standalone vendor groups: a vendor with no key is shown
                      locked with a CTA; otherwise its models pick the engine. */}
                  {claudeEngineGroups.map((group) => {
                    const isLocked = !vendorKeyStatuses[group.id];
                    return (
                      <CommandGroup
                        key={`engine-${group.id}`}
                        className="border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                        heading={
                          <span className="flex items-center gap-1.5">
                            <SessionProviderLogo provider="claude" className="h-3.5 w-3.5 shrink-0" />
                            {t("providerSelection.engineOnVendor", {
                              provider: group.name,
                              defaultValue: "Claude engine on {{provider}}",
                            })}
                          </span>
                        }
                      >
                        {isLocked ? (
                          <CommandItem
                            value={`claude engine ${group.name} add api key`}
                            onSelect={() => {
                              setDialogOpen(false);
                              onShowSettings?.();
                            }}
                            className="ml-4 border-l border-border/40 pl-4"
                          >
                            <KeyRound className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                              {t("providerSelection.addApiKey", {
                                provider: group.name,
                                defaultValue: "Add {{provider}} API key to enable",
                              })}
                            </span>
                          </CommandItem>
                        ) : null}
                        {!isLocked && group.models.length === 0 && providerModelsLoading ? (
                          <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                            {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                          </CommandItem>
                        ) : null}
                        {(isLocked ? [] : group.models).map((model) => {
                          const isSelected =
                            isEngineActive && engineProvider === group.id && claudeModel === model.value;
                          return (
                            <CommandItem
                              key={`engine-${group.id}-${model.value}`}
                              value={`claude engine ${group.name} ${model.label} ${model.description || ''}`}
                              onSelect={() => handleEngineSelect(group.id, model.value)}
                              className="ml-4 border-l border-border/40 pl-4"
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
                                <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                              )}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    );
                  })}
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>
          )}

          <p className="mt-4 text-center text-sm text-muted-foreground/70">
            {isEngineActive
              ? t("providerSelection.readyPrompt.claudeEngine", {
                  provider: engineProviderName,
                  model: currentModelLabel,
                  defaultValue:
                    "Ready: the Claude engine runs on {{provider}} with {{model}}. Start typing your message below.",
                })
              : {
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
                  defaultValue:
                    "Ready to use Antigravity (agy). The model is chosen from agy's own settings.",
                }),
                opencode: t("providerSelection.readyPrompt.opencode", {
                  model: opencodeModel,
                  defaultValue: "Ready with OpenCode {{model}}",
                }),
                kimi: t("providerSelection.readyPrompt.kimi", {
                  model: kimiModel,
                  defaultValue: "Ready to use Kimi with {{model}}. Start typing your message below.",
                }),
                deepseek: t("providerSelection.readyPrompt.deepseek", {
                  model: deepseekModel,
                  defaultValue: "Ready to use DeepSeek with {{model}}. Start typing your message below.",
                }),
                glm: t("providerSelection.readyPrompt.glm", {
                  model: glmModel,
                  defaultValue: "Ready to use GLM with {{model}}. Start typing your message below.",
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
