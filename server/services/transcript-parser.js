/**
 * Transcript parser — extracts the non-human actors (the base model and any
 * spawned subagents) from a session transcript, parse-on-demand with an
 * mtime-keyed cache.
 *
 * Design:
 *   - The cache (session_agents_cache + session_agents_meta) is keyed on the
 *     transcript file's mtime. A read first stats the file; if the stored mtime
 *     matches, the cached rows are returned without touching the file.
 *   - On a miss the transcript is streamed line by line (transcripts can be
 *     large) and:
 *       * the model of the first `assistant` entry → one 'model' agent
 *       * every `tool_use` block named 'Agent' (or 'Task') → a 'subagent' agent
 *         named by its `subagent_type`, counted by occurrence
 *   - For antigravity (`agy`) sessions there is no structured model/subagent
 *     metadata in the transcript, so we record a single 'model' agent named
 *     'agy' per the tracking spec.
 *
 * The parser never throws on bad input: unreadable files yield an empty result,
 * malformed lines are skipped.
 */

import fs from 'fs';
import readline from 'readline';

import { sessionAgentsDb } from '../modules/database/index.js';

const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Streams a Claude/Codex-style JSONL transcript and tallies model + subagents.
 * @param {string} transcriptPath
 * @returns {Promise<Array<{agent_name: string, agent_kind: 'model'|'subagent', invocation_count: number}>>}
 */
async function parseClaudeStyleTranscript(transcriptPath) {
  let model = null;
  const subagentCounts = new Map();

  const fileStream = fs.createReadStream(transcriptPath);
  const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const rawLine of lineReader) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const message = entry.message;
    if (!message || typeof message !== 'object') continue;

    // First real assistant model wins. Skip the synthetic placeholder model the
    // SDK emits for tool-only / interrupted turns.
    if (
      model === null &&
      entry.type === 'assistant' &&
      typeof message.model === 'string' &&
      message.model.length > 0 &&
      message.model !== SYNTHETIC_MODEL
    ) {
      model = message.model;
    }

    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'tool_use') continue;
      // Subagent spawns surface as the 'Agent' tool (legacy: 'Task').
      if (block.name !== 'Agent' && block.name !== 'Task') continue;

      const subagentType = block.input && typeof block.input === 'object'
        ? block.input.subagent_type
        : null;
      if (typeof subagentType !== 'string' || subagentType.length === 0) continue;

      subagentCounts.set(subagentType, (subagentCounts.get(subagentType) || 0) + 1);
    }
  }

  const agents = [];
  if (model) {
    agents.push({ agent_name: model, agent_kind: 'model', invocation_count: 1 });
  }
  for (const [name, count] of subagentCounts) {
    agents.push({ agent_name: name, agent_kind: 'subagent', invocation_count: count });
  }
  return agents;
}

/**
 * Resolves the agents for an antigravity session. agy transcripts carry no
 * model/subagent metadata, so the actor set is the single base model 'agy'.
 * @returns {Array<{agent_name: string, agent_kind: 'model', invocation_count: number}>}
 */
function parseAgySession() {
  return [{ agent_name: 'agy', agent_kind: 'model', invocation_count: 1 }];
}

/**
 * Returns the agents (model + subagents) for a session, using the mtime-keyed
 * cache and re-parsing only when the transcript has changed.
 *
 * @param {string} sessionId
 * @param {string|null|undefined} transcriptPath  Absolute path to the .jsonl transcript.
 * @param {{ provider?: string }} [options]
 * @returns {Promise<Array<{agent_name: string, agent_kind: 'model'|'subagent', invocation_count: number}>>}
 */
export async function getSessionAgents(sessionId, transcriptPath, options = {}) {
  if (!sessionId) {
    return [];
  }

  const provider = (options.provider || '').toLowerCase();

  // antigravity has no on-disk model/subagent structure; record 'agy' once and
  // key the cache on the transcript mtime when available, else on 0.
  if (provider === 'antigravity') {
    let mtime = 0;
    if (transcriptPath) {
      try {
        mtime = Math.floor(fs.statSync(transcriptPath).mtimeMs);
      } catch {
        mtime = 0;
      }
    }
    const cachedMeta = sessionAgentsDb.getMeta(sessionId);
    if (cachedMeta !== null && cachedMeta === mtime) {
      return sessionAgentsDb.listBySession(sessionId);
    }
    const agents = parseAgySession();
    sessionAgentsDb.replaceForSession(sessionId, agents, mtime);
    return agents;
  }

  if (!transcriptPath) {
    // Without a transcript file we can still serve a previously parsed cache.
    return sessionAgentsDb.listBySession(sessionId);
  }

  let mtime;
  try {
    mtime = Math.floor(fs.statSync(transcriptPath).mtimeMs);
  } catch {
    // Missing/unreadable transcript: fall back to whatever was cached before.
    return sessionAgentsDb.listBySession(sessionId);
  }

  const cachedMeta = sessionAgentsDb.getMeta(sessionId);
  if (cachedMeta !== null && cachedMeta === mtime) {
    return sessionAgentsDb.listBySession(sessionId);
  }

  let agents;
  try {
    agents = await parseClaudeStyleTranscript(transcriptPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to parse transcript for agents', { sessionId, error: message });
    return sessionAgentsDb.listBySession(sessionId);
  }

  sessionAgentsDb.replaceForSession(sessionId, agents, mtime);
  return agents;
}
