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

## Residual / owner decisions before flipping the flag

1. **hermes has no per-user credential knob** — `~/.hermes` (auth + state.db) is bound rw wholesale (shared by all users) because hermes is not yet multi-user. Same exposure as today uncaged; a real fix needs hermes multi-user support. Owner call: accept shared, or block hermes under the cage.
2. **`~/.npm` / `~/.cache` shared-rw** vs per-user redirection (isolation-vs-cost trade).
3. **Full fail-closed on missing bwrap** (T-898 item 2) — still **NOT** implemented; the cage stays fail-safe (run unwrapped + warn every spawn). bwrap ships bundled with `@openai/codex` so it resolves on every fleet node today; converting to hard refusal touches the six launchers' control flow and is an owner decision, not done here.
4. **cursor** — not installed on any node; its credential path is unverified (registry omits it deliberately).
5. **Residual to GAP-1 even masked:** a uid-0 process or a setfacl ACL on a credential bypasses a mount mask (out of scope, same class as the T-896 docker-guard residual).

## Go-live readiness

The two blocking gaps under the qa-critic veto are **closed and disk-proven**: (1) every shared-`$HOME` provider credential is masked while per-user function is intact, and (1b/2) shared-store writes persist. **A second critical review is still required before enabling the flag** (the veto explicitly asked for it), and items 1–3 above are owner decisions — but the "fail-open for the highest-value secret class" + "fail-broken for shared writes" conditions that made enabling it a false security win no longer hold.
