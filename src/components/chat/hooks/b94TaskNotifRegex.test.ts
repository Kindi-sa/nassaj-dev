/**
 * B-94 regression tests — taskNotifRegex in normalizedToChatMessages.
 *
 * INCIDENT 2026-06-27: The SDK emits a "stopped" task notification that carries
 * <tool-use-id> instead of <output-file>. The original regex required <output-file>
 * and therefore failed to match, so the raw XML was rendered as plain text in the
 * chat instead of being parsed into a structured task-notification card.
 *
 * The fix made the inner block (<output-file>|<tool-use-id>) optional so that
 * both the legacy output-file format AND the stopped/tool-use-id format parse
 * correctly, and any future SDK variant that omits the inner block entirely also
 * parses cleanly.
 *
 * These tests:
 *  1. Verify the regex matches <tool-use-id> notifications (the actual "stopped"
 *     shape the SDK emits) and extracts status + summary correctly.
 *  2. Verify the regex still matches <output-file> notifications (the legacy
 *     "completed" shape) — no regression in the happy path.
 *  3. Verify the regex matches a bare notification with no inner block at all
 *     (future-compatibility, forward-compat clause in the ADR).
 *  4. Verify the regex does NOT match malformed or unrelated XML.
 *  5. Drive the full normalizedToChatMessages path with a "stopped" notification
 *     to confirm end-to-end: the raw XML produces an isTaskNotification card with
 *     taskStatus:'stopped' rather than a plain user message.
 *
 * Run inside vitest (npm run test:client) — the file is picked up automatically
 * by vite.config.js test.include, which covers src/**\/*.test.{ts,tsx}.
 * It does NOT use node:test because normalizedToChatMessages has transitive
 * React imports that require the jsdom+vitest environment.
 */

import { describe, it, expect } from 'vitest';
import { normalizedToChatMessages } from './useChatMessages.js';
import type { NormalizedMessage } from '../../../stores/useSessionStore.js';

// ── The exact regex from useChatMessages.ts (must stay in sync) ────────────
// Copied here so test failures on the regex itself are immediate and readable.
// If you change the regex in useChatMessages.ts, update this copy or the tests
// below will tell you.
const TASK_NOTIF_REGEX =
  /<task-notification>\s*<task-id>([^<]*)<\/task-id>\s*(?:<output-file>[^<]*<\/output-file>|<tool-use-id>[^<]*<\/tool-use-id>)?\s*<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>\s*<\/task-notification>/g;

function matchOnce(content: string) {
  const rx = new RegExp(TASK_NOTIF_REGEX.source, TASK_NOTIF_REGEX.flags);
  return rx.exec(content);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Exact shape the SDK emits for a "stopped" background workflow notification. */
const STOPPED_WITH_TOOL_USE_ID = `<task-notification>
<task-id>wf_ef5ba242-b4b</task-id>
<tool-use-id>toolu_01ABCDEF1234567890abcdef</tool-use-id>
<status>stopped</status>
<summary>Background workflow stopped</summary>
</task-notification>`;

/** Legacy shape: <output-file> instead of <tool-use-id>. */
const COMPLETED_WITH_OUTPUT_FILE = `<task-notification>
<task-id>wf_abc123</task-id>
<output-file>/tmp/some/output.md</output-file>
<status>completed</status>
<summary>Plan generated successfully</summary>
</task-notification>`;

/** Future-compat: no inner block at all. */
const BARE_NO_INNER_BLOCK = `<task-notification>
<task-id>wf_bare999</task-id>
<status>completed</status>
<summary>Done</summary>
</task-notification>`;

/** Inline (no newlines) — SDK may emit this in some versions. */
const INLINE_TOOL_USE_ID =
  '<task-notification><task-id>wf_inline01</task-id><tool-use-id>toolu_xyz</tool-use-id><status>stopped</status><summary>Inline stopped</summary></task-notification>';

// ── Helper: build a minimal NormalizedMessage with kind:'text' role:'user' ──
function makeTextMsg(content: string): NormalizedMessage {
  return {
    id: 'msg-test-01',
    sessionId: 'sess-test',
    timestamp: new Date(1_782_000_000_000).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content,
  } as NormalizedMessage;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. REGEX UNIT TESTS — pure pattern matching
// ══════════════════════════════════════════════════════════════════════════════

describe('taskNotifRegex — B-94 (stopped with <tool-use-id>)', () => {
  it('matches a stopped notification carrying <tool-use-id>', () => {
    const m = matchOnce(STOPPED_WITH_TOOL_USE_ID);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('wf_ef5ba242-b4b');   // task-id
    expect(m![2].trim()).toBe('stopped');             // status
    expect(m![3].trim()).toBe('Background workflow stopped'); // summary
  });

  it('extracts a wf_ prefixed task-id correctly', () => {
    const m = matchOnce(STOPPED_WITH_TOOL_USE_ID);
    expect(m![1].trim()).toMatch(/^wf_/);
  });

  it('matches inline (no whitespace / newlines) stopped notification', () => {
    const m = matchOnce(INLINE_TOOL_USE_ID);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('wf_inline01');
    expect(m![2].trim()).toBe('stopped');
    expect(m![3].trim()).toBe('Inline stopped');
  });
});

describe('taskNotifRegex — legacy <output-file> (no regression)', () => {
  it('matches a completed notification carrying <output-file>', () => {
    const m = matchOnce(COMPLETED_WITH_OUTPUT_FILE);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('wf_abc123');
    expect(m![2].trim()).toBe('completed');
    expect(m![3].trim()).toBe('Plan generated successfully');
  });
});

describe('taskNotifRegex — bare (no inner block)', () => {
  it('matches a notification with no <output-file> nor <tool-use-id> block', () => {
    const m = matchOnce(BARE_NO_INNER_BLOCK);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('wf_bare999');
    expect(m![2].trim()).toBe('completed');
    expect(m![3].trim()).toBe('Done');
  });
});

describe('taskNotifRegex — negative cases (must NOT match)', () => {
  it('does not match a plain assistant text message', () => {
    expect(matchOnce('Hello from the assistant')).toBeNull();
  });

  it('does not match a notification missing <task-id>', () => {
    const bad = `<task-notification>
<status>stopped</status>
<summary>No task-id here</summary>
</task-notification>`;
    expect(matchOnce(bad)).toBeNull();
  });

  it('does not match a notification missing <status>', () => {
    const bad = `<task-notification>
<task-id>wf_nostatus</task-id>
<summary>Missing status</summary>
</task-notification>`;
    expect(matchOnce(bad)).toBeNull();
  });

  it('does not match a notification missing <summary>', () => {
    const bad = `<task-notification>
<task-id>wf_nosummary</task-id>
<status>stopped</status>
</task-notification>`;
    expect(matchOnce(bad)).toBeNull();
  });

  it('does not match raw XML injection in task-id (tag within tag-id)', () => {
    // The [^<]* quantifier in the task-id capture group prevents tag injection.
    const injection =
      '<task-notification><task-id><evil></task-id><status>stopped</status><summary>x</summary></task-notification>';
    expect(matchOnce(injection)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. INTEGRATION TESTS — normalizedToChatMessages end-to-end
// ══════════════════════════════════════════════════════════════════════════════

describe('normalizedToChatMessages — B-94 end-to-end parsing', () => {
  it('converts a stopped <tool-use-id> notification to an isTaskNotification card', () => {
    const messages = [makeTextMsg(STOPPED_WITH_TOOL_USE_ID)];
    const converted = normalizedToChatMessages(messages);

    expect(converted).toHaveLength(1);
    const card = converted[0];
    expect((card as any).isTaskNotification).toBe(true);
    expect((card as any).taskStatus).toBe('stopped');
  });

  it('extracts wfId from the task-id field for reconcile matching', () => {
    const messages = [makeTextMsg(STOPPED_WITH_TOOL_USE_ID)];
    const converted = normalizedToChatMessages(messages);
    expect((converted[0] as any).wfId).toBe('wf_ef5ba242-b4b');
  });

  it('uses the <summary> text as the card content', () => {
    const messages = [makeTextMsg(STOPPED_WITH_TOOL_USE_ID)];
    const converted = normalizedToChatMessages(messages);
    expect(converted[0].content).toBe('Background workflow stopped');
  });

  it('still parses the <output-file> variant as a task notification (no regression)', () => {
    const messages = [makeTextMsg(COMPLETED_WITH_OUTPUT_FILE)];
    const converted = normalizedToChatMessages(messages);
    expect(converted).toHaveLength(1);
    expect((converted[0] as any).isTaskNotification).toBe(true);
    expect((converted[0] as any).taskStatus).toBe('completed');
    expect((converted[0] as any).wfId).toBe('wf_abc123');
  });

  it('renders a non-notification user message as type:user (not a card)', () => {
    const messages = [makeTextMsg('Hello, run this task for me')];
    const converted = normalizedToChatMessages(messages);
    expect(converted).toHaveLength(1);
    expect(converted[0].type).toBe('user');
    expect((converted[0] as any).isTaskNotification).toBeUndefined();
  });

  it('does not set wfId when task-id does not start with wf_', () => {
    const nonWfId = `<task-notification>
<task-id>task_generic_1234</task-id>
<tool-use-id>toolu_abc</tool-use-id>
<status>completed</status>
<summary>Generic task done</summary>
</task-notification>`;
    const messages = [makeTextMsg(nonWfId)];
    const converted = normalizedToChatMessages(messages);
    expect((converted[0] as any).isTaskNotification).toBe(true);
    expect((converted[0] as any).wfId).toBeUndefined();
  });

  // ── Reconcile pass: a task_reconcile card replaces the matching stopped card ──

  it('reconcile pass replaces stopped card with reconcile card when wfId matches', () => {
    const stoppedMsg = makeTextMsg(STOPPED_WITH_TOOL_USE_ID);
    const reconcileMsg: NormalizedMessage = {
      id: 'msg-rec-01',
      sessionId: 'sess-test',
      timestamp: new Date(1_782_000_010_000).toISOString(),
      provider: 'claude',
      kind: 'task_reconcile',
      wfId: 'wf_ef5ba242-b4b',
      agentsDone: 5,
      agentsTotal: 5,
      summary: 'اكتمل في الخلفية',
    } as unknown as NormalizedMessage;

    const converted = normalizedToChatMessages([stoppedMsg, reconcileMsg]);

    // After reconcile pass: exactly one card (stopped replaced by reconcile).
    expect(converted).toHaveLength(1);
    const card = converted[0];
    expect((card as any).isTaskNotification).toBe(true);
    expect((card as any).isReconcile).toBe(true);
    expect((card as any).taskStatus).toBe('completed');
    expect((card as any).wfId).toBe('wf_ef5ba242-b4b');
  });

  it('reconcile pass keeps reconcile card at end when no matching stopped card', () => {
    const regularMsg: NormalizedMessage = {
      id: 'msg-user-01',
      sessionId: 'sess-test',
      timestamp: new Date(1_782_000_000_000).toISOString(),
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'Run the workflow',
    } as NormalizedMessage;
    const reconcileMsg: NormalizedMessage = {
      id: 'msg-rec-02',
      sessionId: 'sess-test',
      timestamp: new Date(1_782_000_010_000).toISOString(),
      provider: 'claude',
      kind: 'task_reconcile',
      wfId: 'wf_nomatch',
      agentsDone: 3,
      agentsTotal: 3,
      summary: 'اكتمل في الخلفية',
    } as unknown as NormalizedMessage;

    const converted = normalizedToChatMessages([regularMsg, reconcileMsg]);
    // user msg + reconcile card appended at end
    expect(converted).toHaveLength(2);
    expect((converted[1] as any).isReconcile).toBe(true);
  });
});
