# T-898 — provider-cage forgery closure (symlink-forged credential entitlement)

**Date:** 2026-07-15 · **Branch:** `fix/security-remediation-2026-07-09` · **Flag:** `NASSAJ_PROVIDER_CAGE` (default **OFF** — off path byte-identical, zero change).

Closes the **critical** vulnerability the second qa-critic pass proved on disk that the T-898 hardening (`commit 639791e3`) itself introduced in the credential **entitlement** logic of `cageMountPlan` (`server/services/isolation/provider-cage-wiring.js`).

## The vulnerability (was disk-PoC-proven readable)

The per-user tree `~/.nassaj-users/<uid>` is bind-mounted **read-write** inside the cage. The old plan waived the credential mask for the launching provider's OWN credential when an on-disk **owner-reuse symlink** (`~/.nassaj-users/<uid>/.claude/.credentials.json → ~/.claude/.credentials.json`) resolved (by realpath equality) to the operator file. That check read a surface the cage can WRITE:

1. A prompt-injected caged (isolated) session deletes its own `.credentials.json` and plants that exact symlink.
2. The next launch's fresh `cageMountPlan` sees the realpath equality, moves the operator credential from `maskFiles` (`--ro-bind /dev/null`) into `writePaths` (`--bind` rw).
3. The **live** shared operator credential is now readable **and writable** in-cage — qa-critic extracted 509 B of OAuth = re-opened GAP 1, plus a rotate/corrupt primitive on the fleet-shared credential (fleet-wide auth-denial).

**Root cause:** entitlement / rw-bind state was derived from a disk surface (a symlink) the adversary writes from inside the cage.

## The fix

`cageMountPlan` rewritten so the shared-credential mask set is **authoritative by realpath** and is only ever waived for the launching provider's OWN credential in **admin-policy SHARED mode** — a sharing-DB decision (`isProviderIsolated`), never on-disk state. The isolated owner-reuse-symlink exemption is **removed**. An isolated user's own credential lives INSIDE its per-user tree (real path a strict descendant of `~/.nassaj-users/<id>`) and stays writable through the existing per-user tree rebind, so legitimate function is untouched. Defense-in-depth in `buildCagedLaunch`: a path that is also in `maskFiles` is never emitted as a rw `--bind` (masks still mount LAST regardless).

Live-deployment note: on this node users 2 (owner) and 3 both currently hold **real** in-tree credentials (600 B / 551 B), not owner-reuse symlinks, so the shipped plan already masked the operator file for them — this fix changes behavior only for the forgery/owner-reuse-symlink case (now always masked). The isolated owner-reuse convenience (run on the shared operator credential via a symlink) is intentionally gone; an isolated owner runs on their own per-user credential (`claude login` once) — the more secure model.

## Evidence (real bwrap, real operator $HOME — see ./2026-07-15-provider-cage-forgery-closure-artifacts/01-forgery-blocked.log.txt)

argv derived from the shipped `resolveCagedLaunch` (not hand-built); only the sharing policy is injected (isolated). Throwaway trees cleaned up after (B-28/B-29); no `claude` spawned (only `sh` in-cage), so no visible session.

| Probe (in-cage, forged symlink → operator credential) | Result |
|---|---|
| Host operator credential size (no cage) | **509 bytes** (the secret qa-critic exfiltrated) |
| argv masks operator realpath (`--ro-bind /dev/null`) | **true** |
| argv rw-binds operator realpath (`--bind`, the leak) | **false** |
| `stat -L` dereferenced size via the forgery | **0** |
| open-for-read via the forgery | **`Permission denied`** |
| credential CONTENT bytes actually readable | **0** |
| **Verdict** | **BLOCKED** — the 509-byte OAuth is gone |

Function preserved (control, same run): a user's OWN real in-tree credential (`~/.nassaj-users/<id>/.claude/.credentials.json`, realpath inside the tree) reads back `LEGIT_USER_CRED_TOKEN_OK` and an in-cage append lands on the host disk (writable).

## Tests

- `provider-cage-wiring.test.ts`: the old owner-reuse "exempt + rw" test is replaced by a **forgery-closure** test (operator credential STAYS masked, never rw despite the planted-symlink realpath seam) + an argv-level assertion (operator credential appears ONLY as `--ro-bind /dev/null`, in no `--bind`). Flag-OFF byte-identical test strengthened to assert zero `homedir`/`realpath`/`existsSync`/policy calls and same cmd/args references.
- `provider-cage.test.ts`: unchanged; the builder-level mask-wins-over-writePaths guard is a no-op for its non-overlapping fixtures.
- `docker-sock-boot-guard.test.ts`: added an explicit `getgroups: undefined` fail-closed case (see the secondary note below).

Isolation suite: **209 pass / 0 fail** (176 `*.test.ts` + 33 `*.test.js`), up from 207 (+2 net). `npx tsc` clean; `npm run build:server` green.

## Secondary (qa-critic note, not a vuln): docker-sock-boot-guard testability

`enforceDockerSockBootGuard` no longer defaults `getgroups`/`getgid`/`getegid` to the live functions in the parameter list; it resolves them to `process.*` **only when the key is OMITTED** (`'getgroups' in deps`). An explicitly-passed `undefined` is now honored as "no getgroups" (previously it silently reverted to the real function, so only `null` could simulate absence). Fail-closed behavior is unchanged — a non-function still yields `null` → refuse to boot.
