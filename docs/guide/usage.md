# Usage and AI Credits

## Footer

- The usage footer replaces pi's built-in footer in parent TUI sessions. It shows estimated GitHub Copilot AI Credits (AIC), not pi's dollar figure. One AIC is $0.01.
- Row 1 shows the working directory, git branch and session name. The model and thinking level keep priority in narrow panes.
- Row 2 keeps whole items in this order: context percentage/window, session AIC, latest assistant prompt cache hit rate (`CH`), account month percentage, input/output tokens, cache read/write tokens. Lower-priority items disappear first when space is limited.
- Row 3 shows extension statuses when present.
- Context usage comes from pi's public context getter and matches pi's footer. No context value yet shows `0.0%`; an explicitly unknown percentage is `?`. The public API does not expose the live auto-compaction switch, so the footer does not show an `(auto)` marker.
- The token totals match pi's built-in footer: all entries in the current session file, including abandoned branches, tool-result usage, compaction and branch summaries, and asynchronous usage or cache-warming entries. Tree navigation re-reduces that same all-entry history. Compaction does not reset totals.
- Starting a new session, resuming or switching to another file, or forking into a new file resets the reducer to that file's entries. A fork includes any history pi copied into the new file.
- Rendering uses cached totals. A one-second UI tick picks up asynchronously appended usage entries without a model call or ledger query. It requests a TUI render only when the displayed footer changes.
- `~` before AIC means estimated pricing or a run aggregate. A trailing `+` means a partial lower bound with unpriced entries. Unknown models are not priced at zero.
- Copilot rates are a versioned public snapshot dated 2026-10-04, effective from 2026-10-01. Earlier calls remain in the ledger but are unpriced when no rate applies at their timestamp.
- Tool results and summaries without billing-model attribution remain unpriced. The active session model is not guessed as their billing model. Non-Copilot calls keep pi cost in the ledger but are unpriced in AIC.
- `usage.footer=false` restores pi's built-in footer through `setFooter(undefined)`. It does not touch spider's agents widget. The independent `ui.footer` setting controls that widget and run selector from the next session.
- RPC, JSON, print and child sessions install no terminal usage footer. Parent non-TUI sessions can still run the background ledger worker.

## Global configuration

- All five usage keys are global-only. Sets require explicit global scope, including slash commands. Hand-written local values are ignored and diagnosed by config and doctor without failing config health. A local unset removes an ignored local key without changing the global value.
- `usage.footer`: default `true`. Enable the AIC footer. Changes apply live.
- `usage.counter.poll`: default `true`. Enable parent-only counter polling. Changes apply live.
- `usage.calibration`: default `auto`. Use counter-calibrated AIC when there is enough compatible evidence. `off` uses published estimates and disables factor history. Changes apply live.
- `usage.alerts.sessionCredits`: default `0`. A finite nonnegative threshold reserved for a later phase. Alerts are not implemented.
- `usage.alerts.runCredits`: default `0`. A finite nonnegative threshold reserved for a later phase. Alerts are not implemented.
- Global configuration is `~/.pi/agent/spider/config.json`, or `config.json` under `SPIDER_GLOBAL_ROOT`.
- Tool example: `spider control command:"config" op:"set" key:"usage.footer" value:"false" scope:"global"`.
- Slash example: `/spider config set usage.footer false --global`.
- Reset to the default: `/spider config unset usage.footer --global`.
- To remove a hand-written local usage key: `/spider config unset usage.footer --local`. The result says local usage keys are ignored anyway. Omitted scope also selects local cleanup for unset. `/spider config get` shows effective values and diagnostics.

## Local ledger and account counter

- Usage data stays local in `~/.pi/agent/spider/usage.db`, or `usage.db` under `SPIDER_GLOBAL_ROOT`. It is separate from spider's project and registry databases.
- Pi history is discovered under `~/.pi/agent/sessions`. Registered run metadata locates child transcripts. There is no recursive whole-disk scan.
- A worker thread opens the ledger, backfills discovered history, resumes saved byte offsets and refreshes discovery/ingestion every minute. Malformed lines and source errors are counted without interrupting pi.
- The first backfill takes about a minute on a large history and runs in the background. Pi remains usable while it runs.
- A parent polls the account counter every ten minutes. A fenced lease makes one parent the poll owner; followers consume published snapshots. Children never poll. Polling and ingestion stay off pi's main thread.
- The counter is an authenticated read-only GET to GitHub's undocumented Copilot account endpoint. Its fields are optional. A failure or missing credit field records no snapshot, not a zero balance.
- Authentication reads pi's stored `github-copilot.refresh` credential read-only from `~/.pi/agent/auth.json`. It does not use `gh` credentials, short-lived resolved API keys, refresh auth storage or execute configured key commands.
- Transcripts, credentials and usage records are not uploaded. The counter GET uses the network; the dashboard can optionally load Google Fonts.
- The footer's account month percentage is available only with a usable counter snapshot and positive entitlement. An unavailable or stale counter does not prevent the session AIC footer from working.

## Dashboard

- Run `/usage` in a parent pi session to open the local dashboard in your browser. The command starts or reuses a detached server bound only to `127.0.0.1` on a random port. It serves a read-only view of the local ledger.
- Overview: period totals, daily AIC and token observations, actor and role breakdowns, ingest health and source diagnostics.
- Explorer: filter recorded usage and group it by up to three dimensions, with chart and table evidence.
- Session: selected session totals, call timeline, recorded calls and related runs.
- Run: selected run totals, call timeline, accounting selection and related sessions or runs.
- Context: explicit placeholders for composition, carry cost and item reuse, with links to recorded usage evidence.
- Cache: recorded cache reads and writes, hit rates, warmer usage and sessions with writes but no recorded reads.
- Reconciliation: account-wide counter, published and calibrated amounts over compatible snapshot pairs, with gaps, ratios and coverage.
- Rates: loaded published rate versions and tiers, stored version provenance, unpriced evidence and daily calibration history. Stored amounts are never repriced.
- The URL hash retains the view, selected session or run, explicit period and filters. Back, Forward and reload restore that selection. Chart/table choices are independent per chart and stay selected during refresh and view navigation, but reset on reload. Without an explicit period the dashboard follows the current UTC month.
- `mode=table` in the URL hash opens every chart as a table; `mode=chart` opens every chart as a chart. Chart/table selections are not serialized; new or normalized hashes omit this parameter.
- Use Tab to reach controls and scrollable tables. Narrow layouts retain the same evidence as desktop layouts; wide tables include a horizontal scroll cue. Refresh runs every minute only while the tab is visible and recently active. After five minutes away, requests stop until activity resumes.
- AIC is approximate. Prompt tokens are input plus cache read plus cache write; total tokens add output. Recorded reasoning and one-hour cache writes are subsets, not extra totals. Unpriced usage stays unavailable, not zero; mixed pricing is a lower bound marked `+`.
- `usage.calibration=auto` fits the trailing seven days of compatible account counter evidence. It needs at least 24 covered hours and 500 published AIC. Reset, account and clock boundaries are excluded. Insufficient or implausible evidence falls back to the published estimate. Calibration does not prove complete attribution or exact billing.
- The primary AIC basis is calibrated when possible, or published otherwise. Historical periods before the earliest usable fit use `cal (back-applied)` on amounts and `calibrated, back-applied` in evidence. Rates shows each day's own evidence window and factor; Reconciliation retains all three amounts when available.
- The key uses `cal` for calibrated, `?` for calibration unavailable and `est` for published estimates with calibration off. AIC remains approximate in every mode. Tokens are unaffected by calibration.
- To use published estimates only: `/spider config set usage.calibration off --global`. Restore automatic calibration with `/spider config unset usage.calibration --global`. Reloading configuration does not open a browser or reset tokens.
- The counter is account-wide and can include other clients and machines. It moves in whole AIC, with typical billing lag of 3 to 5 minutes. Short gaps and ratios are not a bill.
- The opener passes a single-use 60-second bootstrap code in argv, visible in local process listings. Another local process can race its use, but the code never reveals the lock secret. The browser consumes it and redirects to a clean URL before loading assets.
- The session cookie is HttpOnly and SameSite=Strict. Cookies are not port-scoped, so other services on `127.0.0.1` can receive it. Server restarts invalidate sessions; idle sessions expire. If access expires or the server stops, run `/usage` again.
- Launch is POSIX only. Windows hosts are not supported.
- If a sandbox denies a process signal with `EPERM`, the owner is treated as dead or stale, so `/usage` starts a fresh server instead of reusing it. `/usage` reports launch failures and points to `/doctor`, which shows the bounded failure code. Transcript source errors can show `EPERM` in Overview and `/doctor`.
- Public filter ids for project, repository, actor, role, agent, provider, model, requested model, thinking, run name, phase, parent run, auxiliary purpose, API and day use a private per-ledger salt. Safe stored session and run ids are not salted, so their detail bookmarks survive a salt reset.
- Keep the `<ledger>.explorer-salt` sidecar with its ledger. An unusable salt returns `identity-unavailable`, cached for five seconds. Remove the unusable sidecar and wait for that failure-cache window; the next request recreates it without reopening the ledger. To discard a salt the running server has already loaded, restart the dashboard server.
- Removing a stray `<ledger>.explorer-salt.<24 hex>` publication temp hardlink preserves saved selections. Resetting the salt invalidates opaque filter-id bookmarks with `unknown-filter-id`. Clear filters and reselect values to rebuild the selection, then save the new URL.
- Data routes can show an unsupported or unavailable ledger while an older ledger awaits migration by pi's writable usage worker or the dashboard ingest participant. Status remains available; after the worker upgrades the ledger, refresh the dashboard.
- The v3 ledger upgrade locks out older spider builds. Use a compatible build after upgrading.
- The one-time migration holds the ledger write lock for a few seconds, growing with ledger size.
- The dashboard ingest participant releases the write lease after each pass. While it owns ingestion, pi cannot poll the counter. Pi normally resumes within three seconds of handback. The server itself never reads authentication or polls the counter.
- Discovery uses a one-minute stat refresh rather than a recursive filesystem watcher. Without pi, the dashboard waits at least a minute between ingest passes and releases the lease while waiting. A server with no authenticated activity stops after 30 minutes.
- Google Fonts is the dashboard's only optional network access. Local fonts are tried first, and system fonts remain usable offline. No usage data is sent with font requests.

## Doctor and limitations

- `/doctor` reads the worker's published usage snapshot. It does not open or create the usage ledger on pi's main thread.
- Usage diagnostics include schema and call/source counts, backfill state and source progress, counter lease role, availability, age, staleness, notices, sanitized errors, parse/source error counts, unpriced models, aggregate counts and rate provenance.
- No published ledger yet is reported as such. Worker failure keeps the terminal footer working from session entries.
- Usage health fails only for a failed or crashed worker, unavailable worker-thread runtime, unavailable ledger or failed ledger open/migration, or failed backfill. Recorded parse error counts, current source error counts, dashboard server failures, missing project databases, missing Copilot login, counter HTTP errors, stale or unavailable counters, disabled polling and unavailable comparison are informational.
- Children report `usage worker: not started (child session)`.
- The comparison is labelled estimated. Its signed gap is account counter minus computed AIC. Its ratio is computed AIC divided by the counter; a zero or unavailable counter has no ratio.
- Exact billing reconciliation remains unresolved. The account counter includes other clients and machines, and estimated rates or incomplete attribution can leave a gap. Do not treat the footer or comparison as an exact bill.
- Diagnostics do not print credentials or raw endpoint bodies.
- Context composition, carry cost and item reuse are not available yet (Phase 2). Historical context fill is unavailable because the window was not recorded. Insights, what-if pricing and alerts are not implemented.
