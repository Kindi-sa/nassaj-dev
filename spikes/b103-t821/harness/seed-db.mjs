#!/usr/bin/env node
/*
 * T-821 shadow harness — seed the TEMP database with the OWNER (a project owner),
 * a STRANGER, and a project the owner owns. Prints the effective DB path (FROM
 * THIS PROCESS — the isolation proof) and the seeded ids as JSON. Runs under the
 * shadow env (HOME + DATABASE_PATH point at temp).
 *
 * Usage: node seed-db.mjs <projectPath>
 *   env: DB_INDEX=<abs path to built database/index.js>, DATABASE_PATH, HOME
 */

const projectPath = process.argv[2];
if (!projectPath) {
  console.error('usage: seed-db.mjs <projectPath>');
  process.exit(2);
}

const dbIndex = process.env.DB_INDEX;
if (!dbIndex) {
  console.error('DB_INDEX env (abs path to built database/index.js) is required');
  process.exit(2);
}

const { initializeDatabase, userDb, projectsDb, closeConnection, getDatabasePath } =
  await import(dbIndex);

await initializeDatabase();

const effectiveDbPath = getDatabasePath();
if (effectiveDbPath !== process.env.DATABASE_PATH) {
  console.error(
    JSON.stringify({
      fatal: 'DB path mismatch — the process did NOT resolve the temp DB',
      effectiveDbPath,
      expected: process.env.DATABASE_PATH,
    }),
  );
  process.exit(3);
}

const stamp = Date.now().toString(36);
const owner = userDb.createUser(`t821-owner-${stamp}`, 'x', 'owner');
const stranger = userDb.createUser(`t821-stranger-${stamp}`, 'x', 'user');
projectsDb.createProjectPath(projectPath, null, owner.id);

const owns = projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, owner.id);
const strangerOwns = projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, stranger.id);
if (!owns || strangerOwns) {
  console.error(JSON.stringify({ fatal: 'ownership seed inconsistent', owns, strangerOwns }));
  process.exit(4);
}

closeConnection();

console.log(
  JSON.stringify({ effectiveDbPath, ownerId: owner.id, strangerId: stranger.id, projectPath }),
);
