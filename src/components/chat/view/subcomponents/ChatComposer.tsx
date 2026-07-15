import { useTranslation } from 'react-i18next';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  SetStateAction,
  TouchEvent,
} from 'react';
import { ImageIcon, MessageSquareIcon, XIcon, ArrowDownIcon } from 'lucide-react';

import type { PendingPermissionRequest, PermissionMode, Provider } from '../../types/types';
import FileAttachment from './FileAttachment';
import type { RunProgress } from '../../hooks/useRunProgress';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '../../../../shared/view/ui';

import CommandMenu from './CommandMenu';
import AgentStatusCard from './AgentStatusCard';
import ImageAttachment from './ImageAttachment';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import ThinkingModeSelector from './ThinkingModeSelector';
import TokenUsageSummary from './TokenUsageSummary';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  claudeStatus: { text: string; tokens: number; can_interrupt: boolean } | null;
  isLoading: boolean;
  /** True while the session's provider process is externally frozen (kill -STOP). */
  isSessionFrozen?: boolean;
  /** Epoch-ms start of the current run (last triggering user message); lets the elapsed counter survive refresh. */
  runStartedAt?: number | null;
  /** Task/agent progress snapshot for the ClaudeStatus indicators (derived in ChatInterface). */
  runProgress?: RunProgress | null;
  onAbortSession: () => void;
  provider: Provider | string;
  displayProvider: Provider | string;
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  thinkingMode: string;
  setThinkingMode: Dispatch<SetStateAction<string>>;
  tokenBudget: Record<string, unknown> | null;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  isUserScrolledUp: boolean;
  hasMessages: boolean;
  onScrollToBottom: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  attachedFiles: File[];
  onRemoveFile: (index: number) => void;
  uploadingFiles: Map<string, number>;
  fileErrors: Map<string, string>;
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  /** False while the WebSocket connection is not open; disables the send button. */
  isWsConnected?: boolean;
  /** Non-null error message to display when the last send failed (e.g. WS disconnected). */
  sendError?: string | null;
}

export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  claudeStatus,
  isLoading,
  isSessionFrozen = false,
  runStartedAt = null,
  runProgress = null,
  onAbortSession,
  provider,
  displayProvider,
  permissionMode,
  onModeSwitch,
  thinkingMode,
  setThinkingMode,
  tokenBudget,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  isUserScrolledUp,
  hasMessages,
  onScrollToBottom,
  onSubmit,
  isDragActive,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  attachedFiles,
  onRemoveFile,
  uploadingFiles,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  isWsConnected = true,
  sendError = null,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const textareaRect = textareaRef.current?.getBoundingClientRect();
  // bottom-anchored position: distance from bottom of viewport to top of textarea + gap.
  // left = textarea left edge (for LTR anchoring in getMenuPosition).
  // getMenuPosition derives RTL right-edge from window.innerWidth - left when isRTL.
  const commandMenuPosition = {
    top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
    left: textareaRect ? textareaRect.left : 16,
    bottom: textareaRect ? Math.max(16, window.innerHeight - textareaRect.top + 8) : 90,
  };

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;

  return (
    <div className="flex-shrink-0 p-2 pb-2 sm:p-4 sm:pb-4 md:p-4 md:pb-6">
      {!hasPendingPermissions && (
        // AgentStatusCard يدمج بطاقة نشاط الوكلاء وشريط CLAUDE في عنصر واحد:
        // — حين لا وكلاء (agents=[]): يُفوَّض لـ ClaudeStatus مباشرةً (سلوك سابق)
        // — حين يوجد وكلاء: يُعرض رأس واحد يجمع الشعار والمؤقت وزر STOP
        //   وملخّص الوكلاء وchevron الطيّ، مع صفوف الوكلاء في جزء قابل للطيّ.
        <AgentStatusCard
          agents={runProgress?.agents ?? []}
          status={claudeStatus}
          isLoading={isLoading}
          frozen={isSessionFrozen}
          onAbort={onAbortSession}
          provider={displayProvider}
          runStartedAt={runStartedAt}
          progress={runProgress}
        />
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-4xl">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      {sendError && (
        <div
          role="alert"
          className="mx-auto mb-2 max-w-4xl rounded-lg border border-red-300/60 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-600/40 dark:bg-red-900/15 dark:text-red-300"
        >
          {sendError}
        </div>
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-4xl">

        {isUserScrolledUp && hasMessages && (
          <div className="absolute -top-10 left-0 right-0 z-10 flex justify-center">
            <button
              type="button"
              onClick={onScrollToBottom}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
              title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
            >
              <ArrowDownIcon className="h-4 w-4" />
            </button>
          </div>
        )}

        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={isTextareaExpanded ? 'chat-input-expanded' : ''}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">{t('input.dropFilesHere')}</p>
              </div>
            </div>
          )}

          {(attachedImages.length > 0 || attachedFiles.length > 0) && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={`img-${index}`}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                  {attachedFiles.map((file, index) => (
                    <FileAttachment
                      key={`file-${index}`}
                      file={file}
                      onRemove={() => onRemoveFile(index)}
                      uploadProgress={uploadingFiles.get(file.name)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputButton
              tooltip={{
                content: provider !== 'claude'
                  ? t('input.nonClaudeAttachmentHint')
                  : t('input.attachFilesAndImages'),
              }}
              onClick={openImagePicker}
              aria-label={
                provider !== 'claude'
                  ? t('input.nonClaudeAttachmentHint')
                  : t('input.attachFilesAndImages')
              }
            >
              <ImageIcon />
            </PromptInputButton>

            <button
              type="button"
              onClick={onModeSwitch}
              className={`rounded-lg border p-2 text-xs font-medium transition-all duration-200 sm:px-2.5 sm:py-1 ${
                permissionMode === 'default'
                  ? 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
                  : permissionMode === 'acceptEdits'
                    ? 'border-green-300/60 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-600/40 dark:bg-green-900/15 dark:text-green-300 dark:hover:bg-green-900/25'
                    : permissionMode === 'auto'
                      ? 'border-blue-300/60 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-600/40 dark:bg-blue-900/15 dark:text-blue-300 dark:hover:bg-blue-900/25'
                      : permissionMode === 'bypassPermissions'
                        ? 'border-orange-300/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25'
                        : permissionMode === 'coordinator'
                          ? 'border-violet-300/60 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-600/40 dark:bg-violet-900/15 dark:text-violet-300 dark:hover:bg-violet-900/25'
                          : 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10'
              }`}
              title={t('input.clickToChangeMode')}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${
                    permissionMode === 'default'
                      ? 'bg-muted-foreground'
                      : permissionMode === 'acceptEdits'
                        ? 'bg-green-500'
                        : permissionMode === 'auto'
                          ? 'bg-blue-500'
                          : permissionMode === 'bypassPermissions'
                            ? 'bg-orange-500'
                            : permissionMode === 'coordinator'
                              ? 'bg-violet-500'
                              : 'bg-primary'
                  }`}
                />
                <span className="hidden whitespace-nowrap sm:inline">
                  {permissionMode === 'default' && t('codex.modes.default')}
                  {permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
                  {permissionMode === 'auto' && t('codex.modes.auto')}
                  {permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
                  {permissionMode === 'plan' && t('codex.modes.plan')}
                  {permissionMode === 'coordinator' && t('codex.modes.coordinator')}
                </span>
              </div>
            </button>

            {provider === 'claude' && (
              <>
                <ThinkingModeSelector selectedMode={thinkingMode} onModeChange={setThinkingMode} onClose={() => {}} className="" />
                {thinkingMode === 'ultracode' && (
                  <span
                    className="hidden items-center rounded border border-red-400 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-red-700 shadow-[0_0_8px_rgba(239,68,68,0.40)] dark:border-red-600 dark:bg-red-950 dark:text-red-300 dark:shadow-[0_0_10px_rgba(239,68,68,0.55)] sm:flex"
                    aria-label={t('effortMode.ultracodeActive')}
                  >
                    ULTRACODE
                  </span>
                )}
              </>
            )}

            {/* Token usage + context-rot indicator gate.
                Claude exports live token usage; OpenCode also emits a real
                `token_budget` after each run closes (opencode-cli.js:268-277),
                so its counter must show too — the B-92 fix wrongly limited this
                to Claude and hid the OpenCode budget that IS populated (OC-20).
                TACTICAL EXCEPTION to "no new provider=== checks": this is the
                sanctioned fallback that does NOT wait on T-224 (see plan §7.3).
                REMOVE this widened gate when T-224 m0 lands the provider
                capability descriptor (`opencode: tokenCounter live`) — the
                widget should then read a capability flag, not a provider id. */}
            {(provider === 'claude' || provider === 'codex' || provider === 'opencode') && (
              <TokenUsageSummary usage={tokenBudget} />
            )}

            {/* Wrapper span establishes the containing block for the badge.
              * Firefox/Gecko (bug 1392476) does not let a <button> with
              * position:relative anchor absolutely-positioned descendants, so
              * the badge must be a SIBLING of the button inside a non-button
              * positioned ancestor — otherwise it escapes and the form's
              * overflow-hidden clips it (works in Chromium, hidden in FF/Zen). */}
            <span className="relative inline-flex">
              <PromptInputButton
                tooltip={{ content: t('input.showAllCommands') }}
                onClick={onToggleCommandMenu}
              >
                <MessageSquareIcon />
              </PromptInputButton>
              {slashCommandsCount > 0 && (
                <span
                  className="pointer-events-none absolute -right-1 -top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                >
                  {slashCommandsCount}
                </span>
              )}
            </span>

            {hasInput && (
              <PromptInputButton
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
                className="sm:No-flex hidden"
              >
                <XIcon />
              </PromptInputButton>
            )}

          </PromptInputTools>

          <div className="flex shrink-0 items-center gap-2">
            {/* min-w-0 + truncate: in a squeezed composer column the hint
              * ellipsizes on one line instead of wrapping over the toolbar
              * (lg: sees viewport width, not pane width). */}
            <div
              className={`ms-2 hidden min-w-0 truncate text-xs text-muted-foreground/50 transition-opacity duration-200 lg:block ${
                input.trim() ? 'opacity-0' : 'opacity-100'
              }`}
            >
              {sendByCtrlEnter ? t('input.hintText.ctrlEnter') : t('input.hintText.enter')}
            </div>
            <PromptInputSubmit
              disabled={!input.trim() || isLoading || !isWsConnected}
              title={!isWsConnected ? t('ws.sendDisabledTitle', { defaultValue: 'Cannot send — connection lost' }) : undefined}
              className="h-10 w-10 shrink-0 sm:h-10 sm:w-10"
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}
