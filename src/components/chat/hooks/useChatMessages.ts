/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.kind === 'tool_use' && msg.toolId) {
      toolUseIds.add(msg.toolId);
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  // Pre-pass (B-63 live counter): fold *live* sub-agent tool rows into their
  // container. The SDK streams a sub-agent's tool_use/tool_result blocks during
  // a delegation run (no flag needed — "enough for a heartbeat counter", see
  // @anthropic-ai/claude-agent-sdk sdk.d.ts ~L1525), each stamped with
  // `parent_tool_use_id` = the id of the parent `Task`/`Agent` tool_use block.
  // The server (claude-sdk.js transformMessage → parentToolUseId, copied onto
  // every normalized row) forwards it; the client appends it verbatim. That id
  // equals the container row's `toolId`, which the live normalizer derives from
  // the same tool_use block id (`part.id`, claude-sessions.provider.ts ~L567).
  //
  // Without this, each live child arrives as an independent top-level tool_use
  // row, renders orphaned, and is never seen by useRunProgress (which only
  // descends into `subagentState.childTools`). Here we group those children by
  // their parent id into the same SubagentChildTool shape the history path
  // builds, so the container branch below can merge them and useRunProgress can
  // count the sub-agent's TodoWrite live. The map is order-independent: a child
  // that arrives before its container is still attached when the container is
  // converted, because both passes run over the full `messages` array.
  const liveChildMap = new Map<string, SubagentChildTool[]>();
  for (const msg of messages) {
    if (msg.kind !== 'tool_use' || !msg.parentToolUseId || !msg.toolId) continue;
    const tr = msg.toolResult || toolResultMap.get(msg.toolId) || null;
    const child: SubagentChildTool = {
      toolId: msg.toolId,
      toolName: msg.toolName || '',
      toolInput: msg.toolInput,
      toolResult: tr
        ? {
            content: formatToolResultContent(tr.content),
            isError: Boolean(tr.isError),
            toolUseResult: (tr as any).toolUseResult,
          }
        : null,
      timestamp: new Date(msg.timestamp || Date.now()),
    };
    const bucket = liveChildMap.get(msg.parentToolUseId);
    if (bucket) bucket.push(child);
    else liveChildMap.set(msg.parentToolUseId, [child]);
  }

  for (const msg of messages) {
    const sharedMetadata = {
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
      // Per-message coordinator attribution (server commit 9c61b60). Carried on
      // every converted row via the shared spread; only assistant rows ever
      // hold a value (user rows use `userId`), and MessageComponent resolves it
      // against the participant roster, falling back to the session owner when
      // null/absent.
      coordinatorId: msg.coordinatorId,
      // Machine-origin discriminator (server commit 91b8b39). Present only on
      // kind:'text' role:'user' rows that were written programmatically (no
      // userId). MessageComponent uses this to render coordinator-to-subagent
      // prompts distinctly from human input.
      originKind: msg.originKind,
    };

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        if (!content.trim()) continue;

        if (msg.role === 'user') {
          // Parse task notifications (B-94 fix).
          // The original format carries <output-file>; the "stopped" notification
          // emitted by the SDK carries <tool-use-id> instead (no output-file).
          // Both variants are accepted; the inner block after <task-id> is made
          // optional so that any future variants that omit it also parse cleanly.
          const taskNotifRegex =
            /<task-notification>\s*<task-id>([^<]*)<\/task-id>\s*(?:<output-file>[^<]*<\/output-file>|<tool-use-id>[^<]*<\/tool-use-id>)?\s*<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>\s*<\/task-notification>/g;
          const taskNotifMatch = taskNotifRegex.exec(content);
          if (taskNotifMatch) {
            // Extract wfId from task-id so reconcile cards can match (B-94).
            // task-id format observed: "wf_<hex>" or arbitrary SDK string.
            const rawTaskId = taskNotifMatch[1]?.trim() || '';
            const wfId = rawTaskId.startsWith('wf_') ? rawTaskId : undefined;
            converted.push({
              type: 'assistant',
              content: taskNotifMatch[3]?.trim() || 'Background task finished',
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotifMatch[2]?.trim() || 'completed',
              wfId,
              ...sharedMetadata,
            });
          } else {
            converted.push({
              type: 'user',
              content: unescapeWithMathProtection(decodeHtmlEntities(content)),
              timestamp: msg.timestamp,
              // Real author (users.id). Absent = unknown author; the renderer
              // must not attribute the message to the viewing user.
              userId: msg.userId,
              ...sharedMetadata,
            });
          }
        } else {
          let text = decodeHtmlEntities(content);
          text = unescapeWithMathProtection(text);
          text = formatUsageLimitText(text);
          converted.push({
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        // Live sub-agent child tool (carries parentToolUseId): already folded
        // into its container's childTools in the pre-pass. Do NOT also emit it as
        // a flat top-level row, or it renders orphaned and double-counts (B-63).
        if (msg.parentToolUseId) {
          break;
        }

        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        // Sub-agent container: the coordinator delegating a run. Two tool names
        // delegate in this codebase — Claude's native `Task` and the agy /
        // Antigravity `Agent` tool (the only one actually used in nassaj runs,
        // 2114 uses vs 0 for `Task`). Both attach their child tools via
        // `subagentTools` on the result, so both must be recognised or the live
        // active-agent chip and the history child-tool descent in useRunProgress
        // never fire for real nassaj delegation runs (B-63).
        const isSubagentContainer = msg.toolName === 'Task' || msg.toolName === 'Agent';

        // Build child tools from subagentTools (history aggregate) and merge the
        // live children folded in the pre-pass (B-63). Dedup by toolId — the same
        // tool can appear in both once a run finishes and its children are also
        // aggregated onto the container — keeping the history copy as canonical.
        const childTools: SubagentChildTool[] = [];
        const seenChildIds = new Set<string>();
        if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
            if (tool.toolId) seenChildIds.add(tool.toolId);
          }
        }
        if (isSubagentContainer && msg.toolId) {
          const liveChildren = liveChildMap.get(msg.toolId);
          if (liveChildren) {
            for (const child of liveChildren) {
              if (child.toolId && seenChildIds.has(child.toolId)) continue;
              childTools.push(child);
              if (child.toolId) seenChildIds.add(child.toolId);
            }
          }
        }

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        converted.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
              }
            : undefined,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            type: 'assistant',
            content: unescapeWithMathProtection(msg.content),
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        converted.push({
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          // Carry the stale-resume signal so the renderer can offer an explicit
          // "start new session" action instead of a plain error bubble.
          errorCode: msg.code,
          staleSessionId: msg.staleSessionId,
          failedCommand: msg.command,
          ...sharedMetadata,
        });
        break;

      case 'interactive_prompt':
        converted.push({
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        converted.push({
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          wfId: msg.wfId,
          ...sharedMetadata,
        });
        break;

      // Synthetic reconcile row injected by useChatRealtimeHandlers when the
      // server emits a workflow_reconciled event (B-94). The row carries
      // isTaskNotification:true so it flows through the existing card path in
      // MessageComponent with no further changes needed there.
      case 'task_reconcile':
        converted.push({
          type: 'assistant',
          content:
            msg.agentsDone != null && msg.agentsTotal != null
              ? `اكتمل في الخلفية (${msg.agentsDone}/${msg.agentsTotal})`
              : (msg.summary || 'اكتمل في الخلفية'),
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: 'completed',
          wfId: msg.wfId,
          isReconcile: true,
          ...sharedMetadata,
        });
        break;

      case 'stream_delta':
        if (msg.content) {
          converted.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result': {
        if (msg.toolId && toolUseIds.has(msg.toolId)) {
          break;
        }

        const content = formatToolResultContent(msg.content || '');
        if (!content.trim()) {
          break;
        }

        // Orphaned result: its tool_use fell outside the loaded window (page
        // cut, realtime cap, or mid-run reattach). Render it as a collapsed
        // generic tool block — never as plain assistant prose, which dumps
        // raw line-numbered file content into the transcript.
        converted.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: 'ToolResult',
          toolInput: '',
          toolId: msg.toolId,
          toolResult: {
            content,
            isError: Boolean(msg.isError),
            toolUseResult: (msg as any).toolUseResult,
          },
          ...sharedMetadata,
        });
        break;
      }

      default:
        break;
    }
  }

  // ── Reconcile pass (B-94) ──────────────────────────────────────────────────
  // For each task_reconcile card that has a wfId, find the matching stopped
  // card (isTaskNotification + same wfId + taskStatus:'stopped') and replace
  // it in-place with the reconcile card. If no matching stopped card exists,
  // the reconcile card stays appended at the end (timestamp order is already
  // correct because computeMerged sorts the source rows chronologically).
  //
  // Algorithm: collect indices of reconcile cards and their matching stopped
  // cards in a single scan, then apply replacements back-to-front so earlier
  // indices remain stable.
  type ReconcileMatch = { recIdx: number; stoppedIdx: number };
  const matches: ReconcileMatch[] = [];
  const reconcileIndices: number[] = [];
  for (let i = 0; i < converted.length; i++) {
    const m = converted[i];
    if ((m as any).isReconcile && (m as any).wfId) {
      reconcileIndices.push(i);
    }
  }

  for (const recIdx of reconcileIndices) {
    const rec = converted[recIdx];
    const wfId = (rec as any).wfId as string;
    const stoppedIdx = converted.findIndex(
      (m, idx) =>
        idx !== recIdx &&
        (m as any).isTaskNotification &&
        !(m as any).isReconcile &&
        (m as any).wfId === wfId &&
        (m as any).taskStatus === 'stopped',
    );
    if (stoppedIdx !== -1) {
      matches.push({ recIdx, stoppedIdx });
    }
  }

  // Apply in descending index order so each splice does not shift later indices.
  for (const { recIdx, stoppedIdx } of matches.sort(
    (a, b) => Math.max(b.recIdx, b.stoppedIdx) - Math.max(a.recIdx, a.stoppedIdx),
  )) {
    const rec = converted[recIdx];
    // Remove reconcile card first (higher or lower index), then replace stopped.
    if (recIdx > stoppedIdx) {
      converted.splice(recIdx, 1);
      converted.splice(stoppedIdx, 1, rec);
    } else {
      converted.splice(stoppedIdx, 1, rec);
      converted.splice(recIdx, 1);
    }
  }

  return converted;
}
