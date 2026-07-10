#!/usr/bin/env node
/*
 * Append one merged run record (metadata + classifier verdict) as a JSON line.
 * Usage: node _record.mjs <recordsFile> <classifyJsonFile>
 * Metadata comes from REC_* env vars to avoid bash JSON-escaping pitfalls.
 */
import fs from 'node:fs';

const [recordsFile, classifyFile] = process.argv.slice(2);
const classify = JSON.parse(fs.readFileSync(classifyFile, 'utf8'));
const expected = process.env.REC_EXPECTED || null;
// expected may be a "|"-separated SET of acceptable verdicts (e.g. criterion 3, where
// both CRASHED and PARTIAL-untrusted are decisive-correct per §أ-3).
const expectedSet = expected ? expected.split('|') : null;

const rec = {
  taskId: process.env.REC_TASKID || null,
  expected,
  classification: classify.classification,
  correct: expectedSet ? expectedSet.includes(classify.classification) : null,
  reason: classify.reason,
  unitState: classify.unitState,
  resultPresent: classify.resultPresent,
  partialPresent: classify.partialPresent,
  graceApplied: classify.graceApplied,
  doneExitCode: classify.done ? classify.done.exit_code : null,
  claudeExit: process.env.REC_CLAUDE_EXIT ? Number.parseInt(process.env.REC_CLAUDE_EXIT, 10) : null,
  killInfo: process.env.REC_KILL_INFO || null,
  classifyMs: process.env.REC_CLASSIFY_MS ? Number.parseInt(process.env.REC_CLASSIFY_MS, 10) : null,
  windowHit: process.env.REC_WINDOW_HIT || null,
};
fs.appendFileSync(recordsFile, JSON.stringify(rec) + '\n');
