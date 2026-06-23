# Upstream contribution roadmap — June 2026

> Reverse-contributing `nassaj-dev` features back to `siteboon/claudecodeui` (AGPL-3.0-or-later).
> Optimized for acceptance rate: cleanest/smallest first, ≤2 PRs/week, discuss-first for groups 2–4, controversial items as coordination issues (not PRs).
> Anchor date: **2026-06-04**. Upstream baseline: `upstream/main` @ v1.33.0 (`b988e0d`).
> `origin` = `Kindi-sa/nassaj-dev`, `upstream` = `siteboon/claudecodeui`. We contribute from a personal fork of upstream, not from `origin`.

---

## 1. Guiding principles (from CONTRIBUTING + legal review)

- **Discuss first for new features.** Bug fixes may go straight to PR. → Group 1 (fixes/UX) needs no prior discussion; groups 2–4 do.
- **One focused PR per feature.** Bundle only what is genuinely coupled; split everything else.
- **Conventional Commits, English.** Build must pass (`npm run build`). Include screenshots/recordings for UI, tests where applicable.
- **Additive / opt-in / flagged** for anything that could change default behavior. Default experience must stay identical.
- **No CLA/DCO.** License aligned (both AGPL-3.0-or-later).
- **Pacing for acceptance:** start with trust-builders (ready branches), drip 1–2 PRs/week, never flood, leave room for review cycles, expect the large/controversial items (multi-user, agy) to be **deferred or declined** → they stay in the fork regardless.

---

## 2. Dependency analysis (what is coupled vs independent)

Two dependency chains dominate the inventory; everything else is independent and shippable alone.

**Chain A — Auth/identity (sequential, group 4):**
```
multi-user auth (JWT/argon2/invites/bootstrap)
        │
        ▼
per-user credential isolation (resolveProviderEnv / provisionUserDirs)
        │
        ├──▶ provider sharing (admin isolate/share control)
        │
        ▼
session participants tracking (participants db/routes/UI)
user avatar  ── partially independent, but the *current-user* avatar leans on the user model
```
Participants and provider-sharing are meaningless without multi-user. This whole chain is **one product decision**; it cannot be merged piecemeal upstream without the base. → present as **coordination issue first**, never as a cold PR.

**Chain B — Antigravity provider (group 4):**
```
provider-models layer (registry abstraction)
        │
        ▼
AntigravityProvider (agy CLI: auth/sessions/synchronizer/mcp/skills)
        + graceful-disable when agy CLI absent
        + active-model read-only display
```
agy depends on a clean provider-registry seam. Upstream is actively refactoring providers (`refactor/providers`, `feature/unified-mcp-provider-logic` branches exist). → **coordinate against their providers layer first**; risk of churn is high.

**Independent units (no chain):** context-rot indicator + cache-aware tokens (ready), sidebar a11y (ready), WS/auth hardening, date separators, native-link context menu / open-in-new-tab, RTL+i18n, user avatar (generic part), Claude usage panel.

---

## 3. PR unit table

| # | Unit | Contents | Depends on | Accept | Readiness | Size |
|---|------|----------|-----------|--------|-----------|------|
| P1 | **Sidebar action a11y** | keyboard support + larger hit targets on project/session actions (`SidebarProjectItem.tsx`). Branch `contrib/sidebar-star-a11y` (88a4c42) | — | **High** | **Ready** | XS (1 file, ~13 lines) |
| P2 | **WS/auth hardening** | writer-swap race guard, WS keepalive, AuthContext logout-loop/login-recheck hardening (56d67f3, 872dfda). Pure bug-fix, no behavior change | — | **High** | Needs cherry-pick + isolate | S–M |
| P3 | **Sidebar native links / open-in-new-tab** | real `<a>` session links → native context menu + open-in-new-tab (0cabf4a, 70927d7) | — | **High** | Needs cherry-pick | S |
| P4 | **Context-rot indicator + cache-aware tokens** | colored context-fill bar in `TokenUsageSummary`, token accounting incl. cache_read/cache_creation, context-window inference from model. Branch `contrib/context-rot-indicator` (7bcfb58), i18n already wired (`en/chat.json`) | — | **Med-High** | **Ready** (opt-in framing) | M (5 files, ~257 lines) |
| P5 | **Date separators** | day-boundary separators in message list (056276e, `DateSeparator.tsx`) | — | **Med-High** | **Needs i18n** — extract Arabic strings to locale before PR | S |
| P6 | **User avatar (generic)** | shared avatar for current-user messages (5db3974), decoupled from multi-user model | weak → identity | **Med** | Needs decoupling from user table | S |
| P7 | **Claude account usage panel** | OAuth usage endpoint + UI panel (dd15e79) | — (standalone) | **Med** | Needs review of auth/secret surface; opt-in | M |
| **G-RTL** | **RTL + Arabic i18n** | document `dir` driven by locale + Arabic locale as additional translation (subset of 1fa4098/43a140f) | i18n infra (exists upstream) | **Med** | Needs clean extraction from agy/MU commits; additive only | M (touches many UI files) |
| ~~**I-MU**~~ | ~~**Multi-user auth chain**~~ — **WITHDRAWN, fork-only (2026-06-05)** | identity cluster (multi-user auth → credential isolation → provider sharing → participants → current-user avatar) | Chain A | — | **Pulled from contribution** | — |
| **I-AGY** | **Antigravity provider** (issue, not PR) | agy CLI provider via registry + graceful-disable + read-only active model | Chain B (provider-models) | **Low** | **Discussion-first**; coordinate vs their providers refactor | XL |

**Withdrawn from contribution — fork-only (owner decision 2026-06-05):** the whole **identity cluster** (I-MU: multi-user auth + per-user credential isolation + provider-sharing + session-participants tracking) is **permanently pulled** from the upstream contribution and stays fork-only. Two reasons:
- **Technical:** we disabled credential isolation ourselves — all providers run on `shared` (see memory `project_nassaj_dev`). Contributing a feature we ourselves turned off is poor judgment.
- **Commercial (source-confirmed):** siteboon's paid product is **CloudCLI Cloud** (`cloudcli.ai`, priced per environment). The OSS edition is **single-user by an explicit lock** (`server/routes/auth.js`: "User already exists. This is a single-user system."), and **"Team sharing" is Cloud-exclusive** (upstream README table). Our identity cluster **removes the single-user lock that drives upgrades** → direct commercial friction that would weaken acceptance of our other contributions.

Excluded (already upstream or not ours): #594 plugin frame-type, sidebar collapse, OpenCode/Codex/Cursor providers.

---

## 4. June 2026 weekly batch schedule

Opening discussion goes out at the **start of the month** before any group 2–4 work. Group 1 (fixes/a11y) proceeds in parallel without waiting on it.

| Date | Batch | Action |
|------|-------|--------|
| **Thu 2026-06-05** | **B0 — Open discussion** | Post the prepared discussion (`discussion-draft.md`) to upstream Discussions/issue. Same day: open **P1** (a11y, ready branch) as the first trust-builder PR — it's a pure fix, needs no discussion gate. |
| **Mon 2026-06-08** | **B1 — Fixes wave** | Open **P2** (WS/auth hardening). Pure bug-fix, high accept. Begin responding to any B0 discussion replies. |
| **Thu 2026-06-11** | **B1 cont.** | Open **P3** (native links / open-in-new-tab). Keeps the 1–2/week cadence. React to P1/P2 review comments. |
| **Mon 2026-06-15** | **B2 — Opt-in feature** | Open **P4** (context-rot + cache-aware tokens, ready branch) **only if** B0 gave a positive/neutral signal on group 2. Framed strictly opt-in. |
| **Thu 2026-06-18** | **B2 cont.** | Open **P5** (date separators) after the i18n string extraction is done. Small, low-risk. |
| **Mon 2026-06-22** | **B3 — i18n** | If B0 welcomed group 3: open **G-RTL** (RTL + Arabic locale) as a single additive PR. Open **P6** (generic avatar) alongside only if review bandwidth allows; else slip to 06-25. |
| **Thu 2026-06-25** | **B3 cont. / catch-up** | Open **P7** (Claude usage panel) if group-2 signal was good and reviewers aren't saturated. Otherwise reserve this slot for addressing open-PR review feedback — **do not** open new PRs if 3+ are still in review. |
| **Mon 2026-06-29** | **B4 — Coordinate the big one** | File **I-AGY** only as an **optional coordination issue** (design + flag strategy + questions), explicitly *not* a PR. Implementation, if welcomed, spills past June. **I-MU is no longer filed** — the identity cluster is withdrawn (fork-only, 2026-06-05). |
| **Tue 2026-06-30** | **Month close** | Triage: merged / changes-requested / stalled. Anything declined stays in fork. Re-plan July for accepted-but-unmerged items. |

Throughput: ~7 PRs + 1 discussion + 1 optional issue (I-AGY) across the month, max 2 PRs open in a single week — well under flood threshold, with explicit catch-up slots (06-25) reserved for review cycles. (I-MU dropped: identity cluster withdrawn 2026-06-05.)

---

## 5. Governing risks, dependencies, and fallbacks

| Risk / dependency | Impact | Mitigation / fallback |
|---|---|---|
| **Upstream providers refactor in flight** (`refactor/providers`, `feature/unified-mcp-provider-logic`) | agy (I-AGY) and any provider-touching PR may rot or conflict | Hold I-AGY as issue-only until their refactor lands; rebase against the *new* provider seam. Fallback: keep agy fork-only indefinitely (graceful-disable means zero upstream-user impact anyway). |
| **Group 4 declined** (multi-user / agy out of scope) | XL features rejected | Expected outcome. They remain in `nassaj-dev`. No code wasted because we gate on discussion before writing PR-grade code. |
| **i18n extraction debt** (P5, G-RTL ship Arabic literals) | PR bounced for hardcoded strings | Block P5/G-RTL until strings are moved to `src/i18n/locales`. P4 already clean (i18n wired). |
| **Reviewer saturation** | Too many open PRs → slow/negative reviews | Hard cap 2 open PRs/week; 06-25 is a no-new-PR catch-up slot; never open a feature PR while its discussion gate is unanswered. |
| **Identity coupling leaks into "independent" units** (P6 avatar, P7 usage panel) | Hidden dependency on multi-user model | Decouple before PR: P6 must use a generic avatar source; P7 must work in single-user/default auth. If decoupling proves infeasible, fold them into I-MU and drop from June. |
| **Discussion gets no maintainer response by 06-12** | Groups 2–4 blocked | Proceed only with group 1 (P1–P3, bug-fixes — no gate). Hold P4+ until a signal arrives; slide the schedule right rather than force ungated feature PRs. |
| **Ready branches built on our fork base, not upstream** | Merge conflicts on PR | Both ready branches already diff cleanly vs `upstream/main` (verified: P1 1 file, P4 5 files). Open PRs from a fresh fork-of-upstream branch cherry-picking the single commit. |

---

## 6. Acceptance-rate notes

- **Lead with the two ready, verified-clean branches** (P1 then P4 region) to build maintainer trust before asking for scope decisions.
- **Bug-fixes need no permission** — front-load P1/P2/P3 to establish a track record while the discussion matures.
- **Frame every group-2+ item as opt-in/additive** in the PR description, with a one-line "default behavior unchanged" guarantee and a screenshot.
- **One feature per PR, always** — resist bundling date-separators with avatar, or RTL with i18n-infra changes.
- **Treat XL items as conversations, not deliverables** — issues with design + flag plan + explicit questions; accept that they likely stay downstream.
- **Reserve bandwidth for reviews** — a merged small PR beats three stalled large ones; the 06-25 catch-up slot is non-negotiable if PRs pile up.
- **Withdrawing commercially-conflicting features raises acceptance and protects the maintainer relationship** — pulling the identity cluster (which removes upstream's single-user lock / Cloud "Team sharing" upsell) signals we respect their business model, making our remaining contributions easier to accept.
