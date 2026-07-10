#!/usr/bin/env node
/*
 * Merge the four consumer criterion summaries into the machine-readable evidence file
 * spikes/b103-t819/evidence/consumer.json (§و/المرحلة 1 معايير 4-7). pass=true ONLY when the
 * measured thresholds are actually met.
 * Usage: node aggregate-consumer-evidence.mjs <c4> <c5> <c6> <c7> <convFixturesDir> <out> <stateRoot> <claudeVersion>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [c4f, c5f, c6f, c7f, convDir, outFile, stateRoot, claudeVersion] = process.argv.slice(2);
const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const c4 = rd(c4f), c5 = rd(c5f), c6 = rd(c6f), c7 = rd(c7f);

const c4pass = c4.tasks >= 1 && c4.repeatsPerTask >= 5
  && c4.exactlyOneHandoff === c4.tasks && c4.doubles === 0 && c4.lost === 0;

const c5pass = c5.iterations >= 1 && c5.tornDerivedFromRealTranscripts === true
  && c5.tornStatesValid === c5.iterations
  && c5.jsonRecoveredExactlyOnce === c5.iterations && c5.jsonDoubles === 0 && c5.jsonLost === 0
  && c5.regexLostCount === c5.iterations; // negative control: regex MUST lose on every torn line

const c6pass = c6.attempts >= 10 && c6.deliveredExactlyOnce === c6.attempts
  && c6.doubles === 0 && c6.lost === 0 && c6.injectLedgerGapKills >= 1; // dangerous window truly hit

const c7pass = c7.pass === true
  && c7.firstAcquired === true && c7.secondQuietExit === true && c7.reacquireAfterDeath === true;

const convFixtures = fs.existsSync(convDir)
  ? fs.readdirSync(convDir).filter((f) => f.startsWith('conversation-') && f.endsWith('.jsonl')) : [];

const SPIKE = 'spikes/b103-t819';
const evidence = {
  spike: 'B-103 / T-819 — consumer + supervisor side (§و criteria 4, 5, 6, 7)',
  generatedAt: new Date().toISOString(),
  host: os.hostname(),
  node: process.version,
  claudeVersion: claudeVersion || null,
  branch: 'fix/security-remediation-2026-07-09',
  stateRoot,
  overallPass: c4pass && c5pass && c6pass && c7pass,
  atomicWritePath: 'lib/capture-writer.mjs::writeFileAtomic (same tmp→fsync→rename→fsync-dir that seal() uses for DONE)',
  criteria: {
    '4_delivery_idempotency': {
      pass: c4pass,
      requirement: 'repeat finalize N>=5 on one task folder ⇒ exactly one handoffId (one valid line, one ledger entry, one injection)',
      tasks: c4.tasks, repeatsPerTask: c4.repeatsPerTask,
      exactlyOneHandoff: c4.exactlyOneHandoff, doubles: c4.doubles, lost: c4.lost,
    },
    '5_torn_jsonl_dedup': {
      pass: c5pass,
      requirement: 'half-written handoffId line in a REAL <conversationId>.jsonl ⇒ JSON.parse (not regex) treats it "not delivered" + idempotent ledger retry ⇒ 0 double, 0 lost; regex control MUST lose',
      iterations: c5.iterations, tornDerivedFromRealTranscripts: c5.tornDerivedFromRealTranscripts,
      tornStatesValid: c5.tornStatesValid,
      jsonRecoveredExactlyOnce: c5.jsonRecoveredExactlyOnce, jsonDoubles: c5.jsonDoubles, jsonLost: c5.jsonLost,
      regexLostCount: c5.regexLostCount, offsetSpread: c5.offsetSpread,
      note: 'regexLostCount === iterations proves the design\'s JSON.parse-not-regex rule is load-bearing (reconcile 6.5% analog).',
    },
    '6_supervisor_resilience': {
      pass: c6pass,
      requirement: '>=10 real runs: kill -9 supervisor at random offsets (+ targeted inject→ledger gap) then restart ⇒ re-bind + deliver exactly once, 0 double/0 lost',
      attempts: c6.attempts, restarts: c6.restarts,
      deliveredExactlyOnce: c6.deliveredExactlyOnce, doubles: c6.doubles, lost: c6.lost,
      injectLedgerGapKills: c6.injectLedgerGapKills, killWindowDistribution: c6.killWindowDistribution,
      note: 'ground truth of delivery count = valid handoff lines in jsonl (a supervisor killed inside the gap injects the line but dies before logging its action).',
    },
    '7_single_owner_flock': {
      pass: c7pass,
      requirement: 'two concurrent supervisors ⇒ one runs, the other exits quietly; lock freed on death (kill -9)',
      firstAcquired: c7.firstAcquired, secondQuietExit: c7.secondQuietExit,
      secondExitCode: c7.secondExitCode, secondRanLoop: c7.secondRanLoop,
      reacquireAfterDeath: c7.reacquireAfterDeath,
    },
  },
  fixtures: { conversationDir: `${SPIKE}/fixtures`, conversationCount: convFixtures.length, conversationFiles: convFixtures },
  rerun: {
    criterion4_offline_no_llm: `STATE_ROOT=/tmp/b103-verify-c4 bash ${SPIKE}/tests/criterion4-idempotency.sh`,
    criterion5_offline_no_llm: `STATE_ROOT=/tmp/b103-verify-c5 bash ${SPIKE}/tests/criterion5-torn-jsonl.sh`,
    criterion6_real_llm: `STATE_ROOT=/tmp/b103-verify-c6 bash ${SPIKE}/tests/criterion6-supervisor-resilience.sh`,
    criterion7_offline_no_llm: `STATE_ROOT=/tmp/b103-verify-c7 bash ${SPIKE}/tests/criterion7-flock.sh`,
    full: `bash ${SPIKE}/tests/run-consumer.sh`,
  },
  records: { criterion4: c4.records, criterion5: c5.records, criterion6: c6.records },
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
console.log(`[consumer-evidence] overallPass=${evidence.overallPass} c4=${c4pass} c5=${c5pass} c6=${c6pass} c7=${c7pass} → ${outFile}`);
