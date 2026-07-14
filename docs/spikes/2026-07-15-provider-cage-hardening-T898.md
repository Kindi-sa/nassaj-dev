# T-898 — provider-cage pre-go-live hardening (credential file-masks + shared-store writes)

**Date:** 2026-07-15 · **Branch:** `fix/security-remediation-2026-07-09` · **Flag:** `NASSAJ_PROVIDER_CAGE` (default **OFF** — the off path is byte-identical, zero change).

Closes the two structural gaps the 2026-07-14 disk spike proved (`docs/spikes/2026-07-14-provider-cage-spike.md`) that held the `NASSAJ_PROVIDER_CAGE` flag OFF under a qa-critic veto:

- **GAP 1 (credential harvest):** `--ro-bind / /` left every operator credential in the shared `$HOME` readable inside every cage — a full credential harvest in one prompt-injected turn.
- **GAP 1b / GAP 2 (silent write loss):** the by-design-shared stores were read-only inside the cage, so transcripts silently EROFS-dropped and hermes broke outright.

All evidence below is from REAL caged launches whose argv was produced by the **shipped** wiring (`resolveCagedLaunch` / `cageMountPlan`), on the REAL operator `$HOME` and REAL per-user tree of user `2` (Jazari), cwd a throwaway `mktemp -d` outside any project. No synthetic fixtures (lesson 2026-06-28). Raw logs: `./2026-07-15-provider-cage-mask-artifacts/`.

## What changed

`provider-cage.js` `buildCagedLaunch` gained two ordered mount classes, distinct from the existing `hidePaths` (tmpfs over DIRECTORIES):

- **`writePaths`** — shared stores/caches re-bound **read-write** (`--bind p p`), placed after the hides and before the usersRoot tmpfs (isolation overlays still win on overlap).
- **`maskFiles`** — single credential FILES blanked with **`--ro-bind /dev/null <file>`**, mounted **LAST** so no later bind (per-user rebind, cwd, writePaths) can re-expose a masked credential. `tmpfs` cannot mount over a file (aborts bwrap boot — verified 2026-07-14); `/dev/null` is the file-level primitive.

`provider-cage-wiring.js` computes the per-launch plan (`cageMountPlan`), consulted **only on the flag-on path** (no DB read when off):

- **`CAGE_SHARED_CREDENTIALS`** — the registry of every operator-`$HOME` credential the spike proved readable, keyed by owning provider: claude (`.claude/.credentials.json` + `~/.claude.json`), codex (`.codex/auth.json`), agy (`antigravity-oauth-token`), hermes (`.hermes/auth.json`), opencode (`.local/share/opencode/auth.json`). gemini has no operator-level credential file (verified on disk); cursor is not installed on any node.
- **Entitlement rule for the launching provider's OWN credential** (the ONLY shape that keeps owner-reuse working, ADR-023):
  - admin-policy **shared** mode → the operator credential IS the policy → readable + rw (token refresh must persist);
  - **isolated** + a provisioned owner-reuse symlink (`~/.nassaj-users/<id>/… → operator file`, proven by realpath equality, never a role lookup) → readable + rw;
  - **isolated**, no entitlement link → **its own provider's operator credential is masked too** (the user runs on their per-user `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, not the shared file).
  - Every OTHER provider's credential is ALWAYS masked.
- **Realpath normalization (`toRealMountPath`)** — mount targets are resolved to their real path. `~/.claude` is itself a symlink to `~/nassaj-core` on fleet nodes; bwrap cannot bind/mask a dest that traverses a symlink (`Can't mkdir …: No such file` — reproduced on disk). Masking the real path also closes the aliasing loophole (no alternate path escapes the mount) and dedups paths that collapse to one file.

## Evidence — per credential (artifact 01, claude cage, user 2)

| Credential file | Host (no cage) | Inside claude cage | Verdict |
|---|---|---|---|
| `~/.claude/.credentials.json` (→ realpath `~/nassaj-core/…`) | 509 B | 0 bytes, content unreadable | **MASKED** |
| `~/.claude.json` (Anthropic OAuth) | 50214 B | 0 bytes, content unreadable | **MASKED** |
| `~/.codex/auth.json` | 4120 B | 0 bytes, content unreadable | **MASKED** |
| `~/.gemini/antigravity-cli/antigravity-oauth-token` | 506 B | 0 bytes, content unreadable | **MASKED** |
| `~/.hermes/auth.json` | 9698 B | 0 bytes, content unreadable | **MASKED** |
| `~/.local/share/opencode/auth.json` | 123 B | 0 bytes, content unreadable | **MASKED** |
| `~/.ssh` (fleet key dir, T-897) | present | empty (tmpfs) | **HIDDEN** (artifact 06) |
| **user 2 OWN** `~/.nassaj-users/2/.claude/.credentials.json` | 600 B | **600 B readable** | **FUNCTION PRESERVED** |

Masking mechanism: `--ro-bind /dev/null <file>` binds the null char device (`stat` → 0 bytes, `cat` → EACCES). Both zero-length AND unreadable — strictly stronger than "readable but empty".

## Evidence — function is preserved (proved, not assumed)

- **claude boots caged with all shared creds masked** (artifact 02): `claude --version` → `2.1.207`, exit 0; `claude mcp list` → runs the real health check, exit 0 (the only failure is `plugin:github` HTTP auth — cage-independent, identical uncaged), with `CLAUDE_CONFIG_DIR=~/.nassaj-users/2/.claude`.
- **A real `claude -p` turn persists its transcript** (artifact 04): `claude -p "Reply with exactly: OK"` → stdout `OK`, exit 0; a `.jsonl` transcript (20599 B) landed in the shared store `~/nassaj-core/projects/<cwd-slug>/` (spike junk cleaned up after capture per B-28/B-29).
- **Other providers boot caged** (artifact 05): agy `1.1.1`, hermes `v0.17.0` (Python env intact), opencode `1.17.18`, gemini `1.1.1` — all exit 0.

## Evidence — GAP 1b was a REAL production regression, now fixed (artifact 03)

Writing through the **per-user** projects symlink (`~/.nassaj-users/2/.claude/projects` → `~/nassaj-core/projects`, the exact production path):

- **OLD recipe (T-897 denylist, no writePaths):** `WRITE_FAIL … Read-only file system` — so flipping the flag as-shipped WOULD have silently stopped persisting claude/gemini/agy history and EROFS-broken hermes. Not a spike artifact — the production per-user path regressed.
- **NEW recipe (T-898 plan):** `WRITE_OK`.

## Evidence — entitlement + isolation invariants hold

- **Shared-mode agy** (live policy `shared`, artifact 05): own token READABLE (506 B) + brain WRITABLE; claude credential MASKED inside the agy cage.
- **hermes** (no per-user knob, policy-shared): own auth READABLE (9698 B) + `~/.hermes` WRITABLE; claude credential MASKED.
- **T-897 invariants still hold under the new mounts** (artifact 06): other users' trees HIDDEN, their credentials HIDDEN, `docker.sock` HIDDEN, own tree WRITABLE, `~/.ssh` empty.

Per-launch plans for all five caged providers are in artifact 00 (`cageMountPlan(...)`), each derived from the shipped code against the live sharing policy in `db.sqlite`.

## Toolchain caches

`~/.npm` + `~/.cache` are re-bound rw for every caged provider (npx-launched stdio MCP servers EROFS without them — 2026-07-14 artifacts 03/04). Shared-rw across users is the documented trade-off (identical to today, uncaged); **per-user cache redirection remains an owner decision** (2026-07-14 spike rec §2).

## Operator-secret denylist — second qa-critic pass (2026-07-15)

The first pass masked only the **provider-keyed** credentials (`CAGE_SHARED_CREDENTIALS`). A second live `bwrap` review proved the `--ro-bind / /` cage still left **non-provider operator secrets** readable — the same GAP-1 harvest class, one prompt-injection away over the (necessarily) shared network. This pass sweeps the whole shared-`$HOME` secret surface, not the two files the review happened to name. Two new registries in `provider-cage-wiring.js`, both realpath-normalized + existsSync-filtered, wired unconditionally into every caged launch (mechanism in `provider-cage.js` is UNCHANGED — this is pure policy):

- **`CAGE_OPERATOR_SECRET_FILES`** → `--ro-bind /dev/null` (file mask): `.config/gh/hosts.yml`, `.nassaj-provider-secrets.key`, `.docker/config.json`, `.netrc`, `.git-credentials`.
- **`CAGE_SECRET_HIDE_DIRS`** → tmpfs (dir blank): `.ssh` (T-897), `.gnupg`, `.cloudflared`, `.aws`, `.config/gcloud`, `.cloudcli`, `.local/share/nassaj-dev`, `.nassaj-provider-secrets`; **plus** the live-globbed `cdxrt.*​/secret` Codex runtime auth dirs (random suffix, ephemeral).

Why files vs dirs: `tmpfs` blanks a DIRECTORY, `--ro-bind /dev/null` a single FILE (tmpfs over a file aborts bwrap boot). A secret is never both file-masked AND inside a hidden dir (that overlap would abort bwrap on the now-missing mount point) — verified by construction and on disk.

**Explicitly NOT blind-globbed.** `*credential*` / `config.json` globs hit **source files** (`~/.hermes/hermes-agent/.../credential_*.py`) and **tool prefs** (`~/.config/astro/config.json`, `~/.gemini/config/config.json`) on disk — masking those would corrupt function for zero security gain. The denylist is an **explicit path list**, grounded in a real HOME scan (2026-07-15), not a pattern sweep.

### Evidence — artifact 07 (`07-operator-secret-masks.log.txt`)

Produced by the **shipped** `resolveCagedLaunch` (real operator `$HOME`, user 2 tree rebound, throwaway `mktemp` cwd, isolated policy). Host → inside-claude-cage:

| Secret | Host (uncaged) | Inside cage | Verdict |
|---|---|---|---|
| `~/.config/gh/hosts.yml` (GitHub OAuth) | 210 B | 0 B, `cat`→0 bytes | **MASKED** |
| `~/.nassaj-provider-secrets.key` (decrypts every stored provider key) | 32 B | 0 B, `cat`→0 bytes | **MASKED** |
| `~/.cloudflared/cert.pem` (tunnel cred) | 282 B | ABSENT (tmpfs) | **HIDDEN** |
| `~/.cloudcli/auth.db` (stale pw-hashes + api_keys) | 389 120 B | ABSENT (tmpfs) | **HIDDEN** |
| `~/.local/share/nassaj-dev/db.sqlite` (LIVE pw-hashes + api_keys) | 1 343 488 B | ABSENT (tmpfs) | **HIDDEN** |
| `~/.gnupg/pubring.kbx` (GPG keyring) | 32 B | ABSENT (tmpfs) | **HIDDEN** |
| `~/cdxrt.Cncf31/secret/auth.json` (Codex runtime token) | 22 B | ABSENT (tmpfs) | **HIDDEN** |
| `~/.ssh/id_nassaj_fleet` (T-897 regression control) | present | ABSENT | **HIDDEN (still)** |
| `/etc/hostname` + cwd marker (positive controls) | 7 B / 17 B | readable, same bytes | **NOT over-masked** |

Cage exit 0 — the expanded mount set boots.

### Evidence — no provider function broke (artifact 07)

All caged, new masks active, user-2 tree rebound: **claude** `--version` `2.1.207` + `mcp list` runs its health check (exit 0 — the sole `plugin:github` failure is an HTTP endpoint at `api.githubcopilot.com`, **cage-independent and identical uncaged**; it is NOT `gh/hosts.yml`, so the gh mask does not break MCP); **agy** `1.1.1`, **gemini** `1.1.1`, **opencode** `1.17.18`, **hermes** `v0.17.0` (Python env intact) — all exit 0. `~/.npm`/`~/.cache` are untouched by this pass, so npx-stdio MCP boot (2026-07-14 artifact 04) is unaffected.

### Function-vs-security decision — `~/.npmrc` (owner)

`~/.npmrc` is **deliberately NOT masked**. `npx`-launched stdio MCP servers read it for registry config, so a private-registry auth token there is a **provider-NEEDED secret** — blind-masking it would break MCP install from a private registry. It is **absent on every fleet node today** (public registry only), so leaving it readable exposes nothing now. Rule: block the explicit UNNEEDED secret (gh/cdxrt/cloud/keystore); a secret the provider legitimately needs is an **owner decision**, not a blind break. → **owner call before a node ever adds a private-registry `.npmrc`:** per-user `.npmrc` redirection, or accept the token readable in-cage.

## Residual / owner decisions before flipping the flag

0. **STRUCTURAL — a denylist is fail-OPEN for FUTURE secrets (root fix = allowlist).** Everything above hides *known* secret paths. Any NEW credential a tool drops into the shared `$HOME` tomorrow (a new provider's `auth.json`, a fresh CLI's token) is **readable inside the cage until someone adds it to the registry** — the cage's `--ro-bind / /` exposes the whole FS by default. This is inherent to denylisting and cannot be closed by adding more entries.
   **RECOMMENDATION (owner decision, NOT implemented here):** invert to an **allowlist** — bind only the handful of paths a provider provably needs (its own config tree, `~/.npm`, `~/.cache`, cwd) onto an otherwise-`--tmpfs` `$HOME`, instead of ro-binding all of `$HOME` and subtracting secrets. That makes a new secret fail-CLOSED (hidden unless explicitly allowed). It is a larger change (must enumerate every provider's real read set and prove boot for each) and is left as the T-898 follow-up, deferred to the owner.
1. **cdxrt glob is point-in-time.** `cdxrt.*​/secret` dirs are hidden as they exist *at launch*; a Codex runtime dir created *after* a cage is already running is not retroactively hidden in that live cage (masked on the next launch). Inherent to mount-at-spawn; acceptable (codex is cage-exempt and self-cages its own runtime).
2. **hermes has no per-user credential knob** — `~/.hermes` (auth + state.db) is bound rw wholesale (shared by all users) because hermes is not yet multi-user. Same exposure as today uncaged; a real fix needs hermes multi-user support. Owner call: accept shared, or block hermes under the cage.
3. **`~/.npmrc` (function-vs-security)** — left readable so private-registry MCP install keeps working; owner call before any node adds a private-registry `.npmrc` (see the decision box above).
4. **`~/.npm` / `~/.cache` shared-rw** vs per-user redirection (isolation-vs-cost trade).
5. **Full fail-closed on missing bwrap** (T-898 item 2) — still **NOT** implemented; the cage stays fail-safe (run unwrapped + warn every spawn). bwrap ships bundled with `@openai/codex` so it resolves on every fleet node today; converting to hard refusal touches the six launchers' control flow and is an owner decision, not done here.
6. **cursor** — not installed on any node; its credential path is unverified (registry omits it deliberately).
7. **Residual to GAP-1 even masked:** a uid-0 process or a setfacl ACL on a credential bypasses a mount mask (out of scope, same class as the T-896 docker-guard residual).

## Go-live readiness

The blocking gaps under the qa-critic veto are **closed and disk-proven**: (1) every shared-`$HOME` provider credential is masked while per-user function is intact, (1b/2) shared-store writes persist, and (1c, this pass) the **non-provider operator secret harvest** — GitHub OAuth, the provider-secrets master key, tunnel/GPG/cloud creds, the live app-db with password hashes + api_keys, and the Codex runtime tokens — is masked/hidden too, with every provider still booting (artifact 07). **A second critical review is still required before enabling the flag** (the veto asked for it), and the residuals above are owner decisions — chief among them the **denylist→allowlist inversion (item 0)**, the only thing that makes a *future* secret fail-closed. But the "fail-open for the highest-value secret class" + "fail-broken for shared writes" conditions that made enabling the flag a false security win no longer hold.
