# ADR-036: Hosted Vendor Model Integration (Kimi / DeepSeek / GLM + Fable 5)

- Status: Accepted
- Date: 2026-06-19
- Scope: **Internal, single-user** (one operator, their own data)

## Context

nassaj-dev is an internal development tool (AGPL-3.0 fork of claudecodeui) used by
a single operator on their own data. We add four selectable models:

- **Fable 5** (`claude-fable-5`) — an Anthropic model, surfaced through the
  existing `claude` provider; governed automatically by the iron-rule guard on
  the claude path.
- **Kimi** (Moonshot), **DeepSeek**, **GLM** (Zhipu / Z.ai) — hosted third-party
  HTTP APIs, each added as its own provider over the existing
  `server/modules/providers` layer (the Cursor pattern).

**Scope correction (governing this ADR):** an earlier plan revision gated these
providers behind a PDPL / DPA / data-residency / external-legal-review work item
(M-VR-0 / vendor-routing-gate / B-VR-9). That gate is **dropped**. The use is
internal and individual — the operator runs the tool on their own data. There is
no third-party data subject, so PDPL/DPA/data-residency obligations are not
triggered by this usage. A vendor therefore becomes usable **simply when its API
key is configured** (the same auth-status behavior as every other provider —
ADR-030), with no separate routing gate.

The real guardrails we keep are the ones that protect correctness, the Claude
relationship, and the license:

1. **Iron rule** — never route a Claude client to a competitor.
2. **Isolated, encrypted per-user secret store** for vendor keys.
3. **Independent run seam** — the vendor path shares no code with the Claude
   path, so a Claude session can never become a training input to a vendor (no
   output distillation).
4. **Dependency-license check** — no new dependency was added; the seam uses
   only Node built-ins (`fetch`, `node:crypto`) and existing in-repo modules,
   so AGPL-3.0 §13/§7 is unaffected.

## Decision

### Fable 5 — catalog-only

Add `claude-fable-5` to `CLAUDE_FALLBACK_MODELS` (and it appears live from the
catalog when reachable). The app drives Claude via `@anthropic-ai/claude-agent-sdk`
(`query()`), which accepts the model string directly and handles
thinking/effort/refusal/fallbacks internally — so there is **no raw Messages
request to modify**. Fable is governed by the existing iron-rule guard because it
travels the claude path.

### Kimi / DeepSeek / GLM — independent provider + run seam

- **Provider folders** (`list/{kimi,deepseek,glm}/`) follow the Cursor pattern:
  inherit `McpProvider`/`SkillsProvider` from the shared bases, implement
  `models`/`auth`/`sessions`/`sessionSynchronizer` concretely via a shared
  `shared/vendor/*` scaffold. Registered in `provider.registry.ts` so they
  surface automatically in `/api/providers/:provider/models` and `/auth/status`.
- **Base URLs are hard-coded** in `shared/vendor/vendor-config.ts`
  (`api.moonshot.ai/anthropic`, `api.deepseek.com/anthropic`,
  `api.z.ai/api/anthropic`) — never an env var. The live model list is fetched
  from `<base>/v1/models` with a conservative `<ID>_FALLBACK_MODELS` fallback
  (timeout + circuit breaker + single-flight + SWR; never throws).
- **Per-user key isolation:** an encrypted store
  (`services/isolation/provider-secrets-store.js`, AES-256-GCM at rest, server
  key outside the repo) holds each user's `KIMI_API_KEY`/`DEEPSEEK_API_KEY`/
  `GLM_API_KEY`. `resolveProviderEnv` decrypts and injects it as that env var per
  spawn. The three default to `'isolated'` in the sharing policy.
- **Run seam** (`server/{kimi,deepseek,glm}-cli.js` over
  `shared/vendor/vendor-runtime.js`) streams Anthropic-compatible SSE via plain
  `fetch`. It does **not** import `@anthropic-ai/*` and does **not** route
  through `claude-sdk.js`; it reads the key only from `resolveProviderEnv` (never
  the raw shared `process.env`, the leak that `cursor-cli.js` has). nassaj owns
  the transcript as JSONL so remote sessions have local history.
- **Compatibility specifics:** DeepSeek rescues textual tool_calls into
  `tool_use`; GLM long streams are recorded per-event so history never drops
  messages; Kimi temperature is clamped to `[0,1]`.

## Why these choices

- **`isolated` by default** — a vendor key is personal; falling back to a shared
  operator key would leak one user's credential to another.
- **Hard-coded base URL** — keeps the iron-rule boundary explicit and auditable;
  the only per-user value that flows from config is the API key.
- **Independent HTTP client (no Anthropic SDK)** — both upholds the iron rule and
  guarantees storage/seam separation from the Claude path.

## Consequences

- The three vendors are usable the moment a key is configured; no routing gate.
- The iron rule is enforced two ways: a **positive** test (the env produced for
  each vendor carries no `ANTHROPIC_*`/`CLAUDE_*` key) and a **static** test (the
  seam source imports no Anthropic SDK / `claude-sdk.js`).
- All tests are `node:test` + `node:assert/strict` (the project runner is
  `tsx --test`, not vitest).
- Frontend picker wiring (chat hooks, login modal, provider cards, the
  `Record<LLMProvider, …>` maps) is a separate frontend-dev task; the backend
  fully exposes the providers via the registry and routes.

## Guardrails (kept) vs gates (dropped)

| Kept (real) | Dropped (not triggered by internal-individual use) |
| --- | --- |
| Iron rule (positive + static tests) | PDPL consent / data-residency decision |
| Encrypted per-user secret store | Per-vendor signed DPA |
| Independent run seam (no Claude-output distillation) | External licensed-lawyer review (G1) |
| New-dependency license check (none added) | `vendor-routing-gate` runtime block (B-VR-9) |
