import type { LLMProvider } from '../../types/app';
import AntigravityLogo from './AntigravityLogo';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import GeminiLogo from './GeminiLogo';
import OpenCodeLogo from './OpenCodeLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

// Lightweight placeholder marks for providers whose brand SVGs are not yet
// wired. Each is a rounded tile with the provider's initials so the chips stay
// visually distinct until dedicated logo components land.
type InitialLogoProps = { className?: string };

const makeInitialLogo = (fill: string, initials: string) =>
  function InitialLogo({ className }: InitialLogoProps) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" role="presentation" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill={fill} />
        <text
          x="12"
          y="16"
          textAnchor="middle"
          fill="white"
          fontSize="10"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          {initials}
        </text>
      </svg>
    );
  };

const DeepSeekLogo = makeInitialLogo('#2563EB', 'DS');
const GlmLogo = makeInitialLogo('#0891B2', 'GLM');
const HermesLogo = makeInitialLogo('#7C3AED', 'H');
const SakanaLogo = makeInitialLogo('#14B8A6', 'S');

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

  if (provider === 'deepseek') {
    return <DeepSeekLogo className={className} />;
  }

  if (provider === 'glm') {
    return <GlmLogo className={className} />;
  }

  if (provider === 'hermes') {
    return <HermesLogo className={className} />;
  }

  if (provider === 'sakana') {
    return <SakanaLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
