#!/usr/bin/env node
/*
 * T-821 shadow harness — upsert a claude SESSION row so the monitor's C2 gate
 * (verifyDeliveryTarget) resolves the conversation to an OWNED project and the
 * AUTHORITATIVE jsonl path, and so GET /sessions/:id/messages can read the card
 * back (the path the UI reads). Creates the empty transcript file too.
 *
 * Usage: node seed-session.mjs <conversationId> <projectPath> <jsonlPath>
 *   env: DB_INDEX, DATABASE_PATH, HOME
 */

import fs from 'node:fs';
import path from 'node:path';

const [conversationId, projectPath, jsonlPath] = process.argv.slice(2);
if (!conversationId || !projectPath || !jsonlPath) {
  console.error('usage: seed-session.mjs <conversationId> <projectPath> <jsonlPath>');
  process.exit(2);
}

const { initializeDatabase, sessionsDb, closeConnection } = await import(process.env.DB_INDEX);
await initializeDatabase();

fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
if (!fs.existsSync(jsonlPath)) {
  fs.writeFileSync(jsonlPath, '');
}

sessionsDb.createSession(conversationId, 'claude', projectPath, null, undefined, undefined, jsonlPath);

const row = sessionsDb.getSessionById(conversationId);
closeConnection();
console.log(JSON.stringify({ conversationId, jsonl_path: row?.jsonl_path, project_path: row?.project_path }));
