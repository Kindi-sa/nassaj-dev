import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { normalizeSessionName, readObjectRecord } from '@/shared/utils.js';

const ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH = '/__antigravity__';

type ParsedAgyMetadata = {
  sessionId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  transcriptPath: string;
};

/**
 * Session indexer for the Antigravity (agy) CLI brain transcripts.
 *
 * agy stores one chat per UUID under `~/.gemini/antigravity-cli/brain/<UUID>/`
 * with the live transcript at `.system_generated/logs/transcript.jsonl`. This
 * synchronizer scans the brain root, derives session metadata from the first
 * transcript line, and upserts rows so the rest of the app can browse agy
 * conversations like any other provider.
 *
 * Note on `project_path`: agy does not record the workspace inside the transcript.
 * We use a stable placeholder so the FK to `projects` resolves; resolving the
 * real project root is deferred to a later phase.
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'antigravity' as const;
  private readonly brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

  /**
   * Scans agy brain UUIDs and upserts each session that has a transcript file.
   *
   * The `since` filter compares against the transcript mtime so the watcher can
   * cheaply re-sync only conversations that changed after the previous scan.
   */
  async synchronize(since?: Date): Promise<number> {
    let uuids: string[];
    try {
      uuids = await readdir(this.brainDir);
    } catch {
      // The brain directory only appears after the first successful agy run.
      return 0;
    }

    let processed = 0;
    for (const uuid of uuids) {
      const parsed = await this.parseBrainSession(uuid, since);
      if (!parsed) {
        continue;
      }

      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH,
        parsed.title,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.transcriptPath,
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Indexes one agy transcript file. The caller passes the absolute transcript path.
   *
   * Returns the upserted session id, or null when the file is not an agy
   * transcript or its UUID cannot be derived.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('transcript.jsonl')) {
      return null;
    }

    const uuid = this.extractUuidFromTranscriptPath(filePath);
    if (!uuid) {
      return null;
    }

    const parsed = await this.parseBrainSession(uuid, null);
    if (!parsed) {
      return null;
    }

    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH,
      parsed.title,
      parsed.createdAt,
      parsed.updatedAt,
      parsed.transcriptPath,
    );
  }

  /**
   * Reads the transcript for one brain UUID and produces session metadata.
   *
   * - Title comes from the first USER_INPUT `<USER_REQUEST>` body.
   * - `created_at` is read from the first transcript line.
   * - `updated_at` is the transcript file mtime.
   * - When `since` is provided, sessions whose transcript mtime is older are skipped.
   */
  private async parseBrainSession(uuid: string, since: Date | null | undefined): Promise<ParsedAgyMetadata | null> {
    if (!this.isValidUuid(uuid)) {
      return null;
    }

    const transcriptPath = path.join(
      this.brainDir,
      uuid,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(transcriptPath);
    } catch {
      return null;
    }

    if (!fileStat.isFile()) {
      return null;
    }

    if (since && fileStat.mtime <= since) {
      return null;
    }

    let firstLine: AnyRecord | null = null;
    try {
      const content = await readFile(transcriptPath, 'utf8');
      const newlineIndex = content.indexOf('\n');
      const firstLineRaw = newlineIndex >= 0 ? content.slice(0, newlineIndex) : content;
      const trimmed = firstLineRaw.trim();
      if (trimmed) {
        firstLine = readObjectRecord(JSON.parse(trimmed));
      }
    } catch {
      firstLine = null;
    }

    const title = this.extractTitleFromFirstLine(firstLine);
    const createdAtFromTranscript = typeof firstLine?.created_at === 'string'
      ? firstLine.created_at
      : undefined;
    const createdAt = this.toIsoString(createdAtFromTranscript)
      ?? fileStat.birthtime.toISOString();

    return {
      sessionId: uuid,
      title: normalizeSessionName(title, 'New Antigravity Chat'),
      createdAt,
      updatedAt: fileStat.mtime.toISOString(),
      transcriptPath,
    };
  }

  /**
   * Pulls the user prompt out of a USER_INPUT first line for use as the title.
   */
  private extractTitleFromFirstLine(firstLine: AnyRecord | null): string | undefined {
    if (!firstLine || firstLine.type !== 'USER_INPUT') {
      return undefined;
    }

    const rawContent = typeof firstLine.content === 'string' ? firstLine.content : '';
    if (!rawContent) {
      return undefined;
    }

    const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    if (match && typeof match[1] === 'string') {
      const text = match[1].trim();
      return text.length > 0 ? text : undefined;
    }

    return rawContent.trim() || undefined;
  }

  /**
   * Recovers a brain UUID from an absolute transcript path emitted by the watcher.
   */
  private extractUuidFromTranscriptPath(filePath: string): string | null {
    const segments = filePath.split(path.sep);
    const logsIndex = segments.lastIndexOf('logs');
    if (logsIndex < 3) {
      return null;
    }

    const candidate = segments[logsIndex - 2];
    if (!candidate || !this.isValidUuid(candidate)) {
      return null;
    }

    return candidate;
  }

  /**
   * Conservative UUID v4-ish check so we never index hidden files or stray folders.
   */
  private isValidUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  /**
   * Normalizes a transcript timestamp to ISO 8601; returns undefined on bad input.
   */
  private toIsoString(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed.toISOString();
  }
}
