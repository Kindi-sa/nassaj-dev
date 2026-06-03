import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth
   * priority, reported against the SAME environment a spawn for this user would
   * use. `userId` is resolved through resolveProviderEnv so an isolated user is
   * checked against their own CLAUDE_CONFIG_DIR, while a shared/anonymous check
   * falls back to the operator's ~/.claude — i.e. the status always reflects the
   * real spawn environment instead of a fixed operator path.
   */
  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    // Build the same env the spawn path uses for this user. When claude is
    // shared (admin policy) or there is no user, this returns the base env
    // unchanged so the operator credential at ~/.claude is checked.
    const env = resolveProviderEnv(userId ?? null, 'claude', process.env);
    const credentials = await this.checkCredentials(env);

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Resolves the Claude config directory for the given (already-resolved) env.
   * Honors CLAUDE_CONFIG_DIR (set by resolveProviderEnv when isolated) and falls
   * back to the operator's ~/.claude when unset (shared / anonymous).
   */
  private resolveConfigDir(env: NodeJS.ProcessEnv): string {
    const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR);
    return configDir ?? path.join(os.homedir(), '.claude');
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server
   * process env is empty. Reads from the resolved config dir so an isolated
   * user's own settings.json is consulted.
   */
  private async loadSettingsEnv(configDir: string): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(configDir, 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code,
   * against the resolved environment for the user being checked.
   */
  private async checkCredentials(env: NodeJS.ProcessEnv): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    if (readOptionalString(env.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const configDir = this.resolveConfigDir(env);

    const settingsEnv = await this.loadSettingsEnv(configDir);
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    try {
      const credPath = path.join(configDir, '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }
}
