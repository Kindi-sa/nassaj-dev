#!/usr/bin/env node
/*
 * B-103 / T-819 consumer spike — thin CLI over lib/handoff.mjs so bash criterion scripts and
 * the supervisor exercise the SAME delivery code (no logic here).
 *
 * Subcommands:
 *   --finalize  --state-root R --task-json T --jsonl J --result F
 *               [--matcher json|regex] [--tear-at-offset K] [--widen-ms W] [--marker P]
 *               [--outcome SUCCEEDED|PARTIAL|CRASHED]
 *        Run finalizeDelivery once; print the action JSON. May SIGKILL self if --tear-at-offset.
 *   --scan      --jsonl J --handoff-id H [--matcher json|regex]
 *        Print scanJsonl counters (validMatchCount / regexMatchCount / tornLines).
 *   --hid --task-id ID           print the deterministic handoffId.
 */
import fs from 'node:fs';
import { finalizeDelivery, scanJsonl, handoffId } from '../lib/handoff.mjs';

function parse(argv) {
  const a = { cmd: null, stateRoot: null, taskJson: null, jsonl: null, result: null,
    matcher: 'json', tearAtOffset: null, widenMs: 0, marker: null, outcome: 'SUCCEEDED',
    handoffIdArg: null, taskId: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--finalize') a.cmd = 'finalize';
    else if (t === '--scan') a.cmd = 'scan';
    else if (t === '--hid') a.cmd = 'hid';
    else if (t === '--state-root') a.stateRoot = argv[++i];
    else if (t === '--task-json') a.taskJson = argv[++i];
    else if (t === '--jsonl') a.jsonl = argv[++i];
    else if (t === '--result') a.result = argv[++i];
    else if (t === '--matcher') a.matcher = argv[++i];
    else if (t === '--tear-at-offset') a.tearAtOffset = Number.parseInt(argv[++i], 10);
    else if (t === '--widen-ms') a.widenMs = Number.parseInt(argv[++i], 10);
    else if (t === '--marker') a.marker = argv[++i];
    else if (t === '--outcome') a.outcome = argv[++i];
    else if (t === '--handoff-id') a.handoffIdArg = argv[++i];
    else if (t === '--task-id') a.taskId = argv[++i];
    else throw new Error(`unknown arg: ${t}`);
  }
  if (!a.cmd) throw new Error('subcommand required: --finalize | --scan | --hid');
  return a;
}

function main() {
  const a = parse(process.argv.slice(2));
  if (a.cmd === 'hid') { process.stdout.write(handoffId(a.taskId) + '\n'); return; }
  if (a.cmd === 'scan') {
    const r = scanJsonl(a.jsonl, a.handoffIdArg, { matcher: a.matcher });
    process.stdout.write(JSON.stringify(r) + '\n'); return;
  }
  // finalize
  const task = JSON.parse(fs.readFileSync(a.taskJson, 'utf8'));
  const resultObj = a.result && fs.existsSync(a.result)
    ? JSON.parse(fs.readFileSync(a.result, 'utf8')) : { note: 'no result.json', taskId: task.taskId };
  const action = finalizeDelivery(
    { stateRoot: a.stateRoot, task, jsonlPath: a.jsonl, resultObj, outcome: a.outcome },
    { matcher: a.matcher, tearAtOffset: a.tearAtOffset, widenMs: a.widenMs, injectedMarkerPath: a.marker },
  );
  process.stdout.write(JSON.stringify(action) + '\n');
}

main();
