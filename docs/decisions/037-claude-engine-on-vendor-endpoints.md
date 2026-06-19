# ADR-037: Claude Engine on Vendor Anthropic-Compatible Endpoints

- Status: Accepted
- Date: 2026-06-20
- Scope: **Internal, single-user** (one operator, their own data)
- Relates to: ADR-036 (vendor RUN seam), ADR-030 (auth-status model gating),
  ADR-014/016 (credential isolation seam)

## Context

ADR-036 added Kimi / DeepSeek / GLM as **independent run seams**: each is its own
HTTP client with a hard-coded base URL and a provider-specific key var, and the
iron-rule guard guarantees that path can never point a *Claude* client at a
competitor.

There is a second, distinct way these vendors can be used. Kimi, DeepSeek and GLM
each expose an **Anthropic-compatible** endpoint (`/anthropic`, `/v1/messages`):

- `kimi` → `https://api.moonshot.ai/anthropic`
- `deepseek` → `https://api.deepseek.com/anthropic`
- `glm` → `https://api.z.ai/api/anthropic`

The Claude Agent SDK already honors `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
So a user can run **the Claude engine itself** (the SDK, with all of Claude Code's
tools/permissions/MCP machinery) against a vendor endpoint by setting those two
env vars on the spawn. This is the OPPOSITE posture from ADR-036's iron rule,
which forbids touching `ANTHROPIC_*` on the vendor path.

We want this engine path, for internal single-user use, **without** weakening the
protection ADR-036 gives the normal Claude path: an off-Anthropic base URL must
never reach a spawn *implicitly* (a stray `ANTHROPIC_BASE_URL` in the environment
or in `settings.json` must not silently redirect a real Claude run).

We also want a lighter capability: letting a Claude run **delegate a single
prompt** to a vendor model mid-run (a "second opinion" tool), without changing the
run's own engine.

## Alternatives considered

1. **Reuse the ADR-036 run seam for the engine path.** Rejected: the run seam is
   deliberately Anthropic-free (no `@anthropic-ai/*`, no `ANTHROPIC_*`); driving
   the actual Claude SDK requires setting `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`,
   which is exactly what that seam must never do. Mixing the two would dissolve the
   static iron-rule boundary.
2. **Set the engine env globally / via `process.env`.** Rejected: it would leak a
   base URL across concurrent users/spawns and is unauditable. The engine env must
   be built on the per-spawn env object only.
3. **Trust the environment / `settings.json` as-is** (no guard). Rejected: a base
   URL present for any reason would redirect a Claude run unnoticed — the precise
   failure the iron rule exists to prevent.
4. **Drop the Bedrock/Vertex/proxy escape hatch** and allow only the official host
   plus engaged engine hosts. Rejected: legitimate Claude Code installs route
   through Bedrock/Vertex or an operator proxy; a hard allow-list of only
   `api.anthropic.com` would break those setups.

## Decision

Add an engine-on-vendor path fenced by a **fail-closed base-URL guard**, plus an
optional vendor-delegate MCP tool. All new modules live under
`server/services/isolation/` (engine path) and
`server/modules/providers/shared/vendor/` (delegate tool).

1. **Endpoints + sets (B-ENG-1)** — `provider-anthropic-endpoints.js` declares
   `PROVIDER_ANTHROPIC_ENDPOINT`, `ENGINE_PROVIDERS`, and `OFFICIAL_ANTHROPIC_HOSTS`.
   Pure constants; intentionally **outside** the ADR-036 `SEAM_FILES` (it is not
   part of the Anthropic-free run seam).

2. **Engine env injection (B-ENG-2)** — `applyClaudeEngineProviderEnv(env, userId,
   provider)`:
   - no-op (returns `null`) unless `provider ∈ ENGINE_PROVIDERS`;
   - fetches the per-user key via `getProviderKey(userId, provider)` and returns
     `null` if absent — so it injects **both** `ANTHROPIC_BASE_URL` and
     `ANTHROPIC_AUTH_TOKEN` or **neither** (no half-injection);
   - mutates **only the passed env object**; never reads/writes `process.env`;
   - on success returns the single authorized hostname as a `Set`.

3. **Fail-closed guard (B-ENG-3)** — `assertAnthropicBaseUrlAllowed(env, ctx)`:
   for every `*_BASE_URL` (env keys + `ctx.extraValues` from settings.json) it
   parses the URL (an unparseable value is rejected) and requires the host to be
   official, OR in `ctx.engineProviderHosts` (this spawn's engine host), OR
   covered by the **escape hatch** — `CLAUDE_CODE_USE_BEDROCK` /
   `CLAUDE_CODE_USE_VERTEX` flags, or the `NASSAJ_ALLOWED_ANTHROPIC_HOSTS` env
   list. Otherwise it throws. With no engine host supplied it still runs, so any
   unknown `*_BASE_URL` fails closed.

4. **Settings.json channel (B-ENG-3b)** — `collectSettingsBaseUrls(env)` reads the
   same `settings.json` `env` block Claude Code reads at spawn and returns its
   `*_BASE_URL` values for the guard to vet (degrades to `[]` on a missing/corrupt
   file).

5. **Integration (B-ENG-4)** — in `server/claude-sdk.js`, after the env/MCP are
   built and **before** `query()`, the spawn calls apply → collect → assert. The
   no-hooks retry `query()` reuses the same `sdkOptions.env`, so the single guard
   covers every spawn path. The Claude model filter is bypassed (the vendor model
   id is passed through unchanged) **only when** an engine provider was actually
   engaged (`injectedHosts !== null`).

6. **Vendor-delegate MCP (B-DEL-5/6)** — `buildVendorDelegateMcp(userId)` builds a
   per-spawn in-process MCP server exposing `delegate_to_vendor`. The tool calls
   the vendor's `/v1/messages` as an independent `fetch` with an `x-api-key`
   header; it never touches `ANTHROPIC_*`/`CLAUDE_*` or `sdkOptions.env`, so it
   cannot redirect the engine. It is registered only when the agent's "allow
   delegation" flag is set, and the user id is captured in the tool closure (no
   global instance), so the key is always per-user.

## Consequences

- A user can run the Claude engine on a vendor endpoint, but **only** by
  explicitly selecting an engine provider for which they have a stored key. An
  off-Anthropic base URL can never reach a spawn implicitly: the guard fails
  closed on any unknown `*_BASE_URL` in the env or in `settings.json`.
- Legitimate Bedrock/Vertex/proxy Claude Code setups keep working via the
  env-driven escape hatch (never hard-coded; default install stays fail-closed).
- The ADR-036 RUN seam and its iron-rule tests are untouched: the new engine
  modules are deliberately outside `SEAM_FILES`, and the delegate tool — while it
  uses the SDK's MCP wrapper — routes no Claude traffic and stays out of that set.
- Per-user isolation holds: both the engine token and the delegate key come from
  the encrypted per-user store keyed on `ws?.userId ?? null`; nothing is written
  to `process.env`.
- Enforced by `server/services/isolation/claude-engine-provider.test.ts`
  (`node:test`): no-half-injection, process.env untouched, per-user key,
  fail-closed/unparseable rejection, engine-host-via-ctx-only, escape hatches, and
  the settings.json channel. The five mandatory isolation cases (B-TEST-7) are
  additionally consolidated in
  `server/services/isolation/engine-provider-isolation.test.ts`: (1) no
  process.env leak after `applyClaudeEngineProviderEnv`, (2) guard throws on a
  non-official `*_BASE_URL` and on an unparseable URL, (3) a settings.json-smuggled
  base URL is blocked via `collectSettingsBaseUrls` + the guard, (4) no
  half-injection without a key, (5) two userIds → two keys — plus the per-spawn
  delegate userId-isolation check.
- The vendor-delegate tool (B-DEL-5) is enforced by
  `server/modules/providers/shared/vendor/vendor-delegate-mcp.test.ts`
  (`node:test`, no network): per-spawn construction (distinct instances, no global),
  membership gate, no-key path makes no `fetch`, per-user `x-api-key` to the right
  vendor endpoint, per-user closure isolation, no `ANTHROPIC_`/`CLAUDE_` env mutation
  on any path, and generic non-leaky error surfacing.

## Status

Accepted and implemented (B-ENG-1..4, B-DEL-5/6). B-DEL-6's user-facing control is
the **"Allow delegating subtasks to other models"** toggle in the Claude agent
settings (Permissions tab; persisted in `claude-settings`); when on, the composer
sends `options.allowVendorDelegation` so the server registers the per-spawn
vendor-delegate server keyed to the spawning user. The frontend picker wiring that
lets a user *choose* "Claude engine on vendor" (m-FE-9) follows ADR-030's
auth-status gating and is tracked separately.
