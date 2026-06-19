# nassaj-dev Architecture — Providers & Vendor Models

> Scope of this document: the multi-provider model layer, with emphasis on the
> hosted vendor models (Kimi / DeepSeek / GLM) and Fable 5 added in ADR-036.
> This is an **internal, single-user** development tool (AGPL-3.0 fork of
> claudecodeui). See `docs/decisions/036-vendor-models-integration.md`.

## Provider layer

Every model integration is a provider under `server/modules/providers/list/<id>/`
exposing six facets (`server/shared/interfaces.ts`):

| Facet | Responsibility |
| --- | --- |
| `models` | Resolve the model catalog + active/selected model |
| `auth` | Report install/auth state |
| `mcp` | Read/list/write provider-native MCP config |
| `skills` | Discover provider-native skills |
| `sessions` | Normalize live events + fetch history |
| `sessionSynchronizer` | Index transcript artifacts into the DB |

`models`, `auth`, `sessions`, `sessionSynchronizer` are implemented concretely
(they depend on native SDK/CLI formats). `mcp`/`skills` inherit shared abstract
bases (`shared/mcp/mcp.provider.ts`, `shared/skills/skills.provider.ts`). The
Cursor provider is the reference; the new vendor providers follow it.

Providers are registered in `provider.registry.ts`, which makes them resolve via
`resolveProvider` and surface automatically in `/api/providers/:provider/models`
and `/auth/status`.

## Current providers

`claude`, `codex`, `cursor`, `gemini`, `antigravity`, `opencode`, and the three
hosted vendors `kimi`, `deepseek`, `glm`.

## Fable 5 (catalog-only)

`claude-fable-5` is an Anthropic model surfaced through the existing `claude`
provider's catalog (`CLAUDE_FALLBACK_MODELS`). The app drives Claude via the
Agent SDK (`query()`), which accepts the model string directly — there is no raw
Messages request to change. Fable travels the claude path and is therefore
covered by the iron-rule guard automatically.

## Hosted vendor models (Kimi / DeepSeek / GLM)

These are remote HTTP APIs (Moonshot, DeepSeek, Zhipu/Z.ai), not local CLIs.
They were added for internal single-user use; a vendor becomes usable the moment
its API key is configured (ADR-030 auth-status behavior), with no routing gate.

```
                 provider.registry.ts
                         │
   list/{kimi,deepseek,glm}/<id>.provider.ts  (Cursor pattern)
        │ models   │ auth        │ sessions / synchronizer   │ mcp/skills
        ▼          ▼             ▼                           ▼
 vendor-catalog  vendor-auth  vendor-sessions /          McpProvider /
 .client.ts      .provider.ts vendor-session-            SkillsProvider
 (live /v1/models, (key present  synchronizer.provider.ts (empty: no native
  breaker, SWR)    in store?)   (Anthropic events ↔        MCP/skill store)
                                 NormalizedMessage,
                                 JSONL transcript)

 RUN SEAM  (separate from the Claude path)
   server/{kimi,deepseek,glm}-cli.js
        │  spawn<Provider> / abort / isActive / getActive
        ▼
   shared/vendor/vendor-runtime.js
        - plain fetch → <baseUrl>/v1/messages (SSE)      ← NO @anthropic-ai SDK
        - key from resolveProviderEnv only               ← NO raw process.env
        - writes JSONL transcript + streams normalized events
        ▲
   index.js chat object → chat-websocket.service.ts dispatch (kimi/deepseek/glm)
```

### Iron rule (hard boundary)

The vendor run seam can never route a Claude client to a competitor:

- Base URLs are **hard-coded** in `shared/vendor/vendor-config.ts`, never read
  from `ANTHROPIC_BASE_URL`.
- The key is a provider-specific env var (`KIMI_API_KEY` / `DEEPSEEK_API_KEY` /
  `GLM_API_KEY`) injected by `resolveProviderEnv` — never `ANTHROPIC_AUTH_TOKEN`
  and never any `ANTHROPIC_*`/`CLAUDE_*` key.
- The seam uses plain `fetch` and imports neither `@anthropic-ai/*` nor
  `claude-sdk.js`.

Enforced by two tests (`node:test`):
`server/services/isolation/iron-rule-guard.test.ts` (static: no Anthropic-SDK
import, no `ANTHROPIC_*`/`CLAUDE_*` reference in the seam) and
`server/services/isolation/resolve-provider-env.test.ts` (positive: the produced
env carries the vendor key only, no Anthropic-namespace key).

### Per-user secret isolation

`server/services/isolation/provider-secrets-store.js` encrypts each user's vendor
keys at rest (AES-256-GCM; server key from `NASSAJ_PROVIDER_SECRETS_KEY` or an
auto-generated 0600 key file outside the repo) under
`~/.nassaj-users/<userId>/.provider-secrets/` (a shared home-root store in
single-user mode). `resolveProviderEnv` decrypts and injects per spawn. The three
vendors default to `'isolated'` in `provider-sharing.js`, so they never fall back
to a shared operator key.

### Transcript & history

nassaj owns the vendor transcript (the remote API stores nothing locally): one
JSONL line per event under `~/.nassaj-vendor-sessions/<provider>/<projectHash>/`,
written by the run seam, indexed by the synchronizer, and replayed by
`fetchHistory`.

### Per-vendor compatibility

- **Kimi** — `tool_choice='required'` unsupported; temperature clamped to [0,1].
- **DeepSeek** — ~11% of tool calls can arrive as plain text; rescued into
  `tool_use` by the sessions facet.
- **GLM** — long streams can break mid-flight; per-event JSONL recording makes
  history correctness independent of stream length.

## Guardrails (internal-individual scope)

The real guardrails are: the iron rule, the encrypted per-user secret store, the
independent run seam (which also guarantees no Claude-output distillation), and a
new-dependency license check (no dependency was added — only Node built-ins and
existing modules). PDPL/DPA/data-residency/external-legal gates do not apply to
internal single-user use on the operator's own data.
