import type { LLMProvider } from '../../types/app';
import { VENDOR_PROVIDERS, type VendorProvider } from '../provider-auth/vendorProviders';
import AntigravityLogo from './AntigravityLogo';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import GeminiLogo from './GeminiLogo';
import OpenCodeLogo from './OpenCodeLogo';
import VendorLogo from './VendorLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'gemini') {
    return <GeminiLogo className={className} />;
  }

  if (provider === 'antigravity') {
    return <AntigravityLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  if (typeof provider === 'string' && (VENDOR_PROVIDERS as readonly string[]).includes(provider)) {
    return <VendorLogo provider={provider as VendorProvider} className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
