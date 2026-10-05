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

- All four usage keys are global-only. Sets require explicit global scope, including slash commands. Hand-written local values are ignored and diagnosed by config and doctor without failing config health. A local unset removes an ignored local key without changing the global value.
- `usage.footer`: default `true`. Enable the AIC footer. Changes apply live.
- `usage.counter.poll`: default `true`. Enable parent-only counter polling. Changes apply live.
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
- Transcripts, credentials and usage records are not uploaded. Only the counter GET uses the network.
- The footer's account month percentage is available only with a usable counter snapshot and positive entitlement. An unavailable or stale counter does not prevent the session AIC footer from working.

## Doctor and limitations

- `/doctor` reads the worker's published usage snapshot. It does not open or create the usage ledger on pi's main thread.
- Usage diagnostics include schema and call/source counts, backfill state and source progress, counter lease role, availability, age, staleness, notices, sanitized errors, parse/source error counts, unpriced models, aggregate counts and rate provenance.
- No published ledger yet is reported as such. Worker failure keeps the terminal footer working from session entries.
- Usage health fails only for a failed or crashed worker, unavailable worker-thread runtime, unavailable ledger or failed ledger open/migration, or failed backfill. Lifetime parse/source error counts, missing project databases, missing Copilot login, counter HTTP errors, stale or unavailable counters, disabled polling and unavailable comparison are informational.
- Children report `usage worker: not started (child session)`.
- The comparison is labelled estimated. Its signed gap is account counter minus computed AIC. Its ratio is computed AIC divided by the counter; a zero or unavailable counter has no ratio.
- Exact billing reconciliation remains unresolved. The account counter includes other clients and machines, and estimated rates or incomplete attribution can leave a gap. Do not treat the footer or comparison as an exact bill.
- Diagnostics do not print credentials or raw endpoint bodies.
- Phase 1 does not include context composition, the `/usage` server, a web dashboard, insights, what-if pricing or alerts. Phases 2 to 4 are not present.
