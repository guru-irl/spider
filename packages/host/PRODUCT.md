# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary: developers who run pi with spider on GitHub Copilot. They usually run several sessions at once, each launching subagents (workers, reviewers, scouts).
- The project owner is the first such user. Other spider users have the same job with different models, projects and budgets.
- They open the dashboard once or twice a day, when a session feels expensive, and near the end of a billing month.
- Their job is to see where their credits went, cut spend that is not worth it, and pace the month against their allowance or their own budget.

## Product Purpose

- A local page, opened from pi with `/usage`, that explains Copilot spend in plain terms. It shows which days, which models and which sessions cost what. Inside a session it shows which parts cost what (the session itself, each subagent run, compaction, background work).
- Success means that within a minute of opening the page, the user knows whether they are on pace for the month and which one or two things cost the most.

## Positioning

- Copilot's own usage views report account totals. This dashboard attributes every model call to the pi session, subagent run, role and model that made it, because spider records those runs itself.
- Spider corrects its credit figures against the account's own usage counter. The figures therefore track what billing reports, not the published list rates.

## Operating Context

- The user opens it from an interactive pi session with `/usage`. It runs on the user's own machine and serves only that machine.
- The data comes from a local ledger that pi sessions fill in as they work. While the page is visible, it refreshes about once a minute.
- Typical questions: "Am I on pace this month?", "What cost the most this week?", "Why was this session expensive?", "Which model is eating my credits?".

## Capabilities and Constraints

- Terminology:
  - **Credits**: the billing-corrected credit figure. It is always the corrected value. The UI does not label figures as calibrated or estimated.
  - **Tokens**: raw token counts (prompt, output, cache read, cache write, reasoning).
  - **Session**: a top-level pi session. Its totals include the subagent runs it launched.
  - **Subagent run**: one subagent launched from a session, with a role such as worker, reviewer or scout.
  - **Allowance**: the monthly credit allowance the account reports. **Budget**: an optional monthly limit the user sets.
- Credits are the default unit. A switch shows tokens instead.
- The default range is the last 7 days up to now. Date and time filters set other ranges.
- Pacing compares spend with the account allowance and with the user's own budget if one is set. It also shows a projected month-end figure.
- A separate page shows the correction method (published rates, counter reconciliation) and ingestion health, for users who want to check the numbers.
- The page is local and read-only. It never changes usage data, accounts or settings.
- It works offline. Web fonts may load from the network when available, but nothing depends on them.
- It uses no front-end framework or chart library. The charts are hand-built.
- It works in interactive pi sessions only. `/usage` does not run in print or RPC mode.
- It supports desktop browsers only. Phone layouts are not a goal, and narrow windows may scroll.

## Brand Commitments

- Dark mode (user-pinned).
- Cascadia Code for numbers, ids, times and other machine values (user-pinned). Fira Sans for the rest of the UI (user-chosen).
- The mark is spider's web glyph (the one spider prints as 🕸), drawn as a monochrome icon next to the name "Spider".
- Voice: plain, neutral and concise. No hype, filler praise or dramatic wording.
- Spider is a public open-source project. Shipped copy, docs and fixtures contain no user paths, account details or real usage figures.

## Evidence on Hand

- Real data exists only on each user's machine. It is the per-call ledger, the counter snapshots and the rate table. Public docs, tests and screenshots use synthetic data.
- Spider does not yet capture what a prompt is made of (rules, memory, skills, history, files, tool results). The design must not imply that this breakdown exists.
- Some compaction calls have no model attribution. Periods before the first poll of the counter have no reconciliation data. Show these gaps plainly, and never fill them with invented values.

## Product Principles

- Lead with what the user can act on: pace for the month, and the biggest costs by day, model and session.
- Show one number the user can trust. Spider corrects credits without saying so in labels, and the method has its own page.
- Rank by cost, not volume. Token counts are one switch away.
- Every drill-down keeps its context. Opening a session shows that session over its own time range, never an empty page for a valid id.
- Private by design. The page is local and read-only, and nothing leaves the machine.

## Accessibility & Inclusion

- Every control works from the keyboard, with visible focus.
- Text meets WCAG AA contrast.
- Every chart has a table that shows the same data.
