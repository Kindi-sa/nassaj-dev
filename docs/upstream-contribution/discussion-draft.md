# Upstreaming features from a downstream fork — which areas fit your scope?

> **Status: DRAFT for internal review. Not yet posted to upstream.**

## Hello, and thanks for Claude Code UI

First, thank you for building and maintaining this project. We (a small team at AlKindy) have been running a private fork based on **v1.33.0** for several months. Over that time we added a handful of features and fixes on top of it, and we'd like to start contributing some of them back upstream.

To be clear up front: we don't claim the project, and we have no expectation that everything we built belongs in core. We fully respect that you have a vision and a scope for this project, and that some of our additions are downstream-specific by nature. Both projects are AGPL-3.0-or-later, so licensing is aligned.

Per `CONTRIBUTING.md` ("discuss first for new features"), we're opening this to **ask about scope before we invest effort in PRs**: which of the groups below are welcome, and how would you prefer to receive them?

## What we'd propose, roughly by likelihood of fit

These are **suggestions, not a roadmap we're imposing**. We've ordered them from "should be easy to accept" to "changes scope, needs your call first."

### 1. Fixes and small UX / accessibility improvements
Self-contained, low-risk, no behavior change for existing users. We can open these as separate, focused PRs right away:

- WebSocket and auth hardening (reconnection / edge-case handling).
- Sidebar accessibility improvements (keyboard / ARIA).
- Date separators in the message list.
- Minor avatar handling.

### 2. Opt-in, medium-sized features
Useful but additive — proposed as **opt-in so the default experience is unchanged**:

- A context-rot indicator in the UI.
- Token accounting that includes cache usage (`input + cache_read + cache_creation`) rather than input alone.
- Context-window inference from the active model (e.g. Opus / Sonnet 4.6+ → 1M).

### 3. Internationalization
Aimed at being purely additive — **no forced change to the current LTR layout**:

- RTL support (document direction driven by locale).
- An Arabic locale as an additional translation.

### 4. Larger, scope-changing features — we'd want your opinion first
These touch architecture and product scope, so we'd rather hear your direction **before** writing any code. We'd design them **behind flags, with the current single-user / default behavior preserved**:

- Multi-user authentication (behind a flag; default remains single-user).
- Per-user credential isolation.
- Provider sharing between users.
- Antigravity (the `agy` CLI) provider integration, added via a **provider registry**, with **graceful disable** when the `agy` CLI isn't installed — so it never breaks users who don't have it.

## Questions for the maintainers

1. Which of the four groups above are welcome in principle?
2. Do you prefer a **separate issue per feature** before each PR, or is this discussion enough to proceed on group 1?
3. Are there architectural guidelines or constraints we should follow — **especially around the providers layer** — so our work lands in a way that fits your design?

## How we'd contribute

- **One focused PR per feature**, small and reviewable.
- **Conventional Commits**, in English.
- Tests and documentation for each change.
- **opt-in / flagged** for anything that could alter default behavior.
- Ongoing maintenance of what we upstream — we're not looking to drop code and walk away.

Happy to adjust any of this to your preferences. Thanks for considering it.
