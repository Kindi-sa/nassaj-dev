import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider } from '../../../../../types/types';

type ApiProviderInfo = {
  name: string;
  platform: string;
  platformUrl: string;
  endpoint: string | null;
  defaultModel: string | null;
  available: boolean;
  note: string;
};

const API_PROVIDER_INFO: Partial<Record<AgentProvider, ApiProviderInfo>> = {
  deepseek: {
    name: 'DeepSeek',
    platform: 'platform.deepseek.com',
    platformUrl: 'https://platform.deepseek.com',
    endpoint: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    available: true,
    note: 'DeepSeek provides an Anthropic-compatible API. Full integration coming soon.',
  },
  glm: {
    name: 'GLM 5.2',
    platform: 'open.bigmodel.cn',
    platformUrl: 'https://open.bigmodel.cn',
    endpoint: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-4-plus',
    available: true,
    note: 'ZhipuAI provides an Anthropic-compatible API endpoint.',
  },
  hermes: {
    name: 'Hermes (NousResearch)',
    platform: 'huggingface.co/NousResearch',
    platformUrl: 'https://huggingface.co/NousResearch',
    endpoint: null,
    defaultModel: null,
    available: false,
    note: 'Hermes models require self-hosting or a compatible OpenAI/Anthropic proxy. No public hosted API is available yet.',
  },
  sakana: {
    name: 'Sakana AI',
    platform: 'sakana.ai',
    platformUrl: 'https://sakana.ai',
    endpoint: null,
    defaultModel: null,
    available: false,
    note: 'Sakana AI models do not have a public API compatible with Claude Code yet.',
  },
};

/** Inline copy button: icon toggles to checkmark for 1 second after click. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      className={className ?? 'flex-shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'}
    >
      {copied
        ? <Check className="h-4 w-4" aria-hidden />
        : <Copy className="h-4 w-4" aria-hidden />}
    </button>
  );
}

type ApiSetupContentProps = {
  agent: AgentProvider;
};

export default function ApiSetupContent({ agent }: ApiSetupContentProps) {
  const info = API_PROVIDER_INFO[agent];

  if (!info) return null;

  const cliCommand = info.endpoint && info.defaultModel
    ? `ANTHROPIC_BASE_URL=${info.endpoint} ANTHROPIC_API_KEY=sk-... claude`
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <SessionProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{info.name}</h3>
          <p className="text-sm text-muted-foreground">
            API-based provider — no CLI installation needed
          </p>
        </div>
      </div>

      {/* How it works */}
      <section aria-labelledby="how-it-works-heading">
        <h4 id="how-it-works-heading" className="mb-3 text-sm font-medium text-foreground">
          How it works
        </h4>
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Claude Code supports Anthropic-compatible API endpoints. These providers work by
            setting two environment variables:
          </p>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {info.endpoint
                  ? `ANTHROPIC_BASE_URL=${info.endpoint}`
                  : 'ANTHROPIC_BASE_URL=<provider-endpoint>'}
              </code>
              {info.endpoint && <CopyButton text={`ANTHROPIC_BASE_URL=${info.endpoint}`} />}
            </div>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
                ANTHROPIC_API_KEY=&lt;your-api-key&gt;
              </code>
            </div>
          </div>
        </div>
      </section>

      {/* Available providers: setup steps */}
      {info.available ? (
        <section aria-labelledby="setup-steps-heading">
          <h4 id="setup-steps-heading" className="mb-3 text-sm font-medium text-foreground">
            Setup steps
          </h4>
          <ol className="space-y-3" aria-label="Setup steps">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                1
              </span>
              <span className="text-sm text-muted-foreground pt-0.5">
                Get an API key from{' '}
                <a
                  href={info.platformUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  {info.platform}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                2
              </span>
              <span className="text-sm text-muted-foreground pt-0.5">
                Direct API key entry from this UI is coming soon.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                3
              </span>
              <span className="text-sm text-muted-foreground pt-0.5">
                In the meantime, add the variables to{' '}
                <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  ~/.nassaj/envs/{agent}.env
                </code>
              </span>
            </li>
          </ol>
        </section>
      ) : (
        /* Unavailable providers: coming soon banner */
        <div
          role="status"
          className="rounded-lg border border-border bg-muted/30 p-4 space-y-2"
        >
          <p className="text-sm font-medium text-foreground">Coming Soon</p>
          <p className="text-sm text-muted-foreground">{info.note}</p>
        </div>
      )}

      {/* Quick CLI test — only for available providers with an endpoint */}
      {info.available && cliCommand && (
        <section aria-labelledby="cli-test-heading">
          <h4 id="cli-test-heading" className="mb-3 text-sm font-medium text-foreground">
            Quick CLI test
          </h4>
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
            <p className="text-sm text-muted-foreground">
              Try the provider immediately from your terminal:
            </p>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground break-all">
                {cliCommand}
              </code>
              <CopyButton text={cliCommand} />
            </div>
          </div>
        </section>
      )}

      {/* Provider note */}
      {info.available && (
        <p className="text-xs text-muted-foreground">{info.note}</p>
      )}
    </div>
  );
}
