import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Antigravity (agy CLI) model catalog.
 *
 * agy is a Google AI CLI built on top of Gemini. In non-interactive print
 * mode (`agy -p`) the CLI does NOT accept a model override flag — the active
 * model is chosen inside agy's own interactive settings and persisted there.
 *
 * The options below are exposed for UI parity and display only; selecting one
 * records the user's intended model and is forwarded to the backend, but the
 * agy CLI ignores it until/unless a model flag is added upstream. Keep "auto"
 * first so it remains the default "use agy's own setting" choice.
 *
 * NOTE (upstream sync v1.33): these values were preserved from the fork's
 * former `shared/modelConstants.js` (ANTIGRAVITY_MODELS) when upstream #762
 * migrated the model catalogs into the per-provider provider-models layer and
 * deleted that file. The Antigravity provider itself is temporarily disabled
 * via a DisabledProvider stub in provider.registry.ts; this catalog is the
 * foundation for re-enabling it. See the re-enable TODO in provider.registry.ts.
 */
export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'agy default' },
    { value: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  DEFAULT: 'auto',
};

export class AntigravityProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return ANTIGRAVITY_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(ANTIGRAVITY_FALLBACK_MODELS);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('antigravity', input);
  }
}
