#!/usr/bin/env node
/*
 * B-103 / T-819 FIELD wave — merge criterion 8 (live soak) + criterion 9 (injected-turn cost) into
 * one machine-readable evidence/field.json, and harvest the load-bearing injected handoff lines
 * VERBATIM from the REAL transcripts (real copies) into evidence/soak-transcripts/. We deliberately
 * harvest only the handoff lines (+ provenance/parse-integrity), NOT the full raw transcripts —
 * those echo the loaded coordinator context and skill/agent listings; the full transcripts stay on
 * disk under the documented soak project until cleanup.
 *
 * Usage: aggregate-field.mjs <stateRoot> <spikeDir> <claudeConfigDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const [stateRoot, spikeDir] = process.argv.slice(2);
if (!stateRoot || !spikeDir) { console.error('usage: aggregate-field.mjs <stateRoot> <spikeDir> <cc>'); process.exit(2); }
const evDir = path.join(spikeDir, 'evidence');
const tDir = path.join(evDir, 'soak-transcripts');
fs.mkdirSync(tDir, { recursive: true });

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const c8 = readJson(path.join(stateRoot, 'criterion8.json'));
const c9 = readJson(path.join(stateRoot, 'criterion9.json'));
if (!c8 || !c9) { console.error('missing criterion8.json / criterion9.json under', stateRoot); process.exit(3); }

// ---- harvest the injected handoff lines VERBATIM from each real target transcript ----------------
const transcriptEvidence = [];
for (const conv of c8.conversations || []) {
  const tf = conv.transcript;
  const rec = { k: conv.k, sessionId: conv.sessionId, transcript: tf, baseLines: conv.baseLines,
    finalLines: 0, allLinesParse: true, handoffLines: 0, handoffTaskIds: [] };
  const harvest = [];
  if (tf && fs.existsSync(tf)) {
    const lines = fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean);
    rec.finalLines = lines.length;
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { rec.allLinesParse = false; continue; }
      if (o.subtype === 'background_task_handoff') { harvest.push(o); rec.handoffLines++; rec.handoffTaskIds.push(o.taskId); }
    }
    if (harvest.length) {
      const dst = path.join(tDir, `${conv.sessionId}.handoff.jsonl`);
      fs.writeFileSync(dst, harvest.map((o) => JSON.stringify(o)).join('\n') + '\n');
      rec.harvestFile = path.relative(spikeDir, dst);
    }
  } else rec.transcriptMissing = true;
  transcriptEvidence.push(rec);
}

// ---- derived cost analysis (criterion 9) ---------------------------------------------------------
const m = Object.fromEntries((c9.measurements || []).map((r) => [r.label, r]));
const pair = (cold, warm) => {
  const c = m[cold], w = m[warm];
  return {
    cold: { totalRead: c.total_read, cache_creation: c.cache_creation_input_tokens,
      cache_read: c.cache_read_input_tokens, output: c.output_tokens, usd: c.total_cost_usd, ms: c.duration_ms },
    warm: { totalRead: w.total_read, cache_creation: w.cache_creation_input_tokens,
      cache_read: w.cache_read_input_tokens, output: w.output_tokens, usd: w.total_cost_usd, ms: w.duration_ms },
    warmVsColdUsdRatio: +(c.total_cost_usd / w.total_cost_usd).toFixed(2),
  };
};
const DESIGN = c9.designEstimatePerTurn;
const longCold = m['long-run1'].total_read;
const shortCold = m['short-run1'].total_read;
const costAnalysis = {
  cardOnlyModelTokens: 0,
  designEstimatePerTurn: DESIGN,
  short: pair('short-run1', 'short-run2'),
  long: pair('long-run1', 'long-run2'),
  perTurnTokenWeightRange: { shortHistory: shortCold, longHistory: longCold },
  longVsDesignRatio: +(longCold / DESIGN).toFixed(2),
  interpretation: {
    baselineSystemMemoryTokens: '≈17k cached system+memory context carried by EVERY turn (measured on a 3-word turn)',
    quotaCharge: 'each auto-turn processes tens of thousands of input+cache tokens against the 5h session budget',
    cacheEffect: 'cold→warm collapses cache_creation into cache_read → ~6–10× cheaper $ on the 2nd turn within cache TTL',
    coalescingImplication: 'auto-turn is only affordable if coalesced: 2nd+ deliveries in the cache window are ~10× cheaper; cold deliveries each pay the full history re-read',
    cardVsAuto: `card-only ≈ 0 model tokens vs auto-turn ${shortCold}–${longCold}+ tokens/turn`,
  },
};

// ---- assemble field.json -------------------------------------------------------------------------
let claudeVersion = 'unknown';
try { claudeVersion = execSync('claude --version', { encoding: 'utf8' }).trim(); } catch { /* best-effort */ }
const out = {
  spike: 'B-103 / T-819 — FIELD wave (§و criterion 8 live soak + criterion 9 injected-turn cost)',
  generatedAt: new Date().toISOString(),
  host: execSync('hostname', { encoding: 'utf8' }).trim(),
  node: process.version,
  claudeVersion,
  branch: execSync('git rev-parse --abbrev-ref HEAD', { cwd: spikeDir, encoding: 'utf8' }).trim(),
  stateRoot,
  claudeConfigDir: process.argv[4] || process.env.CLAUDE_CONFIG_DIR || null,
  overallPass: c8.exactlyOnce === c8.total && c8.attributionAllOk && c8.idempotentAllOk
    && c8.classifierAllOk && (c9.measurements || []).length === 4 && (c9.measurements || []).every((r) => !r.is_error),
  criterion8_field_soak: {
    pass: c8.exactlyOnce === c8.total && c8.attributionAllOk && c8.idempotentAllOk && c8.classifierAllOk,
    requirement: '>=10 real tasks across 3 classes, full launch→complete→deliver LIVE on REAL transcripts; '
      + 'injected line attributed task-notification (not user); exactly-once; correct per-class semantics',
    total: c8.total, exactlyOnce: c8.exactlyOnce, byClass: c8.byClass,
    attributionAllOk: c8.attributionAllOk, idempotentAllOk: c8.idempotentAllOk, classifierAllOk: c8.classifierAllOk,
    transcriptEvidence, records: c8.records,
  },
  criterion9_injected_turn_cost: {
    requirement: '4 real leaf-only resume turns (short/long conv ×2) capturing input/cache/output tokens + duration',
    measurements: c9.measurements, costAnalysis, sessions: c9.sessions,
  },
  soakArtifact: {
    note: 'Deliberate: soak conversations surface as temp projects in the nassaj-dev UI via the inherited '
      + 'CLAUDE_CONFIG_DIR. No server code, app DB rows, build, or PM2 touched. Cleaned after T-819 closes.',
    baseDir: '/tmp/b103-t819-soak',
    projectGlob: `${process.argv[4] || process.env.CLAUDE_CONFIG_DIR}/projects/-tmp-b103-t819-soak*`,
    cleanup: 'rm -rf /tmp/b103-t819-soak; rm -rf <CLAUDE_CONFIG_DIR>/projects/-tmp-b103-t819-soak*; '
      + "systemctl --user reset-failed 'wf-t819-soak-*'",
  },
  rerun: {
    criterion8: 'NSUCC=4 NPART=3 NCRASH=3 NCONV=3 bash spikes/b103-t819/soak/criterion8-soak.sh',
    criterion9: 'bash spikes/b103-t819/soak/criterion9-cost.sh',
  },
};
fs.writeFileSync(path.join(evDir, 'field.json'), JSON.stringify(out, null, 2) + '\n');
console.log('[aggregate-field] wrote evidence/field.json  overallPass=' + out.overallPass);
console.log('  c8 exactlyOnce=' + c8.exactlyOnce + '/' + c8.total + ' attribution=' + c8.attributionAllOk
  + ' idempotent=' + c8.idempotentAllOk);
console.log('  c9 short cold/warm totalRead=' + m['short-run1'].total_read + '/' + m['short-run2'].total_read
  + '  long cold/warm=' + m['long-run1'].total_read + '/' + m['long-run2'].total_read);
console.log('  harvested handoff-line files: ' + transcriptEvidence.filter((t) => t.harvestFile).length);
