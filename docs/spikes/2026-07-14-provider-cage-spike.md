# T-897 m3 — provider-cage per-provider spike (2026-07-14)

Real runs on the live nassaj-dev fleet node — real `bwrap` (the one bundled with
`@openai/codex`), real provider binaries, real other-user trees under
`~/.nassaj-users`. NOT synthetic fixtures (lesson 2026-06-28). Every caged argv
was produced by the shipped wiring code (`resolveCagedLaunch`), not hand-built,
so the spike exercises the exact path a live spawn would take with
`NASSAJ_PROVIDER_CAGE=true`.

Raw artifacts: `./2026-07-14-provider-cage-artifacts/`.
Environment: `00-environment.txt` (bwrap = codex-bundled musl build; claude
2.1.207, agy 1.1.1, opencode 1.17.18, hermes 0.17.0, gemini 1.1.1, codex
0.144.1; cursor-agent NOT installed).

Cage recipe under test = the current **denylist**: `--unshare-user
--unshare-pid --unshare-ipc --ro-bind / / --dev /dev --proc /proc --tmpfs /run
--tmpfs /tmp --tmpfs <usersRoot> --bind <usersRoot>/<uid> … --bind <cwd> …`.

## What passed (denylist holds these)

| Property | Result | Evidence |
|---|---|---|
| Other user's per-user credential hidden | BLOCKED | 01, 05 |
| `/run/docker.sock` hidden | BLOCKED | 01 |
| `/proc` host-pid escape (`--unshare-pid`) | SEALED — only cage pids visible; host pm2 pid absent | 02 |
| `/proc/1/root` → foreign cred / docker.sock | BLOCKED (same mount-ns overlays) | 02 |
| Caller's own tree re-exposed (rw) | OWN_OK | 01, 07 |
| `node` + `bash` boot in cage | OK | 01 |

The first probe's `LEAK_PROC1_ROOT` was a **mis-designed check**, not a leak:
inside `--unshare-pid`, `/proc/1` is the cage's own init, so `/proc/1/root/etc/
hostname` reads the cage-self (ro-bind) `/etc/hostname` — already world-readable.
The real escape targets via `/proc/1/root` (foreign cred, docker.sock) are
BLOCKED (artifact 02).

## Per-provider boot (inside the cage)

| Provider | Boots in cage? | Real turn / deeper | Gaps under denylist |
|---|---|---|---|
| **claude** 2.1.207 | YES (`--version`) | **Real `-p` turn OK** (stdout `OK`, exit 0, temp cwd) | (1) transcript **silently dropped** — shared store ro; (2) needs MCP → npx EROFS; (3) owner cred readable |
| **PTY** (bash) | YES (`node`/`bash` OK) | interactive shell runs caged | job-control not stress-tested; same shared-store ro for any tool run inside |
| **agy** 1.1.1 | YES (`--version`) | not turn-tested (quota) | shared **brain** ro → new agy memories would EROFS |
| **opencode** 1.17.18 | YES (`--version`) | not turn-tested | XDG data (own) rw OK; shared config ro (reads fine); DB writes land in own tree |
| **hermes** 0.17.0 | YES (`--version`, shows py env) | not turn-tested | **worst case**: `~/.hermes` fully shared + entirely ro → `state.db`/auth writes EROFS |
| **gemini** 1.1.1 | YES (`--version`) | not turn-tested | shared projects ro → transcript EROFS; own `GEMINI_CLI_HOME` rw OK |
| **cursor** | NOT INSTALLED on this node | — | wired, untestable here |
| codex | n/a — **exempt** (self-cages) | — | intentionally never wrapped |

MCP inside cage (claude's hard dependency): the configured **playwright** stdio
server (`npx @playwright/mcp@latest --browser chromium --headless`):
- under pure denylist → **FAILS** `EROFS` writing `~/.npm/_cacache` (artifact 03);
- with a writable `~/.npm` bind added → **BOOTS**, returns
  `serverInfo:{name:"Playwright",version:"1.62.0-…"}` to the `initialize`
  handshake (artifact 04).

## The denylist's two structural gaps (disk-proven)

### GAP 1 — operator/owner shared credentials stay READABLE (isolation hole)
`--ro-bind /` exposes the whole host read-only; the denylist only *hides*
`~/.nassaj-users/<other>`. Everything the operator keeps under `$HOME` outside
that subtree is still readable inside every cage (artifact 05):

```
READABLE  /home/nassaj/.claude/.credentials.json      (509 B)
READABLE  /home/nassaj/.codex/auth.json               (4120 B)
READABLE  /home/nassaj/.hermes/auth.json              (9698 B)
READABLE  /home/nassaj/.gemini/antigravity-cli/antigravity-oauth-token (506 B)
```

These are the **owner's live-subscription tokens** — precisely the secrets the
isolation initiative exists to protect. A prompt-injected turn in ANY caged
provider can still read them. The denylist is therefore **fail-open for the
highest-value secret class.**

### GAP 2 — shared write stores are READ-ONLY (silent functional regression)
`07-store-writability-matrix.log`:

```
WRITABLE  own-tree(rebound)                READ-ONLY claude shared transcripts
READ-ONLY gemini shared transcripts        READ-ONLY agy shared brain
READ-ONLY hermes state (fully shared)      READ-ONLY opencode shared config
READ-ONLY ~/.npm (MCP toolchain)           READ-ONLY ~/.cache (browsers/uv)
WRITABLE  /tmp
```

Confirmed live: the caged claude turn completed but **no transcript persisted**
to the shared store (`06`, and the store is writable only outside the cage). So
flipping the flag on as-is would silently stop persisting conversation history
for claude/gemini/agy and outright break hermes (its entire state dir is shared
and ro).

## Recommendation (reasoned, NOT implemented)

**A stricter allowlist IS required before go-live — the denylist is not
shippable.** Rationale: the denylist is simultaneously *fail-open* for operator
secrets (GAP 1) and *fail-broken* for shared writes (GAP 2). Both flow from its
"expose everything, subtract a little" shape.

Flip to "expose nothing, add exactly what a run needs":

1. **Read-only runtime allowlist:** `/usr /lib /lib64 /bin /sbin /etc/ssl
   /etc/resolv.conf /etc/passwd /etc/group` + the provider binary's own path
   (+ node/bun) — enough to boot, nothing of `$HOME`.
2. **Writable, per-run:** the caller's own `~/.nassaj-users/<uid>` tree, `cwd`,
   `/tmp` (tmpfs), and the **toolchain caches** `~/.npm` + `~/.cache` (proven
   necessary for MCP; ideally redirected per-user to keep them isolated too).
3. **Writable shared stores, bound explicitly:** `~/.claude/projects`,
   `~/.gemini/projects`, `~/.gemini/antigravity-cli/brain`, `~/.hermes`,
   opencode data — so history persists. These are shared BY DESIGN (ADR-023),
   so binding them rw is consistent with the model.
4. **NEVER bind the operator credential files** (`~/.claude/.credentials.json`,
   `~/.codex/auth.json`, `~/.hermes/auth.json`, agy token) for a NON-owner.
   Owner-reuse (ADR-023) needs a **per-user branch**: the owner's own launch
   binds their credential (it *is* the operator file via symlink); every other
   user's cage omits it. This is the "allowlist per launcher/user" the workshop
   anticipated — and it is the ONLY shape that closes GAP 1.
5. **codex stays exempt** (self-cages); **cursor** should be verified once a
   node has it installed.

Net: the wiring and the bwrap mechanism are sound (every provider boots caged,
isolation of per-user trees + docker.sock + `/proc` is real), but the **mount
policy must move denylist → allowlist** before the flag can be enabled in
production. Keep `NASSAJ_PROVIDER_CAGE` OFF until then.

## Still exposed / owner decisions

- **hermes** has no per-user credential knob at all (`~/.hermes` fully shared);
  even a correct allowlist can only share-or-hide it wholesale until hermes
  becomes multi-user. Owner call: share (bind rw) vs. block hermes under the cage.
- Per-user redirection of `~/.npm` / `~/.cache` (so caches don't leak across
  users) vs. sharing them rw — a cost/isolation trade for the allowlist design.
- Residual to GAP-1 even with the guard: a process as uid 0 or with a setfacl
  ACL on the socket bypasses the docker gid check (out of scope; T-896 guard
  note).
