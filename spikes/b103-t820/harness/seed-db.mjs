#!/usr/bin/env node
/*
 * T-820 shadow harness — seed the TEMP database with an owner, a stranger, and a
 * project the owner owns. Runs under the shadow env (HOME + DATABASE_PATH point
 * at temp). Prints the effective DB path (FROM THIS PROCESS — the isolation
 * proof the design demands: do not trust inheritance) and the seeded ids as JSON.
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

const { initializeDatabase, userDb, projectsDb, closeConnection, getDatabasePath } = await import(
  dbIndex
);

await initializeDatabase();

// The effective DB path AS RESOLVED BY THIS PROCESS — must be the temp one.
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

// Fresh, deterministic users. If a legacy-migrated DB already carries a same-name
// user, suffix to stay unique for this run.
const stamp = Date.now().toString(36);
const owner = userDb.createUser(`t820-owner-${stamp}`, 'x', 'owner');
const stranger = userDb.createUser(`t820-stranger-${stamp}`, 'x', 'user');
projectsDb.createProjectPath(projectPath, null, owner.id);

// Sanity: the ownership predicate the route/GATE2 use must agree.
const owns = projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, owner.id);
const strangerOwns = projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, stranger.id);
if (!owns || strangerOwns) {
  console.error(JSON.stringify({ fatal: 'ownership seed inconsistent', owns, strangerOwns }));
  process.exit(4);
}

closeConnection();

console.log(
  JSON.stringify({
    effectiveDbPath,
    ownerId: owner.id,
    strangerId: stranger.id,
    projectPath,
  }),
);
