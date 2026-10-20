# Usage dashboard

Run `/usage` in an interactive parent pi session to open the local dashboard. It is a read-only view of the usage collected on this machine. Child sessions cannot open it, and neither can print, JSON or RPC modes.

The dashboard has three pages: Overview, Session, and Calibration & data. It is built for desktop browsers in dark mode. It tries local fonts first, and system fonts work offline. Optional font downloads do not send usage data.

## Overview

Overview opens with the last 7 days and Credits selected. You can pick 24 h, 7 days, 30 days, This month, or a Custom range. The custom date and time inputs use your browser's time zone and accept up to 93 days. Ranges of up to 48 hours use hourly buckets, and longer ranges use daily buckets.

- The pace bar shows the credits used in the current billing month and the projected amount at month end. It turns red only when the used or projected credits go over the budget, or over the allowance if no budget is set. Hover over it or focus it to see the used credits, the allowance, the remaining credits, the days left, and budget details if a budget is set. Escape closes the popover.
- The daily or hourly usage chart is stacked by model. The Models panel ranks models by usage and shows where most of each model's usage came from. A long model list scrolls inside its panel.
- Sessions ranks top-level pi sessions. Each total covers the session's own calls, its compaction and background work, and its subagent runs. Role segments split the total into own calls, workers, reviewers and others. A run's role comes from its agent type, such as worker or reviewer. You can sort by credits, last active or runs. The list scrolls and loads more sessions when you reach the end.
- Where it went shows how usage flows from roles to models. Hover over or focus a band or node to see its credits or tokens, its share and its calls. Escape hides the detail. With more than seven models, the smallest are grouped into one node, and the table lists every model. Roles with no usage are left out. A partly priced group shows its priced credits and the number of unpriced calls.

The Credits | Tokens switch changes the charts and tables. The pace bar always uses credits. Every chart has a Chart | Table control that shows the same values as a table.

To select or deselect a bucket, Cmd-click it on macOS, or Ctrl-click it on other systems. Selected buckets do not have to be next to each other. Models, sessions and the flow follow the selection. The range total and the monthly pace do not change. Use the arrow keys to move between buckets, and Cmd/Ctrl+Enter or Space to select or deselect one. Escape clears the selection, and so does a click outside the bars and controls.

The URL keeps the Overview range, the unit and the selected buckets, so Reload, Back and Forward restore the view. If a rolling range moves past a selected bucket, the bucket drops out of the selection.

## Session

To open a session, click its row or press Enter. Session opens on the current billing month, or on the calendar month of the session's last activity if it had none this month. It does not follow the range selected on Overview. From and To open a calendar for picking other days. This month and Whole session are shortcuts. Days use your browser's time zone. The URL keeps the range, so Reload, Back and Forward restore it. The unit carries over from Overview.

The header shows the session name, the project, the selected range and the totals for that range. A transit chart shows the activity inside the range. It puts the session's own calls on a baseline and its subagent runs on branches. Long idle stretches collapse into breaks. Run marks show whether work completed, was cancelled, failed or is running. If the status is unavailable, the chart does not guess it. Hover over or focus a branch to see its details, click it or press Enter to pin it, and press Escape to clear it. The runs table scrolls and shows each run's role. The runs and models tables show the same usage evidence. The flow adds up to the session total.

A session without subagent runs shows only its baseline. A known session without calls keeps its header and shows an empty state. An unknown id shows Session not found with a Back button, and does not retry in a loop. Back goes back through the dashboard history, or to the Overview you last viewed.

A session's name is the latest `/name`. If there is none, it is the first line of the first user message written in that session (not one copied from a fork). If there is no such message, it is a short id. Names are limited in length and redacted. Projects show as names, not paths. Runs whose owning session cannot be found appear together as Unattributed runs.

## Credits, tokens and pace

Credits use published rates, corrected against compatible evidence from the account counter. When no correction factor is available, credits use the published rates. During a counter outage, credits keep the last accepted factor where there is one. The correction basis and its coverage are shown on Calibration & data, not next to every credit figure.

The 2026-10-04 snapshot of published rates applies from June 1, 2026, when GitHub moved Copilot to usage-based billing. These historical prices are estimates. They do not show that every rate stayed the same over that period. Calls before June 1 stay unpriced.

[Managed compaction](compaction.md#managed-parent-summaries) records its summary model for pricing. Compaction and branch summaries with a recorded model use that model's published rates. Without a model, they use pi's recorded cost in two cases: when the active provider is GitHub Copilot, or when the provider is unknown and all attributed session calls use Copilot (there must be at least one). Summaries from before the earliest rate date stay unpriced. So do summaries without a model that have a recorded cost of zero for a nonzero number of tokens.

Token totals are input plus cache read plus cache write plus output. Reasoning and one-hour cache writes are subsets, not additional tokens. Unknown pricing stays unavailable and is never shown as zero. A total that includes unpriced calls does not invent a price for them.

Model usage owned by a tool is counted once, from the final top-level tool result. Nested execution events do not add it again. Run summaries put it in an unattributed tools bucket instead of assigning it to the last chat model. The dashboard does not work out provider or model prices from that total.

The ledger stores pi's recorded response duration, falling back to the legacy `latencyMs`. It also stores the thinking level the response requested, separately from the provider's own effort setting. Missing values stay unknown. In `/agents`, run details show the known response and tool times next to each event. Tool times that overlap are not added together as the run's elapsed time.

The billing month ends at the account counter's reset date, in UTC. Without usable counter evidence, the billing month is the UTC calendar month. The used amount comes from the account counter when there is a valid reading in the period. Otherwise it comes from pi's corrected usage for the month so far. The account counter includes usage outside pi and on other machines.

The projection uses the average daily rate over the last 7 days, or since the billing month began if that is shorter. It uses compatible counter deltas when they cover that window, and corrected pi usage otherwise. Sparse snapshots, account changes and resets can make a counter-based rate impossible. These figures help you pace your usage. They are not an exact bill.

## Monthly budget

`usage.monthlyBudget` is optional and unset by default. It must be a finite positive number of credits per billing month. Set it in spider's global configuration screen, or with:

```text
/spider config set usage.monthlyBudget <credits> --global
```

Remove it with:

```text
/spider config unset usage.monthlyBudget --global
```

Changes apply live. The dashboard does not edit settings. With a budget, the pace bar is scaled to the budget, and the popover shows the even pace and any projected overspend. Without a budget, the bar uses the account allowance. With neither a budget nor an allowance, the bar shows the used amount and does not invent a proportional fill.

All usage settings are global-only. `usage.footer` turns on the terminal footer, `usage.counter.poll` controls account polling, which runs in parent sessions only, and `usage.calibration` selects `auto` or `off`. Changes apply live. To use published rates only, run:

```text
/spider config set usage.calibration off --global
```

To turn automatic correction back on, run `/spider config unset usage.calibration --global`. The session and run alert thresholds are reserved settings. Alerts are not implemented.

## Calibration & data

This page explains where the numbers come from and how healthy collection is. Times and buckets on this page are in UTC.

- Correction shows the factor, the published estimate and the account-counter delta for matching accepted intervals. It also shows the hours covered and the correction status. Days with no counter data stay empty and are not filled with zero. Counter intervals are the spans that were observed. They are not billing split exactly by calendar day.
- Rates lists the published credits per million tokens for input, cache read, cache write and output, with tiers and source dates. Unpriced models show call counts and reasons.
- Ingestion shows the collector, the last ingest, the number of files tracked, today's calls and the error count. The collector can be this pi session, another pi session, the dashboard server, or none. Errors use redacted labels. Gaps include unpriced calls, compaction without a model attribution, and days without counter data.

The freshness dot turns grey after five minutes without an ingest. Visible pages refresh at intervals, and you can also refresh by hand. A network or server error ends in an error message with Retry, not an endless spinner. If access expires or the server stops, run `/usage` again.

## Terminal footer

The parent TUI footer shows the context percentage and window first. Then come the session credits, the prompt cache-hit rate of the latest assistant reply (`CH`), `month`, input and output tokens, and cache read and write tokens. Items are separated by middle dots. The footer shows credits without pricing-basis markers. `month` is a whole percentage of your budget when one is set, and of the allowance otherwise. If neither is available, the `month` item is left out.

The format is `context%/window · credits · CH% · month % · ↑input ↓output · Rread Wwrite`.

The working directory, branch and session name stay on the first row. Extension statuses appear when there are any. In narrow panes, the lower-priority usage items disappear first. Token totals follow pi's session history across all entries, including copied fork history, compaction and usage appended in the background. The footer renders from cached values and does not open the ledger. Turning `usage.footer` off brings back pi's built-in footer and leaves the agents widget as it is.

## Collection, privacy and diagnostics

A background worker finds pi session history and registered subagent transcripts, resumes from saved offsets, and records usage in a separate local ledger. Backfills of billing and metadata run in limited passes and do not block pi. The metadata backfill visits sources with the newest modification times first, and breaks ties by path. While billing, session metadata, response metadata or re-pricing is incomplete, the ingest owner runs another pass after about three seconds, and every pass includes billing ingestion. Once the backfill is complete, it goes back to one pass a minute. Session metadata and response metadata each have their own limit of 32 MiB per pass. If the worker loses the lease, it stops writing. Malformed lines and missing sources are recorded as diagnostics. Children never poll the account counter. A fenced lease lets one parent poll while other sessions read the published snapshots.

Counter polling is an authenticated, read-only request that uses pi's stored Copilot credential. Missing fields or a failed request produce no reading, not a zero balance. The dashboard server never polls the account or reads authentication. When the server takes part in ingestion, it releases the lease between passes.

The server listens on loopback only. Before assets load, the browser exchanges a single-use bootstrap code for an HttpOnly, SameSite=Strict cookie. Other local processes may be able to see bootstrap codes, and loopback cookies are not tied to a port. Treat other local processes as inside the trust boundary. Restarting the server ends browser sessions. Servers stop on their own when inactive.

The dashboard does not upload usage records, transcript bodies or credentials. `/doctor` reads the diagnostics the worker publishes, including backfill progress, counter availability, unpriced usage and sanitized errors. Unpriced diagnostics cover the current billing period and count calls without a model separately. On the first run after an upgrade, or when the pricing fingerprint changes, the ingest owner revisits stored unpriced detail and compaction calls without a model. It works in resumable batches of at most 2,000 calls. Historical compaction calls use pi's recorded cost only when stored session evidence attributes them to GitHub Copilot. Run reports are not re-priced. Reload every running session after an upgrade, so that an older build does not keep ingesting under the old pricing policy. Calls that were already priced, and calls that still cannot be priced, keep their stored values and reasons. While re-pricing runs, `/doctor` shows `usage reprice=running 2000/5000 calls`, and then `usage reprice=complete`. A pricing update invalidates calibration, corrected totals and the cached month values in the footer. If the worker fails or the ledger is unsupported, the cached terminal totals still work.

The ledger v6 upgrade adds columns and cannot be undone: earlier spider builds cannot open the ledger after the upgrade. Reload every session after upgrading. On first start, the collector fills in missing response duration, response thinking, provider effort and tool-result metadata in the background. It updates existing rows in place. It does not replace billing history or change totals, pricing or attribution. Each source has its own checkpoint, so this work resumes after a restart. Transcripts that are no longer available keep their stored facts. `/doctor` shows `usage responseMetadata=running` with its own source progress, then `complete` once no available source is still partial. Unavailable sources are counted apart from completed sources, in billing backfill progress too. By default the ledger lives at `~/.pi/agent/spider/usage.db`, or at `usage.db` under `SPIDER_GLOBAL_ROOT` when that is set. Back it up before upgrading. An open dashboard on the current build picks up the upgraded ledger on its next refresh. Prompt composition analysis and alerts are not available. POSIX hosts are supported. Windows hosts are not.

## Contributing to the dashboard

For UI work, run `npm run dev:dashboard`. It serves synthetic fixture data and a states page that exists only in development. It does not read your usage ledger or settings.

To check against real data, run `npm run build:dashboard` and restart the dashboard server. The server loads the packaged browser assets once, at startup, so a rebuild alone does not change the page of a server that is already running. `/usage` has no stop or restart subcommand. Close the dashboard tabs and wait for the 30-minute idle timeout, then run `/usage`. To stop the server now, find the process listening on the port in the dashboard URL. Compare its PID with `usage-server/lock.json` in spider's global data directory. Send SIGTERM to that confirmed server process with `kill -TERM <pid>`, then run `/usage`. Do not signal a PID from an old lock file that you have not checked. You can also run the full `npm run build`, reload pi, then run `/usage`, and the new extension build starts a fresh server. Extension watch does not rebuild the browser assets. `npm run build` builds the extension, builds the dashboard and checks the packaged output.
