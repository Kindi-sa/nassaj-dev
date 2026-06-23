import { useMemo, useState } from 'react';

import type { AgentCategory, AgentProvider } from '../../../types/types';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  geminiPermissionMode,
  onGeminiPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    return ['claude', 'cursor', 'codex', 'antigravity', 'opencode', 'deepseek', 'glm', 'hermes', 'sakana'];
  }, []);

  const agentContextById = useMemo<Record<AgentProvider, AgentContext>>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
    },
    gemini: {
      authStatus: providerAuthStatus.gemini,
      onLogin: () => onProviderLogin('gemini'),
    },
    // `onLogin` is wired but `AccountContent` for antigravity does not surface
    // a login button — agy uses Google OAuth from its CLI and the panel only
    // shows status plus instructions to run `agy -p hello`.
    antigravity: {
      authStatus: providerAuthStatus.antigravity,
      onLogin: () => onProviderLogin('antigravity'),
    },
    opencode: {
      authStatus: providerAuthStatus.opencode,
      onLogin: () => onProviderLogin('opencode'),
    },
    // Placeholder providers: declared in the LLMProvider union with stub auth
    // status (no live backend probe yet). The exhaustive `Record<AgentProvider, …>`
    // type requires an entry for every union literal even before wiring login.
    deepseek: {
      authStatus: providerAuthStatus.deepseek,
      onLogin: () => onProviderLogin('deepseek'),
    },
    glm: {
      authStatus: providerAuthStatus.glm,
      onLogin: () => onProviderLogin('glm'),
    },
    hermes: {
      authStatus: providerAuthStatus.hermes,
      onLogin: () => onProviderLogin('hermes'),
    },
    sakana: {
      authStatus: providerAuthStatus.sakana,
      onLogin: () => onProviderLogin('sakana'),
    },
  }), [
    onProviderLogin,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.gemini,
    providerAuthStatus.antigravity,
    providerAuthStatus.opencode,
    providerAuthStatus.deepseek,
    providerAuthStatus.glm,
    providerAuthStatus.hermes,
    providerAuthStatus.sakana,
  ]);

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          selectedAgent={selectedAgent}
        />

        <AgentCategoryContentSection
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          agentContextById={agentContextById}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          geminiPermissionMode={geminiPermissionMode}
          onGeminiPermissionModeChange={onGeminiPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
