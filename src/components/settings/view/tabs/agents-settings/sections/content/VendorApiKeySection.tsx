import { useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../../shared/view/ui';
import { useVendorApiKey } from '../../../../../../provider-auth/hooks/useVendorApiKey';
import {
  VENDOR_PROVIDER_META,
  type VendorProvider,
} from '../../../../../../provider-auth/vendorProviders';

type VendorApiKeySectionProps = {
  provider: VendorProvider;
  /** Refreshes the shared `/auth/status` badge after a key is set/removed. */
  onConfiguredChange?: () => void;
};

/**
 * API-key management panel for a hosted vendor provider (kimi/deepseek/glm).
 *
 * These providers have no CLI login flow: the operator pastes an API key, which
 * the backend stores in the encrypted per-user secrets store. We never display
 * the stored value — only whether one is configured — and offer set / replace /
 * remove against `/api/providers/:provider/api-key`.
 */
export default function VendorApiKeySection({ provider, onConfiguredChange }: VendorApiKeySectionProps) {
  const { t } = useTranslation('settings');
  const meta = VENDOR_PROVIDER_META[provider];
  const { configured, loading, saving, error, saveKey, deleteKey } = useVendorApiKey(provider);

  const [draftKey, setDraftKey] = useState('');
  const [localFeedback, setLocalFeedback] = useState<string | null>(null);

  const inputId = `vendor-api-key-${provider}`;

  const handleSave = async () => {
    setLocalFeedback(null);
    const result = await saveKey(draftKey);
    if (result.success) {
      setDraftKey('');
      setLocalFeedback(t('agents.apiKey.saved', { defaultValue: 'API key saved.' }));
      onConfiguredChange?.();
    }
  };

  const handleDelete = async () => {
    setLocalFeedback(null);
    const result = await deleteKey();
    if (result.success) {
      setLocalFeedback(t('agents.apiKey.removed', { defaultValue: 'API key removed.' }));
      onConfiguredChange?.();
    }
  };

  return (
    <div className="border-t border-border/50 pt-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        <span>
          {configured
            ? t('agents.apiKey.replaceTitle', { defaultValue: 'Replace API key' })
            : t('agents.apiKey.title', { defaultValue: 'Add API key' })}
        </span>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        {t('agents.apiKey.description', {
          provider: meta.name,
          defaultValue:
            'Paste a {{provider}} API key to enable this provider. It is stored encrypted and never shown again.',
        })}
        {' '}
        <a
          href={meta.apiKeyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('agents.apiKey.getKey', { defaultValue: 'Get a key' })}
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>

      <label className="sr-only" htmlFor={inputId}>
        {t('agents.apiKey.inputLabel', {
          provider: meta.name,
          defaultValue: '{{provider}} API key',
        })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draftKey}
          disabled={saving || loading}
          onChange={(event) => setDraftKey(event.target.value)}
          placeholder={
            configured
              ? t('agents.apiKey.placeholderConfigured', { defaultValue: '•••••••• (configured)' })
              : t('agents.apiKey.placeholder', { defaultValue: 'Paste API key' })
          }
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <Button size="sm" onClick={handleSave} disabled={saving || loading || draftKey.trim().length === 0}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          <span className="ms-1.5">{t('agents.apiKey.save', { defaultValue: 'Save' })}</span>
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleDelete}
            disabled={saving || loading}
            className="text-red-600 hover:text-red-700 dark:text-red-400"
          >
            <Trash2 className="h-4 w-4" />
            <span className="ms-1.5">{t('agents.apiKey.remove', { defaultValue: 'Remove' })}</span>
          </Button>
        )}
      </div>

      <div className="mt-2 min-h-5 text-sm" aria-live="polite">
        {error ? (
          <span className="text-red-600 dark:text-red-400">{error}</span>
        ) : localFeedback ? (
          <span className="text-green-600 dark:text-green-400">{localFeedback}</span>
        ) : configured ? (
          <span className="text-muted-foreground">
            {t('agents.apiKey.configuredNote', { defaultValue: 'An API key is configured.' })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
