/**
 * T-822 shadow DB seeder (tsx, SOURCE db module — no dist-server touch). Seeds the
 * temp DB and asserts, FROM THIS PROCESS, that the effective DB is the temp one.
 *   seed-owner-project <projectPath>   → {ownerId, strangerId, effectiveDbPath}
 *   seed-session <conv> <projectPath> <jsonlPath>  → {jsonl_path, project_path}
 * env: DATABASE_PATH (temp), HOME (temp).
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  initializeDatabase,
  userDb,
  projectsDb,
  sessionsDb,
  getDatabasePath,
  closeConnection,
} from '@/modules/database/index.js';

async function main(): Promise<void> {
  const cmd = process.argv[2];
  await initializeDatabase();

  const effectiveDbPath = getDatabasePath();
  if (effectiveDbPath !== process.env.DATABASE_PATH) {
    process.stderr.write(JSON.stringify({ fatal: 'DB path mismatch', effectiveDbPath, expected: process.env.DATABASE_PATH }) + '\n');
    process.exit(3);
  }

  if (cmd === 'seed-owner-project') {
    const projectPath = process.argv[3]!;
    const stamp = Date.now().toString(36);
    const owner = userDb.createUser(`t822-owner-${stamp}`, 'x', 'owner');
    const stranger = userDb.createUser(`t822-stranger-${stamp}`, 'x', 'user');
    projectsDb.createProjectPath(projectPath, null, owner.id);
    const owns = projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, owner.id);
    if (!owns) {
      process.stderr.write(JSON.stringify({ fatal: 'ownership seed inconsistent' }) + '\n');
      process.exit(4);
    }
    closeConnection();
    process.stdout.write(JSON.stringify({ effectiveDbPath, ownerId: owner.id, strangerId: stranger.id, projectPath }) + '\n');
  } else if (cmd === 'seed-session') {
    const [conv, projectPath, jsonlPath] = process.argv.slice(3);
    fs.mkdirSync(path.dirname(jsonlPath!), { recursive: true });
    if (!fs.existsSync(jsonlPath!)) {
      fs.writeFileSync(jsonlPath!, '');
    }
    sessionsDb.createSession(conv!, 'claude', projectPath!, null, undefined, undefined, jsonlPath!);
    const row = sessionsDb.getSessionById(conv!);
    closeConnection();
    process.stdout.write(JSON.stringify({ conversationId: conv, jsonl_path: row?.jsonl_path, project_path: row?.project_path }) + '\n');
  } else {
    process.stderr.write(`unknown db command: ${String(cmd)}\n`);
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`db driver error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
