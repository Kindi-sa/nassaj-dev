/**
 * handoff-budget — §د cost governance for Tier-B delivery. A Tier-B turn costs a
 * full ~73k-token turn on the USER's Max-plan session budget (5-hour window), so
 * `card-only` is the default and Tier-B is metered: per-conversation AND per-user
 * DAILY token ceilings, plus a kill switch (config). Over budget ⇒ the injector
 * DEGRADES to a card-only notification (no LLM turn) with an audit line.
 *
 * DAY-BUCKETED, ATOMIC, FILE-ONLY: counters live under `<root>/budget/<UTC-day>/`
 * and are read-merge-written through the SAME proven `writeFileAtomic` primitive
 * the ledger/DONE use, so a crash mid-record can never tear a counter. Pure
 * functions (env + a `now` seam) ⇒ fully unit-testable offline. Buckets are named
 * by day so a periodic sweep (or none) trivially bounds growth; yesterday's file
 * is simply never read again once the day rolls.
 *
 * PRE-CHARGE, NOT POST: the BEFORE check adds a conservative per-turn ESTIMATE to
 * the running total (we cannot know the real cost until the turn runs), so the
 * budget trips slightly EARLY rather than overspending. After the turn the injector
 * records the ACTUAL usage (from the result JSON) so the ledger of spend is honest.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './result-capture-writer.js';
import {
  budgetDir,
  handoffTokensPerConversationMax,
  handoffTokensPerUserMax,
  handoffTurnTokenEstimate,
} from './config.js';

export type Spend = { turns: number; tokens: number };

const ZERO: Spend = { turns: 0, tokens: 0 };

/** UTC day bucket (YYYY-MM-DD) for `now`. */
export function dayBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function bucketDir(env: NodeJS.ProcessEnv, now: number): string {
  return path.join(budgetDir(env), dayBucket(now));
}

/** counter file name for a subject. userId is an integer; conversationId is
 * strict-charset (both validated upstream), so neither can escape the dir. */
function counterFile(kind: 'user' | 'conv', id: string | number): string {
  return `${kind}-${id}.json`;
}

function readCounter(dir: string, name: string): Spend {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<Spend>;
    const turns = Number.isFinite(o.turns) ? Number(o.turns) : 0;
    const tokens = Number.isFinite(o.tokens) ? Number(o.tokens) : 0;
    return { turns, tokens };
  } catch {
    return { ...ZERO };
  }
}

/** Read the current spend for a subject on `now`'s day. Missing ⇒ zero. */
export function readSpend(
  env: NodeJS.ProcessEnv,
  kind: 'user' | 'conv',
  id: string | number,
  now: number = Date.now(),
): Spend {
  return readCounter(bucketDir(env, now), counterFile(kind, id));
}

export type BudgetVerdict =
  | { exceeded: false }
  | {
      exceeded: true;
      scope: 'conversation' | 'user';
      limit: number;
      current: number;
      estimate: number;
    };

/**
 * The BEFORE gate: would injecting ONE turn for this (conversation,user) push
 * either daily ceiling over? Uses the conservative pre-charge estimate. Returns
 * the FIRST ceiling that trips (conversation checked first — the tighter one).
 */
export function wouldExceedBudget(
  env: NodeJS.ProcessEnv,
  input: { userId: number; conversationId: string; estimateTokens?: number },
  now: number = Date.now(),
): BudgetVerdict {
  const estimate = input.estimateTokens ?? handoffTurnTokenEstimate(env);
  const convSpend = readSpend(env, 'conv', input.conversationId, now);
  const convMax = handoffTokensPerConversationMax(env);
  if (convSpend.tokens + estimate > convMax) {
    return {
      exceeded: true,
      scope: 'conversation',
      limit: convMax,
      current: convSpend.tokens,
      estimate,
    };
  }
  const userSpend = readSpend(env, 'user', input.userId, now);
  const userMax = handoffTokensPerUserMax(env);
  if (userSpend.tokens + estimate > userMax) {
    return { exceeded: true, scope: 'user', limit: userMax, current: userSpend.tokens, estimate };
  }
  return { exceeded: false };
}

/** Atomically add (turns, tokens) to one subject's daily counter. */
function addToCounter(
  env: NodeJS.ProcessEnv,
  kind: 'user' | 'conv',
  id: string | number,
  add: Spend,
  now: number,
): void {
  const dir = bucketDir(env, now);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  const name = counterFile(kind, id);
  const prev = readCounter(dir, name);
  const next: Spend = { turns: prev.turns + add.turns, tokens: prev.tokens + add.tokens };
  writeFileAtomic(dir, name, Buffer.from(JSON.stringify(next) + '\n'));
}

/**
 * Record the ACTUAL spend of one delivered turn against BOTH the per-conversation
 * and per-user daily counters (one turn, `tokens` tokens). Best-effort but atomic:
 * an fs failure here must not undo a committed delivery, so callers ignore throws.
 */
export function recordSpend(
  env: NodeJS.ProcessEnv,
  input: { userId: number; conversationId: string; tokens: number; turns?: number },
  now: number = Date.now(),
): void {
  const add: Spend = { turns: input.turns ?? 1, tokens: Math.max(0, Math.round(input.tokens)) };
  addToCounter(env, 'conv', input.conversationId, add, now);
  addToCounter(env, 'user', input.userId, add, now);
}

/**
 * Best-effort token count from a `claude -p --output-format json` result object.
 * Sums input+output(+cache) usage when present; falls back to the configured
 * per-turn estimate so the counter is never under-charged on an odd result shape.
 */
export function tokensFromResult(env: NodeJS.ProcessEnv, resultObj: unknown): number {
  const est = handoffTurnTokenEstimate(env);
  if (!resultObj || typeof resultObj !== 'object') {
    return est;
  }
  const usage = (resultObj as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') {
    return est;
  }
  const n = (v: unknown): number => (Number.isFinite(v) ? Number(v) : 0);
  const total =
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_read_input_tokens) +
    n(usage.cache_creation_input_tokens);
  return total > 0 ? total : est;
}
