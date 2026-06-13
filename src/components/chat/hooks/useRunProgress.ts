/**
 * useRunProgress — derive a compact task/agent progress snapshot from the chat
 * transcript so ClaudeStatus can show a "tasks done / total" counter and feed a
 * time estimate, *without* ever re-scanning messages on the per-second tick.
 *
 * Design (locked by review — see task spec §3):
 *   - Pure message scan, memoized on `[chatMessages]` ONLY. It does not read the
 *     clock, so it recomputes only when the transcript actually changes, not
 *     every second.
 *   - A single full tail→head pass, NO early exit. The latest TodoWrite is
 *     locked at its first (newest) hit via `foundTodos`; every Task row is still
 *     visited and deduped by toolId so all unique sub-agents are counted and the
 *     newest incomplete one is the active one. One pass, no map/filter over the
 *     whole array. (Do NOT add a `break`: it would stop counting older Task rows
 *     and undercount the sub-agents.)
 *   - Consumes the FULL `chatMessages`, never the windowed `visibleMessages`
 *     (last ~100), so Task containers scrolled out of the visible window are
 *     still counted.
 *
 * Counter model (nested, TodoWrite-primary):
 *   - Numerator/denominator come ONLY from the most recent TodoWrite list.
 *   - Sub-agents (Task) are tooltip detail; they never enter the fraction.
 *   - Safe degradation: TodoWrite list → counter; else an active sub-agent →
 *     "agent working" indicator (no bar, no estimate); else nothing.
 */

import { useMemo } from 'react';
import type { ChatMessage } from '../types/types';

export interface RunProgress {
  /** completed todos in the latest TodoWrite list */
  done: number;
  /** total todos in the latest TodoWrite list */
  total: number;
  /** in-progress todos in the latest TodoWrite list */
  inProgress: number;
  /** unique Task (sub-agent) tool invocations — tooltip detail only */
  agentsTotal: number;
  /** Task invocations that already have a matching tool_result — tooltip detail only */
  agentsDone: number;
  /**
   * The single currently-running sub-agent (isComplete === false), if any.
   * `callCount` = number of child tool calls it has issued so far. `null` when
   * no sub-agent is active.
   */
  activeSubagent: { callCount: number } | null;
}

const EMPTY_PROGRESS: RunProgress = {
  done: 0,
  total: 0,
  inProgress: 0,
  agentsTotal: 0,
  agentsDone: 0,
  activeSubagent: null,
};

/** Same guard the renderer uses (TodoListContent.isTodoItem): drop malformed entries. */
function isTodoItem(value: unknown): value is { content: string; status: string } {
  if (typeof value !== 'object' || value === null) return false;
  const todo = value as Record<string, unknown>;
  return typeof todo.content === 'string' && typeof todo.status === 'string';
}

/**
 * `toolInput` on a normalized ChatMessage is ALWAYS a string: useChatMessages
 * stores it as `typeof toolInput === 'string' ? toolInput : JSON.stringify(...)`.
 * For TodoWrite the original input is an object `{ todos: [...] }`, so we parse
 * and read `.todos`. Returns [] on any malformed / non-JSON payload.
 */
function parseTodos(toolInput: unknown): Array<{ content: string; status: string }> {
  let parsed: unknown = toolInput;
  if (typeof toolInput === 'string') {
    try {
      parsed = JSON.parse(toolInput);
    } catch {
      return [];
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const todos = (parsed as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return [];
  return todos.filter(isTodoItem);
}

/**
 * @param chatMessages full transcript (NOT the windowed visibleMessages)
 * @param isLoading    whether a run is currently in flight; when false the
 *                     snapshot is forced empty so no stale counter lingers
 *                     (the caller hides the indicators on !isLoading anyway,
 *                     but an empty snapshot keeps the contract clean).
 */
export function useRunProgress(
  chatMessages: ChatMessage[],
  isLoading: boolean,
): RunProgress {
  return useMemo<RunProgress>(() => {
    if (!isLoading || chatMessages.length === 0) {
      return EMPTY_PROGRESS;
    }

    let done = 0;
    let total = 0;
    let inProgress = 0;
    let foundTodos = false;

    // Unique Task ids seen, and which of them have a matching tool_result.
    const taskIds = new Set<string>();
    let agentsDone = 0;
    let activeSubagent: { callCount: number } | null = null;

    // Full tail→head pass, no early exit. The *latest* TodoWrite is the first
    // one hit scanning backwards and is locked via `foundTodos` (older lists
    // ignored). Task rows must ALL be visited and deduped by toolId so every
    // unique sub-agent is counted; the active sub-agent is the first incomplete
    // Task hit scanning backwards (= the most recent one still running).
    // Intentionally `continue`, never `break`: an early break would skip older
    // Task rows and undercount the sub-agents.
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (!msg.isToolUse) continue;

      const toolName = msg.toolName;

      if (toolName === 'TodoWrite') {
        if (!foundTodos) {
          // First TodoWrite hit while scanning backwards == highest timestamp
          // == latest list. Lock it in; ignore older ones.
          const todos = parseTodos(msg.toolInput);
          if (todos.length > 0) {
            foundTodos = true;
            total = todos.length;
            for (const todo of todos) {
              if (todo.status === 'completed') done++;
              else if (todo.status === 'in_progress') inProgress++;
            }
          }
        }
        continue;
      }

      if (toolName === 'Task') {
        const id = msg.toolId;
        // Unique by toolId; ignore Task rows without an id (cannot dedupe).
        if (id && !taskIds.has(id)) {
          taskIds.add(id);
          const complete = msg.subagentState?.isComplete ?? Boolean(msg.toolResult);
          if (complete) {
            agentsDone++;
          } else if (activeSubagent === null) {
            // First incomplete Task scanning backwards = the active one.
            activeSubagent = { callCount: msg.subagentState?.childTools?.length ?? 0 };
          }
        }
        continue;
      }
    }

    // Nothing actionable: no todos and no running sub-agent → empty snapshot so
    // the caller renders the unchanged elapsed-only status.
    if (!foundTodos && activeSubagent === null && taskIds.size === 0) {
      return EMPTY_PROGRESS;
    }

    return {
      done,
      total,
      inProgress,
      agentsTotal: taskIds.size,
      agentsDone,
      activeSubagent,
    };
  }, [chatMessages, isLoading]);
}
