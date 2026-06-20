export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { participantsService } from './services/participants.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// ADR-037: per-spawn vendor-delegate MCP builder. Re-exported from the module
// barrel so cross-module consumers (e.g. the isolation seam tests) depend on the
// public entry point rather than reaching into module internals.
export { buildVendorDelegateMcp } from './shared/vendor/vendor-delegate-mcp.js';
