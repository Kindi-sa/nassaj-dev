import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import ParticipantAvatar from '../../../participants/ParticipantAvatar';
import type { SessionParticipant } from '../../../participants/types';
import { avatarColorForUser } from '../../../participants/utils';
import { useAuth } from '../../../auth/context/AuthContext';
import { cn } from '../../../../lib/utils';
import type { SessionOwner } from '../../../../types/app';
import type {
  ChatMessage,
  ClaudePermissionSuggestion,
  PermissionGrantResult,
  Provider,
} from '../../types/types';
import { formatUsageLimitText } from '../../utils/chatFormatting';
import { getClaudePermissionSuggestion } from '../../utils/chatPermissions';
import type { Project } from '../../../../types/app';
import { ToolRenderer, shouldHideToolResult } from '../../tools';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../../shared/view/ui';
import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  onStartNewSession?: (command: string) => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  // Owner of the active session (C-MU-UX-MSG-IDENTITY). Threaded from the chat
  // view's selectedSession.owner. `null`/undefined for legacy sessions, where
  // we fall back to the generic provider-logo + "Claude" rendering.
  owner?: SessionOwner | null;
  // Session participants keyed by String(userId), used to resolve a user
  // message's `userId` author stamp to the real sender's avatar/name/colour
  // (B-MU-UX-FIX-MSG-AUTHOR). Optional so standalone renders degrade safely.
  participantsById?: Map<string, SessionParticipant>;
  provider: Provider | string;
};

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

type PermissionGrantState = 'idle' | 'granted' | 'error';
const COPY_HIDDEN_TOOL_NAMES = new Set(['Bash', 'Edit', 'Write', 'ApplyPatch']);

const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, onShowSettings, onGrantToolPermission, onStartNewSession, autoExpandTools, showRawParameters, showThinking, selectedProject, owner, participantsById, provider }: MessageComponentProps) => {
  const { t, i18n } = useTranslation('chat');
  const { user } = useAuth();
  // Build a minimal participant view of the signed-in user so the chat reuses
  // the shared avatar component (image with coloured-initial fallback) instead
  // of a hard-coded "U" placeholder.
  const currentUserParticipant = useMemo<SessionParticipant>(() => {
    const username = user?.username ?? '';
    return {
      userId: user?.id ?? username ?? 'me',
      username,
      role: typeof user?.role === 'string' ? user.role : 'user',
      first_seen: '',
      last_seen: '',
      message_count: 0,
      avatarUrl: typeof user?.avatarUrl === 'string' ? user.avatarUrl : null,
    };
  }, [user?.id, user?.username, user?.role, user?.avatarUrl]);

  // Session owner identity (C-MU-UX-MSG-IDENTITY). Owner colour = which brother;
  // shape (owner avatar vs agent pill) = coordinator vs sub-agent. Null owner
  // (legacy session) falls back to the generic provider-logo rendering.
  const ownerParticipant = useMemo<SessionParticipant | null>(() => {
    if (!owner) {
      return null;
    }
    return {
      userId: owner.userId,
      username: owner.username,
      role: 'owner',
      first_seen: '',
      last_seen: '',
      message_count: 0,
      avatarUrl: owner.avatarUrl ?? null,
    };
  }, [owner]);
  const ownerColorClass = owner ? avatarColorForUser(owner.userId) : null;

  // Real author of this user message (B-MU-UX-FIX-MSG-AUTHOR). `message.userId`
  // is the numeric users.id stamped by the server on live WS payloads and
  // history rows (and locally on optimistic sends). Resolution order:
  //   1. matches the signed-in viewer  → their own participant view (avatar);
  //   2. found in the session roster   → that participant (name/avatar/colour);
  //   3. known id, roster not loaded   → deterministic colour from the id;
  //   4. no userId at all              → null = unknown author; the renderer
  //      shows a neutral placeholder and must NOT fall back to the viewer.
  const messageUserId = typeof message.userId === 'number' ? message.userId : undefined;
  const isOwnMessage =
    messageUserId !== undefined && user?.id !== undefined && Number(user.id) === messageUserId;
  const authorParticipant = useMemo<SessionParticipant | null>(() => {
    if (messageUserId === undefined) return null;
    if (isOwnMessage) return currentUserParticipant;
    const known = participantsById?.get(String(messageUserId));
    if (known) return known;
    return {
      userId: messageUserId,
      username: '',
      role: 'user',
      first_seen: '',
      last_seen: '',
      message_count: 0,
    };
  }, [messageUserId, isOwnMessage, currentUserParticipant, participantsById]);

  // Consecutive user messages only group when they share an author, so a
  // different sender's bubble never hides behind the previous author's avatar.
  const isGrouped = prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user' && prevMessage.userId === message.userId) ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error'));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const permissionSuggestion = getClaudePermissionSuggestion(message, provider);
  const [permissionGrantState, setPermissionGrantState] = useState<PermissionGrantState>('idle');
  const userCopyContent = String(message.content || '');
  const formattedMessageContent = useMemo(
    () => formatUsageLimitText(String(message.content || '')),
    [message.content]
  );
  const assistantCopyContent = message.isToolUse
    ? String(message.displayText || message.content || '')
    : formattedMessageContent;
  const isCommandOrFileEditToolResponse = Boolean(
    message.isToolUse && COPY_HIDDEN_TOOL_NAMES.has(String(message.toolName || ''))
  );
  const shouldShowUserCopyControl = message.type === 'user' && userCopyContent.trim().length > 0;
  const shouldShowAssistantCopyControl = message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !isCommandOrFileEditToolResponse &&
    !message.isThinking;


  useEffect(() => {
    setPermissionGrantState('idle');
  }, [permissionSuggestion?.entry, message.toolId]);

  useEffect(() => {
    const node = messageRef.current;
    if (!autoExpandTools || !node || !message.isToolUse) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isExpanded) {
            setIsExpanded(true);
            const details = node.querySelectorAll<HTMLDetailsElement>('details');
            details.forEach((detail) => {
              detail.open = true;
            });
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(node);

    return () => {
      observer.unobserve(node);
    };
  }, [autoExpandTools, isExpanded, message.isToolUse]);

  const formattedTime = useMemo(() => {
    const d = new Date(message.timestamp);
    // Guard against missing/invalid timestamps (e.g. some agy tool_use or
    // thinking events arrive without one) so we never render "Invalid Date".
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [message.timestamp]);

  const fullDateTime = useMemo(() => {
    const d = new Date(message.timestamp);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }, [message.timestamp]);

  // `<time dateTime>` requires a string; normalise the (string | number | Date)
  // timestamp to a machine-readable ISO value, falling back to an empty string
  // for invalid dates so the attribute stays valid.
  const isoTimestamp = useMemo(() => {
    const d = new Date(message.timestamp);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }, [message.timestamp]);
  const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);
  // Stale-resume error: the backend reported the conversation no longer exists
  // instead of silently restarting. Surface an explicit retry action.
  const isSessionNotResumable =
    message.type === 'error' && message.errorCode === 'conversation_not_found';

  if (shouldHideThinkingMessage) {
    return null;
  }

  return (
    <div
      ref={messageRef}
      data-message-timestamp={message.timestamp || undefined}
      className={`chat-message ${message.type} ${isGrouped ? 'grouped' : ''} ${message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`}
    >
      {message.type === 'user' ? (
        /* User message bubble on the right */
        <div className="flex w-full items-end space-x-0 sm:w-auto sm:max-w-[85%] sm:space-x-3 md:max-w-md lg:max-w-lg xl:max-w-xl">
          <div className="group flex-1 rounded-2xl rounded-br-md bg-blue-600 px-3 py-2 text-white shadow-sm sm:flex-initial sm:px-4">
            <div className="whitespace-pre-wrap break-words text-sm" dir="auto">
              {message.content}
            </div>
            {message.images && message.images.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {message.images.map((img, idx) => (
                  <img
                    key={img.name || idx}
                    src={img.data}
                    alt={img.name}
                    className="h-auto max-w-full cursor-pointer rounded-lg transition-opacity hover:opacity-90"
                    onClick={() => window.open(img.data, '_blank')}
                  />
                ))}
              </div>
            )}
            <div className="mt-1 flex items-center justify-end gap-1 text-xs text-blue-100">
              {shouldShowUserCopyControl && (
                <MessageCopyControl content={userCopyContent} messageType="user" />
              )}
              {formattedTime && (
                <time
                  dateTime={isoTimestamp}
                  title={fullDateTime}
                  className="cursor-default"
                >
                  {formattedTime}
                </time>
              )}
            </div>
          </div>
          {!isGrouped && (
            <div className="hidden flex-shrink-0 sm:flex">
              {authorParticipant ? (
                <ParticipantAvatar
                  participant={authorParticipant}
                  size="sm"
                  locale={i18n.language}
                  t={t}
                  stacked={false}
                  avatarUrl={authorParticipant.avatarUrl ?? undefined}
                />
              ) : (
                /* Unknown author (no userId stamp — legacy rows or
                 * provider-rewritten commands): neutral grey placeholder,
                 * never the viewing user's avatar. */
                <span
                  role="img"
                  aria-label={t('participants.unknownAuthor', { defaultValue: 'Unknown author' })}
                  title={t('participants.unknownAuthor', { defaultValue: 'Unknown author' })}
                  className="inline-flex h-6 w-6 select-none items-center justify-center rounded-full bg-gray-400 text-white dark:bg-gray-600"
                >
                  <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-3.866 0-7 2.239-7 5v1h14v-1c0-2.761-3.134-5-7-5z" />
                  </svg>
                </span>
              )}
            </div>
          )}
        </div>
      ) : message.isTaskNotification ? (
        /* Compact task notification on the left */
        <div className="w-full">
          <div className="flex items-center gap-2 py-0.5">
            <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${message.taskStatus === 'completed' ? 'bg-green-400 dark:bg-green-500' : 'bg-amber-400 dark:bg-amber-500'}`} />
            <span className="text-xs text-gray-500 dark:text-gray-400">{message.content}</span>
          </div>
        </div>
      ) : (
        /* Claude/Error/Tool messages on the left */
        <div className="w-full">
          {!isGrouped && (
            <div className="mb-2 flex items-center space-x-3">
              {message.type === 'error' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
                  !
                </div>
              ) : message.type === 'tool' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">
                  🔧
                </div>
              ) : (
                /* Coordinator (main assistant): provider logo plus, when the
                 * session owner is known, the owner's coloured avatar so the
                 * brother behind this session is obvious at a glance (no hover). */
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-white">
                    <SessionProviderLogo provider={provider} className="h-full w-full" />
                  </div>
                  {ownerParticipant && (
                    <ParticipantAvatar
                      participant={ownerParticipant}
                      size="sm"
                      locale={i18n.language}
                      t={t}
                      stacked={false}
                      avatarUrl={ownerParticipant.avatarUrl ?? undefined}
                    />
                  )}
                </div>
              )}
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {message.type === 'error'
                  ? t('messageTypes.error')
                  : message.type === 'tool'
                    ? t('messageTypes.tool')
                    : ownerParticipant
                      ? t('coordinator.withName', { username: ownerParticipant.username, defaultValue: 'Coordinator: {{username}}' })
                      : (provider === 'cursor'
                        ? t('messageTypes.cursor')
                        : provider === 'codex'
                          ? t('messageTypes.codex')
                          : provider === 'gemini'
                            ? t('messageTypes.gemini')
                            : provider === 'antigravity'
                              ? t('messageTypes.antigravity', { defaultValue: 'Antigravity' })
                            : provider === 'opencode'
                              ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                              : t('messageTypes.claude'))}
              </div>
            </div>
          )}

          <div className="w-full">

            {isSessionNotResumable ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
                <p className="text-sm text-red-800 dark:text-red-200" dir="auto">
                  {t('sessionNotResumable.message')}
                </p>
                <button
                  type="button"
                  onClick={() => onStartNewSession?.(String(message.failedCommand || ''))}
                  disabled={!message.failedCommand || !onStartNewSession}
                  aria-label={t('sessionNotResumable.startNew')}
                  className="mt-3 inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-500 dark:hover:bg-red-600"
                >
                  {t('sessionNotResumable.startNew')}
                </button>
              </div>
            ) : message.isToolUse ? (
              <>
                {/*
                 * Sub-agent badge: any `Task` tool call delegates to a child
                 * agent (subagent). Surfaced as a small pill so the user can
                 * tell the work is being done by a delegated agent rather
                 * than the primary model.
                 */}
                {message.toolName === 'Task' && (
                  <div className="mb-1.5 flex">
                    {ownerParticipant && ownerColorClass ? (
                      /* Sub-agent of a known owner: tint the pill with the owner
                       * colour (COLOR = which brother) while the pill SHAPE keeps
                       * it distinct from the coordinator's owner avatar. */
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white',
                          ownerColorClass,
                        )}
                        aria-label={t('subagent.badgeLabel', { defaultValue: 'Sub-agent task' })}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-white/80" aria-hidden="true" />
                        {t('subagent.shortBadge', { defaultValue: 'Sub-agent' })}
                        <span className="font-normal normal-case opacity-90">· {ownerParticipant.username}</span>
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 rounded-md border border-purple-300/70 bg-purple-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700 dark:border-purple-700/60 dark:bg-purple-900/30 dark:text-purple-200"
                        aria-label={t('subagent.badgeLabel', { defaultValue: 'Sub-agent task' })}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-purple-500 dark:bg-purple-400" aria-hidden="true" />
                        {t('subagent.shortBadge', { defaultValue: 'Sub-agent' })}
                      </span>
                    )}
                  </div>
                )}

                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="prose prose-sm max-w-none dark:prose-invert">
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                {message.toolInput && (
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                    autoExpandTools={autoExpandTools}
                    showRawParameters={showRawParameters}
                    rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                    isSubagentContainer={message.isSubagentContainer}
                    subagentState={message.subagentState}
                  />
                )}

                {/* Tool Result Section */}
                {message.toolResult && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.isError ? (
                    // Error results - red error box with content
                    <div
                      id={`tool-result-${message.toolId}`}
                      className="relative mt-2 scroll-mt-4 rounded border border-red-200/60 bg-red-50/50 p-3 dark:border-red-800/40 dark:bg-red-950/10"
                    >
                      <div className="relative mb-2 flex items-center gap-1.5">
                        <svg className="h-4 w-4 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-xs font-medium text-red-700 dark:text-red-300">{t('messageTypes.error')}</span>
                      </div>
                      <div className="relative text-sm text-red-900 dark:text-red-100">
                        <Markdown className="prose prose-sm prose-red max-w-none dark:prose-invert">
                          {String(message.toolResult.content || '')}
                        </Markdown>
                        {permissionSuggestion && (
                          <div className="mt-4 border-t border-red-200/60 pt-3 dark:border-red-800/60">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!onGrantToolPermission) return;
                                  const result = onGrantToolPermission(permissionSuggestion);
                                  if (result?.success) {
                                    setPermissionGrantState('granted');
                                  } else {
                                    setPermissionGrantState('error');
                                  }
                                }}
                                disabled={permissionSuggestion.isAllowed || permissionGrantState === 'granted'}
                                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                  ? 'cursor-default border-green-300/70 bg-green-100 text-green-800 dark:border-green-800/60 dark:bg-green-900/30 dark:text-green-200'
                                  : 'border-red-300/70 bg-white/80 text-red-700 hover:bg-white dark:border-red-800/60 dark:bg-gray-900/40 dark:text-red-200 dark:hover:bg-gray-900/70'
                                  }`}
                              >
                                {permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                  ? t('permissions.added')
                                  : t('permissions.grant', { tool: permissionSuggestion.toolName })}
                              </button>
                              {onShowSettings && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); onShowSettings(); }}
                                  className="text-xs text-red-700 underline hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
                                >
                                  {t('permissions.openSettings')}
                                </button>
                              )}
                            </div>
                            <div className="mt-2 text-xs text-red-700/90 dark:text-red-200/80">
                              {t('permissions.addTo', { entry: permissionSuggestion.entry })}
                            </div>
                            {permissionGrantState === 'error' && (
                              <div className="mt-2 text-xs text-red-700 dark:text-red-200">
                                {t('permissions.error')}
                              </div>
                            )}
                            {(permissionSuggestion.isAllowed || permissionGrantState === 'granted') && (
                              <div className="mt-2 text-xs text-green-700 dark:text-green-200">
                                {t('permissions.retry')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={message.toolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                        autoExpandTools={autoExpandTools}
                      />
                    </div>
                  )
                )}
              </>
            ) : message.isInteractivePrompt ? (
              // Special handling for interactive prompts
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500">
                    <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="mb-3 text-base font-semibold text-amber-900 dark:text-amber-100">
                      {t('interactive.title')}
                    </h4>
                    {(() => {
                      const lines = (message.content || '').split('\n').filter((line) => line.trim());
                      const questionLine = lines.find((line) => line.includes('?')) || lines[0] || '';
                      const options: InteractiveOption[] = [];

                      // Parse the menu options
                      lines.forEach((line) => {
                        // Match lines like "❯ 1. Yes" or "  2. No"
                        const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
                        if (optionMatch) {
                          const isSelected = line.includes('❯');
                          options.push({
                            number: optionMatch[1],
                            text: optionMatch[2].trim(),
                            isSelected
                          });
                        }
                      });

                      return (
                        <>
                          <p className="mb-4 text-sm text-amber-800 dark:text-amber-200">
                            {questionLine}
                          </p>

                          {/* Option buttons */}
                          <div className="mb-4 space-y-2">
                            {options.map((option) => (
                              <button
                                key={option.number}
                                className={`w-full rounded-lg border-2 px-4 py-3 text-left transition-all ${option.isSelected
                                  ? 'border-amber-600 bg-amber-600 text-white shadow-md dark:border-amber-700 dark:bg-amber-700'
                                  : 'border-amber-300 bg-white text-amber-900 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-100'
                                  } cursor-not-allowed opacity-75`}
                                disabled
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${option.isSelected
                                    ? 'bg-white/20'
                                    : 'bg-amber-100 dark:bg-amber-800/50'
                                    }`}>
                                    {option.number}
                                  </span>
                                  <span className="flex-1 text-sm font-medium sm:text-base">
                                    {option.text}
                                  </span>
                                  {option.isSelected && (
                                    <span className="text-lg">❯</span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>

                          <div className="rounded-lg bg-amber-100 p-3 dark:bg-amber-800/30">
                            <p className="mb-1 text-sm font-medium text-amber-900 dark:text-amber-100">
                              {t('interactive.waiting')}
                            </p>
                            <p className="text-xs text-amber-800 dark:text-amber-200">
                              {t('interactive.instruction')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : message.isThinking ? (
              /* Thinking messages — Reasoning component (ai-elements pattern) */
              <Reasoning defaultOpen={false}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert">
                    {message.content}
                  </Markdown>
                  <div className="mt-3 flex items-center text-[11px]">
                    <MessageCopyControl content={String(message.content || '')} messageType="assistant" />
                  </div>
                </ReasoningContent>
              </Reasoning>
            ) : (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                {/* Reasoning accordion */}
                {showThinking && message.reasoning && (
                  <Reasoning className="mb-3" defaultOpen={false}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <div className="whitespace-pre-wrap">
                        {message.reasoning}
                      </div>
                    </ReasoningContent>
                  </Reasoning>
                )}

                {(() => {
                  const content = formattedMessageContent;

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-800 dark:border-gray-700 dark:bg-gray-900">
                            <pre className="overflow-x-auto p-4">
                              <code className="block whitespace-pre font-mono text-sm text-gray-100 dark:text-gray-200">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  return message.type === 'assistant' ? (
                    <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert">
                      {content}
                    </Markdown>
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="mt-1 flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
              {shouldShowAssistantCopyControl && (
                <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
              )}
              {formattedTime && (
                <time
                  dateTime={isoTimestamp}
                  title={fullDateTime}
                  className="cursor-default"
                >
                  {formattedTime}
                </time>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default MessageComponent;

