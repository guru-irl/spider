# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary: developers who run pi with spider on GitHub Copilot, usually several sessions at once, each launching subagents (workers, reviewers, scouts).
- The project owner is the first such user. Other spider users have the same job with different models, projects and budgets.
- They open the dashboard once or twice a day, when a session feels expensive, and near the end of a billing month.
- Their job: see where their credits went, cut spend that is not worth it, and pace the month against their allowance or their own budget.

## Product Purpose

- A local page, opened from pi with `/usage`, that explains Copilot spend in human terms: which days, which models, which sessions, and inside a session which parts (the session itself, each subagent run, compaction, background work).
- Success: within a minute of opening it, the user knows whether they are on pace for the month and which one or two things cost the most.

## Positioning

- Copilot's own usage views report account totals. This dashboard attributes every model call to the pi session, subagent run, role and model that made it, because spider records those runs itself.
- Its credit figures are corrected against the account's own usage counter, so they track what billing reports rather than published list rates.

## Operating Context

- Opened from an interactive pi session with `/usage`. It runs on the user's own machine and is served only to that machine.
- Data comes from a local ledger that pi sessions fill in as they work. The page refreshes about once a minute while visible.
- Typical questions: "Am I on pace this month?", "What cost the most this week?", "Why was this session expensive?", "Which model is eating my credits?".

## Capabilities and Constraints

- Terminology:
  - **Credits**: the billing-corrected credit figure. Always the corrected value; the UI does not label figures as calibrated or estimated.
  - **Tokens**: raw token counts (prompt, output, cache read, cache write, reasoning).
  - **Session**: a top-level pi session. Its totals include the subagent runs it launched.
  - **Subagent run**: one subagent launched from a session, with a role such as worker, reviewer or scout.
  - **Allowance**: the monthly credit allowance the account reports. **Budget**: an optional monthly limit the user sets.
- Credits are the default unit; a switch shows tokens instead.
- The default range is the last 7 days up to now; other ranges come from date and time filters.
- Pacing compares spend with the account allowance and, when set, the user's own budget, with a projected month-end figure.
- The correction method (published rates, counter reconciliation) and ingestion health are available on a separate page for users who want to check the numbers.
- Local and read-only: the page never changes usage data, accounts or settings.
- Works offline. Web fonts may load from the network when available, but nothing depends on them.
- No front-end framework or chart library; charts are hand-built.
- Interactive pi sessions only; `/usage` does not run in print or RPC mode.
- Desktop browsers only. Phone layouts are not a goal; narrow windows may scroll.

## Brand Commitments

- Dark mode (user-pinned).
- Cascadia Code for numbers, ids, times and other machine values (user-pinned). Fira Sans for the rest of the UI (user-chosen).
- The mark is spider's web glyph (the one spider prints as 🕸), drawn as a monochrome icon beside the name "Spider".
- Voice: plain, neutral and concise. No hype, filler praise or dramatic wording.
- Spider is a public open-source project: no user paths, account details or real usage figures in shipped copy, docs or fixtures.

## Evidence on Hand

- Real data exists only on each user's machine: the per-call ledger, counter snapshots and the rate table. Public docs, tests and screenshots use synthetic data.
- Not captured yet: what a prompt is made of (rules, memory, skills, history, files, tool results). The design must not imply that breakdown exists.
- Some compaction calls have no model attribution, and periods before the counter was first polled have no reconciliation data. Show these gaps plainly; never fill them with invented values.

## Product Principles

- Lead with what the user can act on: pace for the month, and the biggest costs by day, model and session.
- One trustworthy number: credits are corrected silently, and the method lives on its own page instead of in labels.
- Rank by cost, not volume. Token counts are one switch away.
- Every drill-down keeps its context: opening a session shows that session over its own time range, never an empty page for a valid id.
- Private by construction: local, read-only, and nothing leaves the machine.

## Accessibility & Inclusion

- Fully keyboard operable, with visible focus.
- Text meets WCAG AA contrast.
- Every chart has an equivalent table.
