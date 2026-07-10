/**
 * T-822 GATE (tester) — tiny authenticated WS client for the real WS-seat server.
 * Connects to ws://127.0.0.1:<port>/ws?token=<jwt>, sends ONE claude-command that
 * resumes <sid> (so runClaudeSDKQuery takes the real per-conversation lock), and
 * resolves when the turn's `kind:'complete'` (or an error) arrives. Prints a JSON
 * line: {opened, completed, error, kind, waitedOpenMs, turnMs, dropped}. Optional
 * --drop-after-ms abruptly TERMINATES the socket mid-turn (adversarial: prove the
 * claude-sdk.js finally still releases the flock on a mid-turn disconnect).
 *
 * Usage: node ws-client.mjs --url ws://127.0.0.1:PORT/ws --token JWT --sid SID
 *        --cwd PROJECT [--tag N] [--model haiku] [--drop-after-ms MS] [--timeout MS]
 */
import WebSocket from 'ws';

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const url = arg('url');
const token = arg('token');
const sid = arg('sid');
const cwd = arg('cwd');
const tag = arg('tag', '0');
const model = arg('model', 'haiku');
const dropAfterMs = Number.parseInt(arg('drop-after-ms', '0'), 10) || 0;
const timeoutMs = Number.parseInt(arg('timeout', '90000'), 10) || 90000;

const out = { opened: false, completed: false, error: null, kind: null, waitedOpenMs: 0, turnMs: 0, dropped: false, msgs: 0 };
const t0 = Date.now();
let tOpen = 0;
let finished = false;

function finish(extra) {
  if (finished) return;
  finished = true;
  Object.assign(out, extra || {});
  try { ws.terminate(); } catch { /* gone */ }
  process.stdout.write(JSON.stringify(out) + '\n');
  // small delay so the terminate flushes before exit
  setTimeout(() => process.exit(0), 50);
}

const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);

const hardTimer = setTimeout(() => finish({ error: 'client-timeout' }), timeoutMs);

ws.on('open', () => {
  out.opened = true;
  tOpen = Date.now();
  out.waitedOpenMs = tOpen - t0;
  ws.send(JSON.stringify({
    type: 'claude-command',
    command: `قل فقط: دور بشري ${tag}`,
    options: { sessionId: sid, cwd, projectPath: cwd, model },
  }));
  if (dropAfterMs > 0) {
    setTimeout(() => {
      out.dropped = true;
      try { ws.terminate(); } catch { /* gone */ }
      // give the server's finally a moment, then report
      setTimeout(() => finish({ turnMs: Date.now() - tOpen }), 200);
    }, dropAfterMs);
  }
});

ws.on('message', (raw) => {
  out.msgs++;
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  const kind = m.kind || m.type;
  if (kind === 'complete') {
    clearTimeout(hardTimer);
    finish({ completed: true, kind: 'complete', turnMs: Date.now() - tOpen, exitCode: m.exitCode });
  } else if (kind === 'error' || m.code === 'conversation_not_found') {
    clearTimeout(hardTimer);
    finish({ error: m.code || m.content || 'error', kind: 'error', turnMs: Date.now() - tOpen });
  }
});

ws.on('close', () => {
  if (!finished && !dropAfterMs) finish({ error: 'socket-closed' });
});
ws.on('error', (e) => {
  if (!finished) finish({ error: 'ws-error: ' + (e?.message || String(e)) });
});
