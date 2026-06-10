import type { AgentCategoryContentSectionProps } from '../types';
import type { McpProject } from '../../../../../mcp/types';
import { McpServers } from '../../../../../mcp';

import AccountContent from './content/AccountContent';
import AgyConnectionSection from './content/AgyConnectionSection';
import ClaudeConnectionSection from './content/ClaudeConnectionSection';
import PermissionsContent from './content/PermissionsContent';

export default function AgentCategoryContentSection({
  selectedAgent,
  selectedCategory,
  agentContextById,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  geminiPermissionMode,
  onGeminiPermissionModeChange,
  projects,
}: AgentCategoryContentSectionProps) {
  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-4">
      {selectedCategory === 'account' && (
        <div className="space-y-6">
          <AccountContent
            agent={selectedAgent}
            authStatus={agentContextById[selectedAgent].authStatus}
            onLogin={agentContextById[selectedAgent].onLogin}
          />

          {/* Per-user subscription link (credential isolation, Phase-MU) —
              moved here from the Profile tab so each agent owns its own
              credentials section. */}
          {selectedAgent === 'claude' && <ClaudeConnectionSection />}
          {selectedAgent === 'antigravity' && <AgyConnectionSection />}
        </div>
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'claude' && (
        <PermissionsContent
          agent="claude"
          skipPermissions={claudePermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, skipPermissions: value });
          }}
          allowedTools={claudePermissions.allowedTools}
          onAllowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, allowedTools: value });
          }}
          disallowedTools={claudePermissions.disallowedTools}
          onDisallowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, disallowedTools: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'cursor' && (
        <PermissionsContent
          agent="cursor"
          skipPermissions={cursorPermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, skipPermissions: value });
          }}
          allowedCommands={cursorPermissions.allowedCommands}
          onAllowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, allowedCommands: value });
          }}
          disallowedCommands={cursorPermissions.disallowedCommands}
          onDisallowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, disallowedCommands: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'codex' && (
        <PermissionsContent
          agent="codex"
          permissionMode={codexPermissionMode}
          onPermissionModeChange={onCodexPermissionModeChange}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'gemini' && (
        <PermissionsContent
          agent="gemini"
          permissionMode={geminiPermissionMode}
          onPermissionModeChange={onGeminiPermissionModeChange}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'antigravity' && (
        <PermissionsContent agent="antigravity" />
      )}

      {selectedCategory === 'mcp' && (
        // SettingsProject.name is populated from the DB projectId by
        // normalizeProjectForSettings, so we can map it straight through.
        <McpServers
          selectedProvider={selectedAgent}
          currentProjects={projects.map<McpProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
        />
      )}
    </div>
  );
}
