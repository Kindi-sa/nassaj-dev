#!/usr/bin/env node
// SPIKE harness — replicates queryCodex (server/openai-codex.js) EXACTLY using
// @openai/codex-sdk, pointed at an isolated CODEX_HOME. NOT production.
// env in: SPIKE_HOME, RUN_CWD, SANDBOX, SPIKE_MODEL, PROMPT, OUT
import { Codex } from '/home/nassaj/Project/nassaj-dev/node_modules/@openai/codex-sdk/dist/index.js';
import fs from 'fs';

const SPIKE_HOME = process.env.SPIKE_HOME;
const RUN_CWD    = process.env.RUN_CWD;
const SANDBOX    = process.env.SANDBOX || 'danger-full-access';
const MODEL      = process.env.SPIKE_MODEL || 'gpt-5.6-sol';
const PROMPT     = process.env.PROMPT;
const OUT        = process.env.OUT;

const out = fs.createWriteStream(OUT, { flags: 'w' });
const w = (o) => out.write(JSON.stringify(o) + '\n');

const codex = new Codex({
  // faithful to queryCodex: spread full env (resolveProviderEnv spreads process.env),
  // override CODEX_HOME to the isolated spike home.
  env: { ...process.env, CODEX_HOME: SPIKE_HOME },
  // queryCodex passes { project_doc_max_bytes: 0 }; we add agents.max_depth=1 for Gate 2.
  config: { project_doc_max_bytes: 0, agents: { max_depth: 1 } },
});

const thread = codex.startThread({
  workingDirectory: RUN_CWD,
  skipGitRepoCheck: true,
  sandboxMode: SANDBOX,
  approvalPolicy: 'never',
  model: MODEL,
});

try {
  const { events } = await thread.runStreamed(PROMPT);
  for await (const ev of events) {
    w(ev);
  }
  w({ _harness: 'done', thread_id: thread.id });
} catch (e) {
  w({ _harness: 'error', message: String(e && e.message || e) });
  process.exitCode = 1;
} finally {
  out.end();
}
