# Usage dashboard

Run `/usage` in an interactive parent pi session to open the local dashboard. It shows a read-only view of usage collected on this machine. Child sessions and print, JSON or RPC modes cannot open it.

The dashboard has three pages: Overview, Session, and Calibration & data. It is designed for desktop browsers in dark mode. Local fonts are tried first, and system fonts work offline. Optional font downloads do not send usage data.

## Overview

Overview opens with the last 7 days and Credits selected. Choose 24 h, 7 days, 30 days, This month, or a Custom range. Custom date and time inputs use your browser's time zone and accept up to 93 days. Ranges up to 48 hours use hourly buckets; longer ranges use daily buckets.

- The pace bar shows credits used in the current billing month and the projected month-end amount. It turns red only when used or projected credits exceed the budget, or the allowance when no budget is set. Hover or focus it to see used, allowance, remaining credits, days left, and budget details when a budget is set. Escape closes the popover.
- Daily or hourly usage is stacked by model. The Models panel ranks models by usage and identifies their main source. A long model list scrolls inside its panel.
- Sessions ranks top-level pi sessions. Each total includes the session's own calls, its compaction and background work, and its subagent runs. Role segments separate own calls, workers, reviewers and others; a run's role comes from its agent type, such as worker or reviewer. Sort by credits, last active or runs. The list scrolls and loads more sessions as you reach its end.
- Where it went shows roles flowing to models. Hover or focus a band or node to see its credits or tokens, share and calls; Escape hides the detail. Beyond seven models, the smallest are grouped into one node, and the table lists every model. Empty roles are omitted. Partly priced groups show their priced credits and the number of unpriced calls.

The Credits | Tokens switch changes charts and tables. The pace bar always uses credits. Every chart has a Chart | Table control showing the same values.

Cmd-click a bucket on macOS, or Ctrl-click elsewhere, to toggle its selection. Selected buckets need not be adjacent. Models, sessions and the flow follow the selection; the range total and monthly pace do not change. Use arrow keys to move between buckets and Cmd/Ctrl+Enter or Space to toggle one. Escape, or a click outside the bars and controls, clears the selection.

The URL keeps the Overview range, unit and selected buckets. Reload, Back and Forward restore that view. If a rolling range moves past a selected bucket, that bucket is removed from the selection.

## Session

Click a session row or press Enter to open it. Session opens on the current billing month, or on the calendar month of the session's last activity if it had none this month, and does not follow the range selected on Overview. From and To open a calendar for choosing other days; This month and Whole session switch quickly. Days use your browser's time zone. The URL keeps the range, so Reload, Back and Forward restore it. The unit carries over.

The header shows the session name, project, the selected range and the totals for that range. A transit chart covers the activity inside the range. It places own calls on a baseline and subagent runs on branches. Long idle stretches collapse into breaks. Run marks distinguish completed, cancelled, failed and running work; unavailable status is not guessed. Hover or focus a branch for its details, click or press Enter to pin it, and press Escape to clear it. The runs table scrolls and shows each run's role, and the runs and models tables provide the same usage evidence. The flow reconciles with the session total.

A session without subagent runs shows only its baseline. A known session without calls keeps its header and an empty state. An unknown id shows Session not found with Back, not a retry loop. Back returns through dashboard history or to your remembered Overview.

Session names come from the latest `/name`, otherwise the first line of the first user message written in that session (not one copied from a fork), otherwise a short id. Names are bounded and redacted. Projects are displayed as names, not paths. Runs whose owning session cannot be resolved appear together as Unattributed runs.

## Credits, tokens and pace

Credits use published rates corrected against compatible account-counter evidence. When no factor is available, published rates are used. During a counter outage, credits retain the last accepted factor where available. The correction basis and coverage belong on Calibration & data, not beside every credit figure.

The 2026-10-04 published rate snapshot is applied from June 1, 2026, when GitHub changed Copilot to usage-based billing. These historical prices are estimates, not evidence that every rate was unchanged throughout that period. Calls before June 1 remain unpriced.

[Managed compaction](compaction.md#managed-parent-summaries) records its summary model for pricing. Compaction and branch summaries with a recorded model use that model's published rates. Without a model, they use pi's recorded cost when the active provider is GitHub Copilot, or when it is unknown and all attributed session calls use Copilot (at least one is required). Summaries before the earliest rate date stay unpriced, as do model-less summaries with zero recorded cost for nonzero tokens.

Token totals are input plus cache read plus cache write plus output. Reasoning and one-hour cache writes are subsets, not additional tokens. Unknown pricing stays unavailable rather than becoming zero. A total with unpriced calls does not include a fabricated price for those calls.

The billing month ends at the account counter's reset date in UTC. Without usable counter evidence, it follows the UTC calendar month. Used comes from the account counter when there is a valid observation in the period, otherwise from pi's corrected month-to-date usage. The account counter includes usage outside pi and on other machines.

Projection uses the average daily rate over the last 7 days, or since the billing month began when shorter. It uses compatible counter deltas when they cover that window, otherwise corrected pi usage. Sparse snapshots, account changes and resets can prevent a counter-based rate. These figures help with pacing; they are not an exact bill.

## Monthly budget

`usage.monthlyBudget` is optional and unset by default. It must be a finite positive number of credits per billing month. Set it in spider's global configuration screen or with:

```text
/spider config set usage.monthlyBudget <credits> --global
```

Remove it with:

```text
/spider config unset usage.monthlyBudget --global
```

Changes apply live. The dashboard does not edit settings. With a budget, the pace bar scales to it and the popover includes even pace and any projected excess. Without a budget, the bar uses the account allowance. With neither a budget nor an allowance, it shows used without inventing a proportional fill.

All usage settings are global-only. `usage.footer` enables the terminal footer, `usage.counter.poll` controls parent-only account polling, and `usage.calibration` selects `auto` or `off`. Changes apply live. To use published rates only:

```text
/spider config set usage.calibration off --global
```

Restore automatic correction with `/spider config unset usage.calibration --global`. Session and run alert thresholds are reserved settings; alerts are not implemented.

## Calibration & data

This page explains the numbers and collection health. Times and buckets here are UTC.

- Correction shows the factor, published estimate and account-counter delta for matching accepted intervals, covered hours, and the correction status. Daily counter gaps stay empty rather than being filled with zero. Counter intervals are observed spans, not precisely apportioned calendar-day billing.
- Rates lists published credits per million tokens for input, cache read, cache write and output, including tiers and source dates. Unpriced models have call counts and reasons.
- Ingestion shows the collector, last ingest, files tracked, calls today and error count. The collector can be this pi session, another pi session, the dashboard server, or none. Errors use redacted labels. Gaps include unpriced calls, compaction without model attribution and days without counter data.

The freshness dot turns grey after five minutes without an ingest. Visible pages refresh periodically, and you can refresh manually. Network or server errors settle to an error with Retry rather than leaving a spinner. If access expires or the server stops, run `/usage` again.

## Terminal footer

The parent TUI footer keeps context percentage and window first, followed by session credits, the latest assistant prompt cache-hit rate (`CH`), `month`, input/output tokens and cache read/write tokens. Items are separated by middle dots. It shows credits without pricing-basis markers. `month` is a whole percentage of your budget when set, otherwise of the allowance. If neither is available, the `month` item is left out.

The format is `context%/window · credits · CH% · month % · ↑input ↓output · Rread Wwrite`.

The working directory, branch and session name stay on the first row; extension statuses appear when present. Lower-priority usage items disappear first in narrow panes. Token totals follow pi's all-entry session history, including copied fork history, compaction and asynchronously appended usage. Rendering uses cached values rather than opening the ledger. Turning `usage.footer` off restores pi's built-in footer without changing the agents widget.

## Collection, privacy and diagnostics

A background worker discovers pi session history and registered subagent transcripts, resumes saved offsets and records usage in a separate local ledger. Billing and metadata backfills run in bounded passes without blocking pi. Metadata visits the newest source modification times first, with paths breaking ties. While metadata or re-pricing is incomplete, the ingest owner runs another bounded pass after about three seconds, including billing ingestion on every pass. After completion it returns to the normal one-minute cadence. Each metadata pass reads at most 32 MiB; losing the lease stops writes. Malformed lines and missing sources are recorded as diagnostics. Children never poll the account counter. A fenced lease allows one parent to poll while other sessions consume published snapshots.

Counter polling is an authenticated read-only request using pi's stored Copilot credential. Missing fields or request failures produce no observation, not a zero balance. The dashboard server never polls the account or reads authentication. Its ingestion participant releases the lease between passes.

The server binds only to loopback. A single-use bootstrap code exchanges for an HttpOnly, SameSite=Strict cookie before assets load. Bootstrap codes can be visible to other local processes, and loopback cookies are not port-scoped. Treat other local processes as part of the trust boundary. Restarting the server invalidates browser sessions. Inactive servers stop automatically.

Usage records, transcript bodies and credentials are not uploaded by the dashboard. `/doctor` reads published worker diagnostics, including backfill progress, counter availability, unpriced usage and sanitized errors. Unpriced diagnostics cover the current billing period and count calls without a model separately. On the first run after upgrading, or when the pricing fingerprint changes, the ingest owner revisits stored unpriced detail and model-less compaction calls in resumable batches of at most 2,000 calls. Historical compaction calls use pi's recorded cost only when stored session evidence attributes them to GitHub Copilot; run reports are not re-priced. Restart every running session after upgrading so an older build does not keep ingesting with the old pricing policy. Already-priced calls and calls that still cannot be priced keep their stored values and reasons. `/doctor` shows `usage reprice=running 2000/5000 calls` while this runs, then `usage reprice=complete`. Pricing updates invalidate calibration, corrected totals and cached footer month values. A worker failure or unsupported ledger does not disable cached terminal totals.

The ledger v5 upgrade changes the layout and is one-way: earlier spider builds cannot open the ledger after the upgrade. Restart every session after upgrading. The ledger lives at `~/.pi/agent/spider/usage.db` by default, or `usage.db` under `SPIDER_GLOBAL_ROOT` when set. Back it up before upgrading. An open dashboard on the current build picks up the upgraded ledger on its next refresh. Prompt composition analysis and alerts are not available. POSIX hosts are supported; Windows hosts are not.

## Contributing to the dashboard

For UI work, run `npm run dev:dashboard`. It serves synthetic fixture data and a development-only states page. It does not read your usage ledger or settings.

To check against real data, run `npm run build:dashboard` and restart the dashboard server. The server loads packaged browser assets once at startup, so a rebuild alone does not replace an open server's page. There is no `/usage` stop or restart subcommand. Close the dashboard tabs and wait for the 30-minute idle timeout, then run `/usage`. To stop it now, identify the process listening on the dashboard URL's port and compare its PID with `usage-server/lock.json` under spider's global data directory. Send that confirmed server process SIGTERM with `kill -TERM <pid>`, then run `/usage`. Do not signal an unverified PID from an old lock file. Alternatively, run the full `npm run build`, reload pi, then run `/usage`; the new extension build starts a fresh server. Extension watch does not rebuild browser assets. `npm run build` builds the extension, builds the dashboard and checks the packaged output.
