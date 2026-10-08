# Usage dashboard redesign

- Date: 2026-10-08
- Status: approved by the user after static mock round 7 (with one change: the even-pace tick is
  removed from the pace bar)
- Replaces: the web UI, its build, its API routes, its browser tests and the footer text from
  `2026-10-04-usage-dashboard-design.md`. The ledger, ingestion, counter polling, calibration
  maths, redaction, and the server's lifecycle and security stay as specified there.
- Product truth: `packages/host/PRODUCT.md`. Visual direction contract: the Impeccable surface
  brief for `packages/host/src/usage/web/app.ts` (development only, never shipped in the page).

## 1. Why

The shipped dashboard answers few human questions. Users could not tell what the charts meant,
the diagnostics view was noise, and the Session and Run pages showed nothing in practice:

- the Session and Run rail buttons opened placeholders with no picker and no request;
- Explorer selections set filters instead of opening a detail page;
- detail links kept the current-month window, so older sessions showed no calls;
- an unknown id returned 404, but the page showed a generic Retry and a relationships panel that
  never finished loading.

The footer's `cal`, `est` and `?` markers meant nothing to readers.

The redesign answers two questions: where did my credits go (to cut spend), and am I on pace for
the month (to stay within the allowance and an optional budget).

## 2. Scope

In scope:

- a new web UI with three pages: Overview, Session, and Calibration & data;
- focused API routes for those pages, replacing the generic ones;
- ledger schema v4: run status, and per-session name, project and span;
- an optional monthly budget setting;
- month pace and projection;
- the footer text;
- the user guide;
- removing the retired views, routes and their tests.

Out of scope: phone layouts, a light theme, a per-model drill-down page, prompt composition
analysis, and changes to the calibration maths or the counter poller.

## 3. Principles

- Credits are the default unit everywhere. A Credits | Tokens switch changes every chart, table and
  the session route axis. Month pace is always in credits.
- Credits are always the billing-corrected figure (published rates times the correction factor,
  or published rates when no factor exists yet). The UI never shows `AIC`, `est`, `cal`, `~`,
  `+` or any basis marker. The Calibration & data page is where the basis is visible.
- No copy that explains the design. Labels, chips and tables carry meaning; sentences appear only
  where a state needs one (for example an empty state or an error).
- Nothing opens empty. Every page has a default that shows data when data exists.
- Every chart has a Chart | Table toggle with the same numbers.
- Keyboard operable and WCAG AA contrast. Desktop browsers only; dark only.
- No framework and no chart library. Charts are hand-built SVG, as today.

## 4. Visual system (Night Transit Map)

DESIGN.md is written at the finish from the built UI (Impeccable new-work). Until then these
decisions bind:

- Fonts: Cascadia Code for numbers, ids, times and model ids; Fira Sans for all other text;
  Bebas Neue for the "SPIDER" wordmark only. Load order: `local()`, then Google Fonts, then system
  fonts.
- Mark: the web glyph as a monochrome inline SVG in `currentColor`, beside the wordmark, optically
  centred (within 1 px). Never an emoji.
- Surfaces: ground `#16120f`, surface `#201a16`, control `#332b24`, ink about `#f3eadb`.
- Model colours (each model keeps its colour on every page): tomato `#f8785c`, sky `#91c7e5`,
  sage `#8fbf8a`, mustard `#e5b840`, assigned by a stable rule (ranked share, then name) with a
  shape marker per model so colour is never the only cue. Further models get further colours from
  the same warm family.
- Role colours (a separate family): own calls cream `#f3eadb`, workers teal `#46b5aa`, reviewers
  rose `#da91bc`, others violet `#a395e4`.
- Freshness: green `#8fbf8a` when fresh, grey `#9b9690` when stale.
- Layout: each section sits in one rounded box with a 1 px border; boxes never nest. Controls,
  legends and facts are outlined pills or chips. Subheadings are chip rows (label in Fira Sans,
  value in Cascadia Code), never sentences. The menu bar sits on the page ground with only a
  bottom border.
- Dates: `Fri 2 OCT`; times: `Tue 6 OCT 09:12`.
- Avoid: purple-tinted panels, multi-shade grey splits, always-on chart labels, Google Sans.

## 5. Navigation and URLs

- Hash routes: `#/` (Overview), `#/session/<id>` (Session), `#/calibration`.
- Overview state lives in the URL: range preset or custom bounds, unit, and selected buckets, so a
  reload or a shared link shows the same view.
- Session ids in URLs use the existing opaque detail-id scheme.
- The menu bar: web mark and wordmark, nav pills (Overview, Calibration & data; the current page
  is the outlined pill), and on the right the freshness dot and a refresh button.
- Session pages open from the sessions list (row click or Enter). They have a Back pill: browser
  history when the previous entry is in the dashboard, otherwise Overview with the last range and
  unit.
- Unknown routes go to Overview.

## 6. Overview

From top to bottom:

1. **Pace bar.** A thick pill bar, full width, the topmost element, with no box, heading or big
   numbers around it.
   - The fill is credits used this billing month. The figure (for example `118.4k`) is written
     inside the fill in bold Cascadia Code, or just after the fill end when it does not fit.
   - The billing month (for example `OCT`) sits in small muted text at the unfilled end. For a
     billing period that does not start on the 1st, it reads `to 14 NOV` (the day before the
     reset).
   - A "you are here" ring marks the fill end. The projected month end is a hatched extension.
   - No even-pace tick.
   - Hover or focus anywhere on the bar highlights the ring and opens a popover anchored at the
     ring with a small table: month and year, used, budget, even pace, projected month end,
     allowance, remaining, days left. The bar is focusable; Escape closes the popover.
   - The bar's scale is the budget when one is set, otherwise the allowance.
   - Past the scale, the fill and the hatch stop at the bar's end and the bar uses the danger
     colour. When used itself is past the scale, the in-bar figure reads `<used> · <n> over`.
     There is no limit tick.
   - With neither a budget nor an allowance, the bar shows the used figure without a
     proportional fill, and the popover lists used, projected and days left.
2. **Controls.** Range presets as an outlined pill group: 24 h, 7 days (default), 30 days, This
   month, Custom (date and time inputs, local time, at most 93 days). The Credits | Tokens switch
   sits on the right.
3. **Daily credits** (left, about two thirds) beside **Models** (right), equal height.
   - Daily credits: stacked bars by model. Buckets are hours for ranges up to 48 hours and days
     otherwise; the title follows ("Hourly credits", "Daily tokens"). Chip row: Total, Average
     per bucket, Peak.
   - Selection: Cmd-click (Ctrl-click off macOS) toggles a bucket; buckets need not be
     contiguous. Unselected bars dim; a chip shows `Selected N days · <total>`. Clicking anywhere
     outside the bars and controls, or Escape, clears it. Keyboard: arrows move between bars,
     Cmd/Ctrl+Enter or Space toggles. The rest of the page (models, sessions, where it went)
     follows the selection.
   - No legend under the chart: the Models panel is the legend.
   - Models: ranked rows with rank, colour and shape marker, model id, credits, a share line with
     its percentage, and one plain note naming the model's main source (for example `72% from
     subagents`, `Mostly worker runs`, `Mostly compaction calls`). Chip row: Models, Credits,
     Top. Unpriced calls appear as one line under the list (count and reason).
4. **Sessions.** One row per session active in the range, ranked by credits in the range.
   - Columns: session name, project pill, last active, a thick stacked bar of the session's
     credits split into own calls, workers, reviewers and others, and the total.
   - Share labels show inside wide segments; hover or focus on a segment shows its role, credits,
     tokens, share and run count. The role legend sits as pills beside the section heading. No
     per-row legend.
   - Chip row: Sessions, Subagent runs, Top 3 share.
   - Sortable by credits, last active and runs. The first 10 rows show; "Show all N" expands.
   - Row click or Enter opens the session page.
5. **Where it went.** A flow chart from roles (own calls, workers, reviewers, scouts, other runs,
   compaction, background; roles with no usage are left out) to models, using the full box width. Each node shows its value and share below
   it. Chart | Table.

## 7. Session

The session page always covers the whole session, from its first to its last call, whatever range
Overview had. The unit carries over.

- **Header:** Back pill; the session name; a project pill (folder icon); a time-span pill; a row of
  large bold stats: total, subagent runs, own calls, compaction, idle gaps.
- **Route.** The session drawn as a transit line.
  - x is time. Idle stretches longer than 30 minutes collapse into a fixed-width break marked with
    the idle length on hover, so long-lived sessions read as their active periods.
  - Own calls run along the baseline (y = 0). Each subagent run branches above or below the line,
    on the side with less overlap, at 45 degree joints. Its distance from the line is its credits
    (tokens in Tokens mode) on a mirrored linear y axis titled "Credits per run" or "Tokens per
    run". Branch colour is the run's model.
  - Marks: a ring when a run completes; an × for cancelled runs; an × in the danger colour for
    failed runs; an open ring at the right edge for runs still going. Compaction shows as ticks on
    the line. Idle gaps over 5 minutes are dotted; hover shows the gap length and the cache-write
    credits of the next call.
  - No labels by default. Hover or focus dims other branches and shows a card: role, run name,
    model, thinking, credits, tokens, duration, status. Click pins the run and highlights its row
    in the runs table; Escape clears. Tab, arrows and Enter work.
- **Where it went:** this session's flow chart, which reconciles with the header total.
- **Runs table:** start, name, role, model, thinking, credits, tokens, duration, status pill
  (completed, cancelled, failed, running). Sortable; first 20 rows then "Show all".
- **Models table:** model, calls, credits, tokens, share.
- A session without subagent runs shows the baseline only. A known session with no calls shows
  its header and one line saying no calls were recorded.
- No pace bar on this page.

## 8. Calibration & data

1. **Correction.**
   - Stat row: correction factor, published estimate and account counter for the matched
     intervals, hours covered, and a status pill (calibrated, back-applied, published only,
     counter unavailable).
   - At most two plain sentences on what the factor does.
   - Chart: published estimate against the counter per day, with honest gaps where the counter
     has no data (never zero-filled). Chart | Table.
   - Counter intervals table, newest first: start, end (UTC), counter delta, published estimate,
     ratio. First 10 rows, then "Show more".
2. **Rates.** Published rates per model per million tokens (input, cache read, cache write,
   output) with the rate source date. An "Unpriced models" list with call counts.
3. **Ingestion.**
   - Stat row: collector (this pi session, another pi session, the dashboard server, or none),
     last ingest, files tracked, calls today, errors.
   - Errors list with redacted paths, or an empty state.
   - Gaps: unpriced calls, compaction calls without a model, days without counter data.

Times on this page are UTC, because the counter is.

## 9. States

| State | Behaviour |
|---|---|
| No data yet | Each section shows one short line in its body instead of an empty chart. The pace bar still shows the allowance when the counter is known. |
| No budget set | The bar scales to the allowance. The popover omits budget and even pace and shows how to set one (`/spider config set usage.monthlyBudget <credits> --global`). |
| Counter unavailable | Used comes from pi's corrected estimate; the popover says the counter is unavailable. Credits use the last known factor, or published rates when none exists. The Calibration page shows the status. |
| Over pace or over budget | The projection and ring use the danger colour; the popover adds `<n> over at this pace`. |
| Stale data | The freshness dot turns grey after 5 minutes without an ingest; its tooltip and label give the last update time. |
| Unknown session id | "Session not found" with the Back pill. No retry, no spinner. |
| Network or server error | The section shows the error and a Retry pill. Loading indicators always end in data, empty or error. |

## 10. Data definitions

- **Billing month:** the period ending at the counter's reset date (UTC). Without a counter, the
  calendar month in UTC.
- **Used (pace):** the account counter's `credits_used` for the billing month when a snapshot
  exists in it. This counts all Copilot use on the account, including use outside pi; the popover
  says so. Without a counter, pi's corrected month-to-date estimate.
- **Allowance:** the latest snapshot's `entitlement`.
- **Projection:** used plus the average daily rate over the last 7 days (or since the month
  started, when that is shorter) times the days left. The rate comes from counter deltas when
  snapshots cover the window, otherwise from pi's corrected daily totals.
- **Even pace:** budget times the elapsed share of the billing month.
- **Session:** a top-level pi session: one with its own transcript and no owning run. Its credits
  include its own calls, its compaction, its background calls (spider's auxiliary model calls and
  cache-warmer calls), and every subagent run it launched, directly or through pipelines. Calls
  from subagent transcripts whose owning session cannot be resolved roll up into one row named
  "Unattributed runs" (a fixed reserved id), never into a session row of their own.
- **Role buckets:** own calls (the session's own model calls); workers and reviewers (subagent
  runs with those roles); others (scouts, any other subagent role, compaction, background). The
  flow chart splits others into scouts, other runs, compaction and background.
- **Session name:** the latest `/name` value; otherwise the first line of the first user message,
  trimmed to 80 characters and passed through the existing redaction; otherwise the short id.
- **Project:** the repository of the session's working directory: git's main worktree when git
  can resolve it (cached per directory), otherwise the registered repository the ledger recorded,
  otherwise the folder name. Only the name is shown, never a path.
- **Run status:** spider's run statuses are queued, running, paused, done, failed and cancelled.
  Done shows as completed; queued, running and paused show as running. An unknown value is stored
  as null and never blocks ingestion.
- **Idle gap:** more than 5 minutes between consecutive own calls in a session.
- **Time zone:** Overview and Session bucket and label in the browser's time zone (sent to the API
  as an IANA name; UTC when invalid). Calibration uses UTC.

## 11. API

All routes keep the existing server, bootstrap cookie, origin checks and read-only ledger access.

| Route | Returns |
|---|---|
| `GET /api/status` | last ingest, collector, latest counter snapshot time, build id |
| `GET /api/overview?range&from&to&tz&unit&buckets` | pace, buckets by model, ranked models with notes, first page of sessions with role splits, flow |
| `GET /api/sessions?range&from&to&tz&sort&offset&limit` | the full sessions list, paged |
| `GET /api/session/<id>?tz` | header stats, runs with times, status and totals, compaction events, idle gaps with cache-write credits, active periods, models, flow; 404 with a typed body for unknown ids |
| `GET /api/calibration` | correction summary, daily estimate against counter, intervals, rates, unpriced models, ingestion status, errors, gaps |

Removed: `/api/context`, `/api/source-errors`, `/api/explorer`, `/api/filter-values`,
`/api/cache`, `/api/detail-links`, `/api/detail`, `/api/rates`, `/api/reconciliation` (their data
moves into the routes above).

- Bucket keys are the aligned local hour or day starts. The server keeps only the selected keys
  that fall inside the current range and echoes the effective selection; the page rewrites its
  URL to match, so a rolling preset never turns a selection into an error. `range=custom`
  requires `from` and `to`; presets ignore them.
- Every route declares a response cap. The Session route bins own calls per active period
  instead of listing each call, so a session that ran for months stays within its cap.
- A session id the page cannot parse shows "Session not found" without a request.
- Queries reuse canonical call selection (no double counting of raw rows) and the existing daily
  calibration rule. CI asserts index use with EXPLAIN QUERY PLAN rather than wall-clock times.

## 12. Build and serving

- The page has its own Vite build: `vite.dashboard.config.mjs`, with the entry
  `packages/host/src/usage/web/index.html`, writes `dist/dashboard/` (the HTML plus hashed
  script and style files). The extension build no longer builds or embeds the page.
- `npm run build` runs the extension build, then the dashboard build, then the bundle check.
  Neither build deletes the other's output. `dist/` holds `extension.js` and `dashboard/` only.
- Browser code may import only files inside `web/` (type-only imports excepted), as today.
- The server reads the dashboard files once when it starts and serves `/` and exact
  `/assets/<file>` paths from memory, behind the existing cookie. The CSP allows scripts and
  styles from the server itself only, with no inline code; Google Fonts stay allowed for fonts.
- Missing dashboard files give a clear error in `/usage` and `/doctor`.
- `npm run dev:dashboard` serves the page with fixture data for UI work, including a states page
  that renders every component in every state. The states page never ships.

## 13. Ledger schema v4

- `runs_meta` gains the run status.
- A sessions table holds, per session: name and its source, project, first and last activity.
- Ingest fills both as it reads; a one-time backfill reads existing session files for
  `session_info` entries and first messages, and spider's run records for statuses.
- The upgrade is one-way, like v3. Deploys back up the ledger first.

## 14. Settings

- `usage.monthlyBudget`: optional, credits per billing month, a positive number; unset by default.
  Global only, like the other usage keys. Settable in the spider config screen and with
  `/spider config set usage.monthlyBudget <credits> --global`.

## 15. Footer

The footer keeps its context item first and drops the basis markers and the `AIC` label:
`45.2%/200k · 1.2k credits · CH92.1% · month 24% · ↑… ↓… · R… W…`.
`month` is a whole percent of the budget when one is set, otherwise of the allowance.

## 16. Removed

The Explorer, Cache, Run and Context views, the old Detail, Rates and Reconciliation views, the
rail, the routes listed in section 11, and their tests. The nested page build
(`scripts/usage-dashboard-assets.mjs` and its virtual module) and the hand-built browser harness
(`scripts/usage-dashboard-cdp.mjs`, `scripts/usage-dashboard-screenshot.mjs`) with their tests.
The `dimension_values` table stays.

## 17. Testing and verification

- Test-driven per task: unit tests for rollups, role buckets, session names, projects, run status,
  idle gaps, pace and projection, time zones and bucket sizes; API contract tests including the
  404 body; DOM tests for each page and state; keyboard paths for the route, the day selection and
  the pace popover; redaction tests for session names.
- Browser tests use Playwright (`@playwright/test` 1.63.0, the one new dev dependency). They
  drive the installed Edge locally and the runner's Chrome in CI, never downloaded browsers, and
  they run in CI. They cover each page's interactions, keyboard paths and the states in
  section 9, and save screenshots of every page and state for review. There are no committed
  pixel baselines; assertions check behaviour and layout.
- Contrast checks for the palette pairs used for text.
- A real-data check on a backup copy of the ledger, reporting aggregates only.
- The Impeccable finish: one detector run on the built page, a fresh finish review with desktop
  screenshots, the review's disposition acted on, then DESIGN.md and `.impeccable/design.json`
  written by the documenter from the built UI.
- Docs: `docs/guide/usage.md` describes the new pages, the budget setting and the footer.
