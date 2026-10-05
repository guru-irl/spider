# Usage ledger, AI Credits and dashboard: design

## Goal

Show exactly where model tokens go, priced in GitHub Copilot AI Credits (AIC), so spending decisions can rest on data.

Success means:
- Every model call made on this machine through pi and spider is in one local ledger. Each call carries its tokens by type, its AIC and its attribution: who made it and why. This covers parent sessions, subagent runs, spider's internal jobs and compaction.
- The ledger reconciles against GitHub's account-level credit counter, and the gap is shown, not hidden.
- A local web dashboard answers "what is using tokens", down to individual context items and their carry cost.
- The pi footer shows AI Credits instead of dollars, and keeps the model and thinking level visible in narrow panes.

## Facts this design rests on

- **Billing.** Since 2026-06-01 Copilot bills by tokens. Each model has per-million-token rates for input, cached input, cache write and output. Some models have a long-context tier above an input threshold. 1 AI credit = $0.01. Source: GitHub Docs, "Models and pricing for GitHub Copilot".
- **The account counter.** `GET https://api.github.com/copilot_internal/user`, authenticated with the user's Copilot GitHub OAuth token, returns `quota_snapshots.premium_interactions` with `credits_used`, `entitlement`, `remaining` and `token_based_billing`, plus `quota_reset_date`.
  - It is the endpoint official Copilot clients use for their quota display. It is undocumented, so every field is optional.
  - It is account-level, so it includes usage from other clients and machines.
- **pi transcripts.** pi session files (JSONL) record:
  - for every assistant message: `provider`, `model`, `api` and `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h`, `reasoning`, `cost`);
  - `usage` entries appended by extensions (`kind`, `provider`, `model`, `usage`, `note`);
  - `compaction` entries with their own usage;
  - the full message content and a parent-linked entry tree.
- **pi's own cost is unreliable here.** Its `cost` is often 0 for Copilot models, so the ledger never uses it for AIC.
- **What spider already records (#61):**
  - Child runs keep transcripts at `<project scratch>/subagent-sessions/<runId>/<runId>.jsonl`.
  - The repo DB `runs` table has `agent`, `role`, `name`, `model`, `thinking`, `phase`, `parent_run_id` and `session_id`.
  - Parent sessions receive `usage` entries:
    - `kind: "subagent"`, with note `<name> (<runId>)`;
    - `kind: "spider-aux"`, with the internal job's purpose as the note.
- **The footer.** pi's extension API offers `ctx.ui.setFooter(factory)`, which replaces the built-in footer entirely. The factory receives `footerData` with the git branch and extension statuses.

## Scope

In scope:
- the ledger;
- a full backfill of all local history;
- live ingestion;
- AIC pricing;
- reconciliation;
- context composition and carry cost;
- the web dashboard;
- what-if re-pricing;
- rule-based insights;
- in-session alerts;
- the AI Credits footer.

Out of scope:
- usage from other machines or clients beyond the counter's reconciliation gap;
- quality comparisons between models;
- any change to pi itself;
- new npm dependencies;
- writing to GitHub.

## Architecture

All code lives in existing packages, so no new workspace package or lockfile change is needed. The usage modules live under `packages/host/src/usage/`. The web app's static assets are built into the single `dist/extension.js` as strings. Dependencies follow the existing DAG: usage modules depend on db-core; host wires them up. They must not import pi internals; pi data comes through the extension API or session files.

Units, each independently testable:

1. **`rates`.** A versioned rate table: model id, then tiers, then the four rates, with an `effectiveFrom` date and a `source` note.
   - It is seeded from the GitHub page for every Copilot model it lists.
   - `priceCall(model, usage, at)` returns AIC with a per-component breakdown, or `unpriced` with a reason.
   - The long-context tier applies when the prompt tokens (`input + cacheRead + cacheWrite`) exceed the tier threshold.
   - Reasoning tokens are billed as output. Phase 1 verifies whether pi's `output` already includes them, so they are not counted twice.
   - Non-Copilot providers are `unpriced` in AIC. They keep pi's dollar figure as a secondary field.
2. **`ledger`.** Its own SQLite file, `<global root>/usage.db`, opened through db-core with its own migrations. It is kept separate from `spider.db` so heavy imports never contend with session writes. Tables:
   - `calls`: one row per model call, with:
     - id, ts, the source file and entry id;
     - project, repo, session id and run id;
     - `actor`: parent, subagent, aux, compaction or warmer;
     - role, agent, run name, pipeline phase and parent run;
     - aux purpose;
     - provider, model, thinking and api;
     - all token fields, the AIC components and the AIC total;
     - pi cost;
     - latency, if recorded.
   - `context_items`: one row per distinct context item per session, with:
     - session, item id and kind: system, user, assistant text, thinking, tool call, tool result, custom message or compaction summary;
     - the tool name;
     - a label, such as a file path or command prefix;
     - estimated tokens;
     - the first and last call index it was present in;
     - its carry AIC.
   - `call_composition`: per call, the estimated tokens and AIC per category. Categories are the kinds above, plus tool name.
   - `counter_snapshots`: ts, account login, `credits_used`, entitlement, remaining, reset date and the raw fields as JSON.
   - `import_state`: per source file: path, inode, size, mtime, the byte offset ingested and a parse-error count.
   - `runs_meta`: a copy of the run metadata pulled from each repo DB.
3. **`ingest`.**
   - **Discovery:**
     - parent sessions under pi's sessions dir;
     - child transcripts: for every project in the global registry, open each tier DB read-only, read `runs`, and map run ids to transcript paths;
     - no recursive disk scans.
   - **Incremental reads:** resume from the stored offset, and restart a file if its inode or size went backwards.
   - **Parsing:** assistant messages become `calls`.
     - `usage` entries with `kind: "spider-aux"` become aux calls.
     - `usage` entries with `kind: "subagent"` are dropped when that run's transcript was ingested. Otherwise they are stored as a run-level aggregate call flagged `aggregate`.
     - Compaction entries become compaction calls.
     - Cache-warmer requests become warmer calls, if pi records them; Phase 1 finds out. If pi does not record them, they show up only in the reconciliation gap.
   - **Isolation:** a malformed line increments the parse-error count and is skipped. It never aborts the file.
   - **Idempotent:** re-importing yields identical rows, keyed by source file plus entry id.
4. **`compose`.**
   - For each call, rebuild the context that was sent: walk the entry tree from the call back to the root along `parentId`, and replace everything before the latest compaction with its summary.
   - Estimate tokens per item with a local, dependency-free estimator, then scale the item estimates so they sum exactly to the reported prompt tokens. Before scaling, the system bucket is the residual (reported prompt minus messages, floored at 0).
   - **Prefix allocation:** the earliest items covering `cacheRead` tokens are priced at the cached rate, the next items covering `cacheWrite` at the cache-write rate, and the rest at the input rate.
   - An item's carry AIC is the sum of its allocated cost over every call it was present in.
   - For sessions after deploy, spider records the exact sizes of the system-prompt sections it injects, so the system bucket splits into spider-injected and other.
5. **`counter`.**
   - A parent pi session polls the account counter every 10 minutes. A lockfile lease makes one poller per machine. Children never poll.
   - The credential is pi's Copilot GitHub OAuth token. Phase 1 decides how to obtain it: through pi's API if one exists, otherwise by reading pi's auth file read-only.
   - It never uses `gh`'s token, because that account can differ from pi's Copilot seat.
   - A failure or missing field records nothing, and the dashboard says "counter unavailable".
6. **`insights`.** Fixed rules, each with evidence and AIC impact:
   - the top carry-cost patterns, grouped by tool plus label pattern;
   - cache writes never read back in their session;
   - runs above 3 times the median AIC for their role and model;
   - compaction that came late (long stretches above a context threshold before compacting);
   - premium models used for basic roles (scout, watcher, smoke);
   - files re-read in one session;
   - month pace: the projected month-end AIC against the entitlement.
7. **`whatif`.** Re-price a filtered slice under a model substitution map, with the recorded tokens and the same tier rules. It shows the delta per group and labels clearly that quality is not modelled.
8. **`server`.**
   - `/usage` starts or reuses a detached local server process that serves the dashboard and a read-only JSON API. A lockfile records its pid, port and token. The server opens the ledger itself.
   - Security:
     - binds to 127.0.0.1 only, on a random port;
     - every request needs a random token, given in the URL once and then held in a cookie;
     - the Host header is checked against DNS rebinding;
     - no CORS;
     - the server never writes user files outside `usage.db`.
   - It ingests on start, then watches the source files and re-ingests every 60 s while running. It exits after 30 minutes with no requests.
9. **`web`.** The dashboard: plain TypeScript with no framework or chart library, hand-built SVG charts, served as one HTML document. See UI below.
10. **`footer`.** spider's footer, set with `setFooter`. See Footer below.
11. **`alerts`.** Off by default. `usage.alerts.sessionCredits` and `usage.alerts.runCredits` set thresholds. Crossing one shows a single pi notice for that session or run.

## Footer

The layout is priority-based, so narrow panes keep what matters.

- **Row 1:** `<cwd> (<branch>) • <session name>`, then the model and thinking level (`claude-opus-5.5 · high`).
  - Model and thinking get priority. When space runs out, the cwd is truncated from the left first, then the branch is dropped, then the session name is truncated.
- **Row 2:** stats, in this priority order:
  1. context use (`14.6%/1.0M`, plus `(auto)` when auto-compaction is on);
  2. session AIC (`3,294 AIC`), covering subagent and aux usage entries;
  3. cache hit rate (`CH99.3%`);
  4. the account month-to-date (`month 3.4%`), from the latest counter snapshot;
  5. `↑` input and `↓` output;
  6. `R` cache read and `W` cache write.

  Items are dropped from the lowest priority up until the row fits. Nothing is cut mid-token.
- **Row 3:** extension statuses, as in pi today.
- Values are computed through the public API: session entries, `getContextUsage()`, the model, thinking level and session name, and auto-compaction state where exposed. A parity test checks the token totals against pi's own footer arithmetic on fixture sessions.
- `usage.footer: false` restores pi's footer.

## Dashboard UI

- **Style:** academic and quiet.
  - Dark, using the Dracula palette: background `#282a36`, surface `#21222c`, raised `#343746`, text `#f8f8f2`, muted `#6272a4`.
  - Data series use Dracula cyan, green, orange, pink, yellow and red, as small accents only.
  - No purple, gradients, glows, shadows or borders.
  - Separation comes from spacing and surface tone.
- **Fonts:** Google Sans Flex for text and Cascadia Code for numbers and code, each via `local()` first and Google Fonts second, with system fallbacks. Numbers use tabular figures.
- **Charts:** small multiples, sparse gridlines, direct labels instead of legends where possible. Every chart has a table view.
- **Views:**
  - **Overview:** the month counter against computed AIC, pace, daily AIC by actor and role, and the top insights.
  - **Explorer:** a pivot table. Group by any attribution field (project, session, actor, role, agent, model, thinking, run, phase, aux purpose, day) and filter, sort and drill down from any cell.
  - **Session and Run:**
    - a call timeline with tokens by type, AIC and context fill;
    - composition as a stacked area;
    - the carry-cost ranking of context items;
    - links between a parent and its runs.
  - **Context:** composition across any slice, by category, tool and label.
  - **Cache:** hit rate, writes never read, and warmer activity.
  - **What-if:** a substitution map editor, with deltas per group.
  - **Reconciliation:** counter deltas against computed AIC per period, and the unattributed gap.
  - **Rates:** the table in use, its source and date, and the unpriced models seen.

## Configuration

All keys are global-only:
- `usage.footer` (default true);
- `usage.counter.poll` (default true);
- `usage.alerts.sessionCredits` (default 0, off);
- `usage.alerts.runCredits` (default 0, off).

## Error handling

- Ingestion never throws into pi. Errors are counted per source and shown in the dashboard and in `/doctor`.
- Unknown models are `unpriced` and listed, never priced at 0.
- If the counter is unavailable, reconciliation shows "unavailable"; everything else works.
- The server and ledger run outside pi's main thread. The footer and alert computations are O(new entries) per update.

## Privacy

- All data stays local in `usage.db`. Nothing is uploaded.
- Test fixtures are synthetic and contain no real transcripts, accounts or counter values.

## Testing

- Unit tests per unit, using synthetic transcripts that cover: branches, compaction, aux and subagent usage entries, missing child transcripts, and malformed lines.
- Rate tests check every tier boundary.
- Golden tests for composition and prefix allocation.
- Ingestion idempotence and resume tests.
- Server tests for the token, the Host check, the 127.0.0.1 binding and read-only behaviour.
- Footer layout tests at widths from 40 to 200 columns.
- A visual check of the dashboard by headless browser screenshot.
- **Phase 1 validation:** compute AIC for one month-to-date window from the user's own history, and compare it with the counter. Report the ratio and investigate any gap above 10% before building on the rate rules.

## Phases (one PR each)

1. **Footer and pricing:**
   - the AIC footer, including the narrow layout;
   - the rate table;
   - the counter poller and snapshots;
   - the ledger schema and the backfill or ingest of calls;
   - the validation spike;
   - `/doctor` lines.
2. **Composition:** context composition and carry cost.
3. **Dashboard:** the server and web app with the Overview, Explorer, Session and Run, Context, Cache, Reconciliation and Rates views.
4. **Decisions:** insights, what-if and alerts.
