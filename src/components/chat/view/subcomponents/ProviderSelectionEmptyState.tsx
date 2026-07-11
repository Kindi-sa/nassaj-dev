import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, KeyRound, RefreshCw, Settings } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { useAntigravityActiveModel } from "../../hooks/useAntigravityActiveModel";
import { usePaletteOps } from "../../../../contexts/PaletteOpsContext";
import { useVendorKeyStatuses } from "../../../provider-auth/hooks/useVendorKeyStatuses";
import {
  ENABLED_VENDOR_PROVIDERS,
  VENDOR_PROVIDER_META,
  isVendorProvider,
  type VendorProvider,
} from "../../../provider-auth/vendorProviders";
import { isProviderGloballyDisabled } from "../../../../../shared/disabledProviders";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
import { PLACEHOLDER_FALLBACK_MODELS } from "../../../../constants/providerModelFallbacks";
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

import {
  readCollapsedMap,
  writeCollapsedMap,
  resolveExpandedNoSearch,
  type CollapsedMap,
} from "./providerGroupCollapse";

// Globally disabled providers (T-864, shared/disabledProviders.ts) never make
// it into the picker: the full list stays here for upstream-sync friendliness
// and the filter below drops the disabled ids.
const ALL_PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "gemini", name: "Google" },
  { id: "antigravity", name: "Antigravity (agy)" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
  { id: "hermes", name: "Hermes (Nous)" },
  { id: "kimi", name: "Kimi" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "glm", name: "GLM" },
];

const PROVIDER_META = ALL_PROVIDER_META.filter((meta) => !isProviderGloballyDisabled(meta.id));

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
  hermesModel: string;
  setHermesModel: (model: string) => void;
  kimiModel: string;
  setKimiModel: (model: string) => void;
  deepseekModel: string;
  setDeepSeekModel: (model: string) => void;
  glmModel: string;
  setGlmModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  providerModelsRefreshing: boolean;
  providerAuthStatus: ProviderAuthStatusMap;
  onHardRefreshProviderModels: () => void;
  /** @param force When true, bypasses the 30-second TTL on the caller side. */
  onRefreshAuthStatus: (force?: boolean) => Promise<void>;
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
  if (p === "hermes") return "Hermes (Nous)";
  if (p === "kimi") return "Kimi";
  if (p === "deepseek") return "DeepSeek";
  if (p === "glm") return "GLM";
  return "Gemini";
}

/**
 * Clickable, keyboard-operable disclosure header for a model-picker group
 * (T-871). The WHOLE header toggles the group; the chevron rotates to the
 * inline-start on collapse (RTL-aware) and stays pointing down when open.
 *
 * It intentionally does NOT use cmdk's `heading` prop: that node is rendered
 * `aria-hidden`, so an interactive control inside it would fail WCAG
 * (aria-hidden-focus). Rendered as the group's first child instead, it is a
 * normal focusable button; cmdk still hides the whole group (header included)
 * when a search matches none of its items.
 */
function CollapsibleGroupHeader({
  expanded,
  onToggle,
  spaced,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** Adds a small top gap so it aligns with the between-groups separator. */
  spaced: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onKeyDown={(e) => {
        // cmdk's root keydown also handles Enter (it selects the highlighted
        // item). Stop it here so activating the header ONLY toggles the group
        // instead of also picking a model.
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.stopPropagation();
        }
      }}
      aria-expanded={expanded}
      className={[
        "flex w-full items-center justify-between gap-1.5 rounded-sm px-2 py-1.5",
        "text-xs font-medium uppercase tracking-wider text-muted-foreground",
        "transition-colors hover:bg-accent/40 hover:text-foreground focus:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        spaced ? "mt-1" : "",
      ].join(" ").trim()}
    >
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
      <ChevronDown
        className={[
          "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
          expanded ? "" : "-rotate-90 rtl:rotate-90",
        ].join(" ").trim()}
        aria-hidden="true"
      />
    </button>
  );
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
  hermesModel,
  setHermesModel,
  kimiModel,
  setKimiModel,
  deepseekModel,
  setDeepSeekModel,
  glmModel,
  setGlmModel,
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
  onShowSettings,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const { openSettings } = usePaletteOps();
  const [dialogOpen, setDialogOpen] = useState(false);
  // ADR-030: gate the three hosted vendor providers in the picker behind a
  // configured API key. Fetch existence only (never the value).
  const { statuses: vendorKeyStatuses } = useVendorKeyStatuses();

  // Tracks whether this component's own refresh cycle is in progress.
  // Used to correctly disable the refresh button while both models AND auth
  // status are fetching (providerModelsRefreshing only covers the models half).
  const [isLocalRefreshing, setIsLocalRefreshing] = useState(false);
  // Prevents launching a second concurrent refresh (e.g. rapid double-click).
  const refreshInFlightRef = useRef(false);

  // T-871: per-group collapse state for the picker. `searchQuery` mirrors the
  // cmdk search box (uncontrolled — we only observe it) so an active search can
  // override collapse; `collapsedMap` is the persisted `{ [groupId]: collapsed }`
  // preference, seeded once from localStorage. Neither touches the provider/model
  // selection state (owned elsewhere) or the installed/authenticated filtering.
  const [searchQuery, setSearchQuery] = useState("");
  const isSearching = searchQuery.trim().length > 0;
  const [collapsedMap, setCollapsedMap] = useState<CollapsedMap>(() =>
    readCollapsedMap(typeof window !== "undefined" ? window.localStorage : null),
  );

  // Flip and persist one group's collapse. `currentExpandedNoSearch` is the
  // group's effective open state ignoring search, so storing it as the new
  // COLLAPSED flag toggles the group (open→collapsed, collapsed→open).
  const toggleGroup = useCallback((groupId: string, currentExpandedNoSearch: boolean) => {
    setCollapsedMap((prev) => {
      const next = { ...prev, [groupId]: currentExpandedNoSearch };
      writeCollapsedMap(next, typeof window !== "undefined" ? window.localStorage : null);
      return next;
    });
  }, []);

  // Trigger a refresh of auth status when the dialog opens (non-forced: TTL
  // applies here because opening the picker is not an explicit user refresh).
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
    setIsLocalRefreshing(true);
    try {
      // force=true bypasses the 30-second TTL on refreshAuthStatus so an
      // explicit button press always fetches a fresh auth status, not just
      // models. Without force the auth part is silently dropped within 30 s of
      // the dialog open, leaving the provider filter on stale data.
      await Promise.all([
        onHardRefreshProviderModels(),
        onRefreshAuthStatus(true),
      ]);
    } finally {
      refreshInFlightRef.current = false;
      setIsLocalRefreshing(false);
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

  const modelByProvider = useMemo<Record<LLMProvider, string>>(
    () => ({
      claude: claudeModel,
      cursor: cursorModel,
      codex: codexModel,
      gemini: geminiModel,
      antigravity: antigravityModel,
      opencode: opencodeModel,
      hermes: hermesModel,
      kimi: kimiModel,
      deepseek: deepseekModel,
      glm: glmModel,
      // sakana has no dedicated state/prop in this component yet; seed with
      // the placeholder default so Record<LLMProvider, string> is exhaustive.
      sakana: PLACEHOLDER_FALLBACK_MODELS.DEFAULT,
    }),
    [
      claudeModel,
      cursorModel,
      codexModel,
      geminiModel,
      antigravityModel,
      opencodeModel,
      hermesModel,
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
      } else if (providerId === "hermes") {
        setHermesModel(modelValue);
        localStorage.setItem("hermes-model", modelValue);
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
      setHermesModel,
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
  // Globally disabled vendors (T-864) are excluded — no group, no key CTA.
  const claudeEngineGroups = useMemo(
    () =>
      ENABLED_VENDOR_PROVIDERS.map((vendorId) => ({
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
                  disabled={providerModelsRefreshing || isLocalRefreshing}
                  aria-label={
                    (providerModelsRefreshing || isLocalRefreshing)
                      ? t("providerSelection.refresh.refreshing", { defaultValue: "Refreshing…" })
                      : t("providerSelection.refresh.button", { defaultValue: "Refresh models and auth status" })
                  }
                  title={
                    (providerModelsRefreshing || isLocalRefreshing)
                      ? t("providerSelection.refresh.refreshing", { defaultValue: "Refreshing…" })
                      : t("providerSelection.refresh.button", { defaultValue: "Refresh models and auth status" })
                  }
                  className="flex h-7 w-7 items-center justify-center rounded border border-border/50 bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <RefreshCw
                    className={["h-3.5 w-3.5", (providerModelsRefreshing || isLocalRefreshing) ? "animate-spin" : ""].join(" ").trim()}
                    aria-hidden="true"
                  />
                </button>
              </div>
              <Command>
                <CommandInput
                  placeholder={t("providerSelection.searchModels", {
                    defaultValue: "Search models...",
                  })}
                  onValueChange={setSearchQuery}
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
                    const isProviderDisabled = providerDisabledMap[group.id];
                    // ADR-030: a vendor provider with no configured API key is
                    // shown but locked, with a CTA to add a key instead of models.
                    const isLockedVendor =
                      isVendorProvider(group.id) && !vendorKeyStatuses[group.id];
                    // T-871: only a group that actually lists models is collapsible
                    // (disabled/locked/loading groups show a CTA — nothing to fold).
                    const isCollapsible =
                      !isProviderDisabled && !isLockedVendor && group.models.length > 0;
                    const groupContainsSelected =
                      provider === group.id &&
                      !(group.id === "claude" && isEngineActive) &&
                      group.models.some((m) => m.value === currentModel);
                    const expandedNoSearch = resolveExpandedNoSearch({
                      storedCollapsed: collapsedMap[group.id],
                      modelCount: group.models.length,
                      containsSelected: groupContainsSelected,
                    });
                    const expanded = isSearching || expandedNoSearch;
                    return (
                      <CommandGroup
                        key={group.id}
                        className={
                          idx > 0
                            ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                            : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                        }
                        heading={
                          isCollapsible ? undefined : (
                            <span className="flex items-center gap-1.5">
                              <SessionProviderLogo provider={group.id} className={["h-3.5 w-3.5 shrink-0", isProviderDisabled ? "opacity-50" : ""].join(" ").trim()} />
                              <span className={isProviderDisabled ? "opacity-50" : ""}>{group.name}</span>
                            </span>
                          )
                        }
                      >
                        {isCollapsible && (
                          <CollapsibleGroupHeader
                            expanded={expanded}
                            onToggle={() => toggleGroup(group.id, expandedNoSearch)}
                            spaced={idx > 0}
                          >
                            <SessionProviderLogo provider={group.id} className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{group.name}</span>
                          </CollapsibleGroupHeader>
                        )}
                        {isProviderDisabled ? (
                          // Provider is installed but not authenticated — show CTA only.
                          <div className="ms-4 border-s border-border/40 py-2 ps-4">
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
                            {isLockedVendor ? (
                              <CommandItem
                                value={`${group.name} add api key`}
                                onSelect={() => {
                                  setDialogOpen(false);
                                  onShowSettings?.();
                                }}
                                className="ms-4 border-s border-border/40 ps-4"
                              >
                                <KeyRound className="me-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                  {t("providerSelection.addApiKey", {
                                    provider: group.name,
                                    defaultValue: "Add {{provider}} API key to enable",
                                  })}
                                </span>
                              </CommandItem>
                            ) : null}
                            {!isLockedVendor && group.models.length === 0 && providerModelsLoading ? (
                              <CommandItem disabled className="ms-4 border-s border-border/40 ps-4 text-muted-foreground">
                                {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                              </CommandItem>
                            ) : null}
                            {((isCollapsible && !expanded) ? [] : (isLockedVendor ? [] : group.models)).map((model) => {
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

                  {/* ADR-037 (m-FE-9): Claude engine routed through a vendor's
                      Anthropic-compatible endpoint. Same ADR-030 gate as the
                      standalone vendor groups: a vendor with no key is shown
                      locked with a CTA; otherwise its models pick the engine. */}
                  {claudeEngineGroups.map((group) => {
                    const isLocked = !vendorKeyStatuses[group.id];
                    // T-871: same collapse rules as the standalone groups, keyed
                    // under a distinct `engine-` id so a vendor's engine group and
                    // its standalone group fold independently.
                    const engineGroupKey = `engine-${group.id}`;
                    const isCollapsible = !isLocked && group.models.length > 0;
                    const groupContainsSelected =
                      isEngineActive &&
                      engineProvider === group.id &&
                      group.models.some((m) => m.value === claudeModel);
                    const expandedNoSearch = resolveExpandedNoSearch({
                      storedCollapsed: collapsedMap[engineGroupKey],
                      modelCount: group.models.length,
                      containsSelected: groupContainsSelected,
                    });
                    const expanded = isSearching || expandedNoSearch;
                    const engineHeading = t("providerSelection.engineOnVendor", {
                      provider: group.name,
                      defaultValue: "Claude engine on {{provider}}",
                    });
                    return (
                      <CommandGroup
                        key={`engine-${group.id}`}
                        className="border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                        heading={
                          isCollapsible ? undefined : (
                            <span className="flex items-center gap-1.5">
                              <SessionProviderLogo provider="claude" className="h-3.5 w-3.5 shrink-0" />
                              {engineHeading}
                            </span>
                          )
                        }
                      >
                        {isCollapsible && (
                          <CollapsibleGroupHeader
                            expanded={expanded}
                            onToggle={() => toggleGroup(engineGroupKey, expandedNoSearch)}
                            spaced
                          >
                            <SessionProviderLogo provider="claude" className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{engineHeading}</span>
                          </CollapsibleGroupHeader>
                        )}
                        {isLocked ? (
                          <CommandItem
                            value={`claude engine ${group.name} add api key`}
                            onSelect={() => {
                              setDialogOpen(false);
                              onShowSettings?.();
                            }}
                            className="ms-4 border-s border-border/40 ps-4"
                          >
                            <KeyRound className="me-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                              {t("providerSelection.addApiKey", {
                                provider: group.name,
                                defaultValue: "Add {{provider}} API key to enable",
                              })}
                            </span>
                          </CommandItem>
                        ) : null}
                        {!isLocked && group.models.length === 0 && providerModelsLoading ? (
                          <CommandItem disabled className="ms-4 border-s border-border/40 ps-4 text-muted-foreground">
                            {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                          </CommandItem>
                        ) : null}
                        {((isCollapsible && !expanded) ? [] : (isLocked ? [] : group.models)).map((model) => {
                          const isSelected =
                            isEngineActive && engineProvider === group.id && claudeModel === model.value;
                          return (
                            <CommandItem
                              key={`engine-${group.id}-${model.value}`}
                              value={`claude engine ${group.name} ${model.label} ${model.description || ''}`}
                              onSelect={() => handleEngineSelect(group.id, model.value)}
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
                      </CommandGroup>
                    );
                  })}
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>

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
