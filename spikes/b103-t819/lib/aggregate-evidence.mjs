#!/usr/bin/env node
/*
 * Merge the three criterion summaries into a machine-readable evidence file that the
 * consumer wave (criteria 4-9) depends on: spikes/b103-t819/evidence/producer.json.
 * Usage: node aggregate-evidence.mjs <c1.json> <c2.json> <c3.json> <fixturesDir> <out> <stateRoot> <claudeVersion>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [c1f, c2f, c3f, fixturesDir, outFile, stateRoot, claudeVersion] = process.argv.slice(2);
const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const c1 = rd(c1f), c2 = rd(c2f), c3 = rd(c3f);

const classesCovered = Object.keys(c1.byClass).length;
const c1pass = c1.total >= 20 && c1.correct === c1.total && classesCovered >= 3
  && Object.values(c1.byClass).every((v) => v.total >= 1);
const c2pass = c2.iterations >= 100 && c2.torn === 0
  && c2.controlsProducedResult === c2.controls && c2.killedBySignal === c2.iterations;
const c3pass = c3.windowHits >= 10 && c3.falseSucceeded === 0 && c3.hung === 0
  && c3.totalDecisive === c3.total && c3.windowVerdictsDecisive === c3.windowRuns
  && c3.skipDonePartialUntrusted === c3.skipDoneRuns;

const fixtures = fs.existsSync(fixturesDir)
  ? fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json')) : [];

const SPIKE = 'spikes/b103-t819';
const evidence = {
  spike: 'B-103 / T-819 — producer side (§و criteria 1, 2, 3)',
  generatedAt: new Date().toISOString(),
  host: os.hostname(),
  node: process.version,
  claudeVersion: claudeVersion || null,
  branch: 'fix/security-remediation-2026-07-09',
  stateRoot,
  overallPass: c1pass && c2pass && c3pass,
  criteria: {
    '1_classification': {
      pass: c1pass,
      requirement: '>=20 real runs across 3 classes, classifier 100% correct',
      total: c1.total, correct: c1.correct, accuracy: c1.accuracy,
      byClass: c1.byClass, fixturesHarvested: c1.fixturesHarvested,
    },
    '2_tearing': {
      pass: c2pass,
      requirement: '100 kill -9 at random byte offsets during result write → 0 torn result.json',
      iterations: c2.iterations, torn: c2.torn, killedBySignal: c2.killedBySignal,
      controls: c2.controls, controlsProducedResult: c2.controlsProducedResult,
      offsetSpread: c2.offsetSpread, fixtureDir: c2.fixtureDir, fixturesAvailable: c2.fixturesAvailable,
      tornOffsets: c2.tornOffsets,
    },
    '3_rename_done_window': {
      pass: c3pass,
      requirement: '>=10 real runs kill -9 in rename→DONE window → decisive (CRASHED|PARTIAL-untrusted), no hang, no false SUCCEEDED',
      windowRuns: c3.windowRuns, windowHits: c3.windowHits,
      windowVerdictsDecisive: c3.windowVerdictsDecisive,
      skipDoneRuns: c3.skipDoneRuns, skipDonePartialUntrusted: c3.skipDonePartialUntrusted,
      totalDecisive: c3.totalDecisive, falseSucceeded: c3.falseSucceeded, hung: c3.hung,
      maxClassifyMs: c3.maxClassifyMs,
      note: 'grace=2000ms in tests; design RECONCILE_GRACE_MS default ~10s. Guarantee holds for any grace.',
    },
  },
  fixtures: { dir: `${SPIKE}/fixtures`, count: fixtures.length, files: fixtures },
  rerun: {
    criterion1_real_llm: `STATE_ROOT=/tmp/b103-verify-c1 bash ${SPIKE}/tests/criterion1-classify.sh`,
    criterion2_offline_no_llm: `STATE_ROOT=/tmp/b103-verify-c2 bash ${SPIKE}/tests/criterion2-tearing.sh`,
    criterion3_real_llm: `STATE_ROOT=/tmp/b103-verify-c3 bash ${SPIKE}/tests/criterion3-window.sh`,
    full: `bash ${SPIKE}/tests/run-all.sh`,
  },
  records: { criterion1: c1.records, criterion3: c3.records },
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
console.log(`[evidence] overallPass=${evidence.overallPass} c1=${c1pass} c2=${c2pass} c3=${c3pass} → ${outFile}`);
