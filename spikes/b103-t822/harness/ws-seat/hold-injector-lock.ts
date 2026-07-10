/**
 * T-822 GATE (tester) — a faithful 0-claude holder of the SAME per-conversation
 * flock the Tier-B injector takes. Calls the SHIPPED `acquireInjectorTurnLock`
 * (identical non-blocking flock the real injector uses), holds it for --hold-ms,
 * then releases — so a real live WS turn can be forced to contend on a genuinely
 * held injector-side lock WITHOUT spending an LLM turn. Prints {held, reason}.
 */
import { acquireInjectorTurnLock } from '@/modules/workflow-supervisor/chat-turn-lock.js';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

async function main(): Promise<void> {
  const conv = arg('conv');
  const holdMs = Number.parseInt(arg('hold-ms', '8000'), 10) || 8000;
  const lock = await acquireInjectorTurnLock(conv, process.env);
  process.stdout.write(JSON.stringify({ held: lock.held, reason: lock.reason }) + '\n');
  if (!lock.held) {
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, holdMs));
  lock.release();
}

main().catch((e) => {
  process.stderr.write('hold-lock error: ' + (e instanceof Error ? e.message : String(e)) + '\n');
  process.exit(1);
});
