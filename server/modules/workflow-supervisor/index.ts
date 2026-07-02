/**
 * Public barrel — the workflow-supervisor module's cross-module API (ADR-053,
 * M-BG-2-CODE). External consumers (the providers workflow-status service and the
 * claude-sdk launch bridge) import from HERE per the boundaries/dependencies
 * contract; files INSIDE the module import their siblings directly.
 *
 * The whole feature is gated behind WORKFLOW_SUPERVISOR (see ./config.ts):
 * writeLaunchIntent is a hard no-op and buildScopeLivenessResolver returns null
 * when the flag is off, so importing this barrel is side-effect-free by default.
 */
export { writeLaunchIntent } from '@/modules/workflow-supervisor/launch-intent.js';
export type {
  WriteIntentInput,
  WriteIntentResult,
} from '@/modules/workflow-supervisor/launch-intent.js';
export { buildScopeLivenessResolver } from '@/modules/workflow-supervisor/scope-status.js';
export type { ScopeLivenessResolver } from '@/modules/workflow-supervisor/scope-status.js';
