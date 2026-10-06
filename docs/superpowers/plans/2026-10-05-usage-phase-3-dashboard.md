# Usage Phase 3 Local Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended)
> or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local usage dashboard with calibrated AIC, published estimates, tokens, reconciliation and Phase 2 placeholders.

**Architecture:** A detached same-bundle Node server serves HTML and bounded read-only JSON, with a separate fenced, poll-disabled ingest worker.
Assets are strings in `dist/extension.js`; one calibration service feeds views, footer and doctor.

**Tech Stack:** TypeScript, Node, db-core/better-sqlite3, Vite, DOM/SVG and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-usage-dashboard-design.md`.
Review/resolutions: `.spider/scratch/usage-ui/{PLAN-REVIEW-opus.md,PLAN-NOTES.md}`.
D11 supersedes the spec's published-estimate-only display rule.

## Global Constraints

- No new dependencies, frameworks, chart libraries or workspaces; no `package.json`/lockfile edits, `npm install` or `npm ci`. Emit only `extension.js`.
- Preserve host -> subagents -> db-core and host -> ui; memory never imports models/host. Use pi root imports, floor 0.87.0; check installed declarations.
- Use synthetic roots, never real DB/config/auth/transcripts or model calls. Planning runs no product code/tests/builds/subagents or git mutations; leave changes uncommitted.
- Implementation uses isolated writers/read-only reviewers and owner-reviewed shared changes, never shared source mutants. Orchestrator owns authorized integration/CI.
- Scratch is `.spider/scratch/usage-ui`, never system temp; worker brief paths are absolute. Tracked files contain no private/account data, user paths or em-dashes.

## Review Focus

1. Mid-pass pi arrival restores polling without stale commits (Task 3).
2. Nonce replay, rebound Host and hostile labels/origins reject before data access (2/5b).
3. Content changes invalidate cursors/calibration, but coordination churn does not (0/1/1a/6/7).
4. Reset/account/clock/zero boundaries use compatible intervals and sufficient evidence (1a/8).
5. Launcher death, removed cwd, offline fonts, narrow/keyboard clients and late responses survive or explicitly degrade (4/5b/9/13).

## Decisions

### D1. Accounting

- Use `countedUsageSql` from `schema.ts`: global provenance, report replacement and coverage precede filters.
- Apply call timestamp/session constraints inside the window, using `calls_period_read` or `calls_session_read`. Do not use all-time views or legacy counted selection.
- Preserve overlap, undercount and pending-data uncertainty.
- Prompt tokens = input + cache read + cache write; total tokens = prompt + output. Subsets are not additive totals.
- Keep stored amounts and rate versions immutable. Views contain no fixed rate, model-count or calibration constants.
- Unpriced AIC is `null`; priced zero is `0`; mixed results are a lower bound with an unpriced-call count.
- Every AIC component, axis, rate and pace remains approximate and appears beside tokens. D11 chooses calibrated primary or published fallback.

### D2. Phase boundaries

- `CompositionAvailability` is `{ status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" }`.
- Context, composition, carry and item reuse consume this contract.
- Historical `contextFillPercent` is `null`. Show `Context fill unavailable: historical window not recorded`; Context links to Overview and Session/Run for tokens and AIC, keeping `/api/context` at 0 SELECTs.
- Recorded per-call windows are Phase 2 inputs, not catalogue guesses or live API calls. Footer context fill is unchanged; Task 1a changes its AIC only.
- Exclude Phase 4 insights, what-if tools and alerts, including Overview insights. Retain simple pace reporting.

### D3. Non-sticky ingestion

- Keep the existing ingest lease, commit fences, 120 s TTL and 40 s renewal.
- Dashboard mode releases after every pass, including failure, reopens read-only and enters `standby`.
- Wait 10 s, then observe every 3 s. Pi's lease schedule is unchanged; add no markers or registration protocol.
- Cost: pi follows while the server owns ingest, so nobody polls the counter during that pass.
- Pi reacquires by pass end plus 3 s and resumes polling. Test the poller as well as ownership.
- Server `poll=false` is unconditional, even after `configure(true)`: no auth reads, counter lease or network requests.
- Without pi, the next pass starts at least 60 s after completion. Do not hold the lease while waiting; separate `nextPassAt` from backoff.
- Pi stop or SIGKILL permits immediate takeover within remaining backoff plus 3 s. Keep existing PID/host/TTL rules and fenced stop with a 2 s forced fallback.

### D4. Authorized deviations

- The 60 s discovery/stat skip replaces the unreliable multi-root watcher.
- Outside `usage.db`, write only private lock/guard/startup records and the code-only crash log. Never write markers, assets or transcripts.
- Google Fonts is the sole optional network access, without referrer or usage data. D2 overrides are authorized; no deviation remains undecided.

### D5. Ledger v2 and revision

- Keep shipped v1 SQL/layout. Append an idempotent v2 migration with:
  - `CREATE INDEX IF NOT EXISTS runs_meta_session ON runs_meta(session_id,db_path,id)`.
  - `ledger_metadata` key `call-selection-revision`, initially `0`.
- Only the writable Phase 1 opener migrates. A shipped-v1-shaped synthetic fixture preserves facts/live leases; unknown layouts fail without repair.
- SQLite triggers strictly increase revision on any actual calls, alias/fingerprint, runs, coverage, pending/incomplete reports or selection-affecting import generation/offset/size/completeness change, including old-build writes. No exact once-per-transaction count is required.
- Replay, leases, publication, backfill status, counters, errors, mtime and last-ingest-only writes do not bump. Neither do rollback or fence rejection.
- Reader revision = `instanceId` plus this key, never `PRAGMA data_version`. Counter/error append paging uses stable keys; new snapshots invalidate calibration separately.

### D6. Authentication

- Bind only `127.0.0.1` on a random port, with one exact Host. Reject forwarded headers and noncanonical/non-origin targets; security and routing share one validated path. Enable no CORS.
- Generate a fresh 32-byte secret on every start. Keep it in a 0600 lockfile, never URLs, argv, logs or tool output.
- Only `/usage` launches a browser. Every call/reuse mints a random, single-use 60 s nonce through `GET /local/bootstrap-nonce`.
- That bounded `no-store` route requires Bearer lock-secret authentication with `timingSafeEqual`; reject cookie/browser Origin/fetch metadata.
- It has no ledger, config or path controls. `GET /bootstrap?nonce` consumes atomically before `issuedAt + 60000`, then redirects 303 to clean `/` before assets/fonts. A valid current-instance cookie reuses its session without issuing a new cookie.
- Issue an independent random session cookie: HttpOnly, SameSite=Strict, Path=/ and a port-qualified name. No Domain, Max-Age, Expires or Secure claim over HTTP.
- Cookies are not port-scoped. Document other `127.0.0.1` services' exposure and session lifetime. Instance-secret-bound lookups reject old cookies/nonces. Sweep expired nonces/idle sessions every second and on insert; cap at 64 nonces/32 sessions. Reject mints at the nonce cap; at the session cap, a new bootstrap evicts the least recently used tab session, which recovers by reopening `/usage`.
- Reject foreign/`null` Origins. API fetch metadata is `same-origin` when present; `none` is document/bootstrap-only. Non-browser clients may omit it.
- CSP uses hashes, no unsafe inline/eval, Google CSS/font allowlists and self-only connect/img. Object/base/form/frame sources are none.
- App-added CSS links are allowed, not remote font JavaScript. Use classes/CSSOM, never `setAttribute("style", ...)`. Errors/logs contain fixed codes.

### D7. Process lifetime

- Use current Node, native `bundle.js` or `.mjs` and a direct-main sentinel. No IPC; spawn detached with ignored stdio, `unref()` and its own process group.
- Cwd is private 0700 `usage-server`. Strip `NODE_OPTIONS`, preloads, inspector options and pi identities.
- Validate/consume roots through a fenced 0600 startup record. Authenticated readiness allows 5 s; locks/guards are atomic and instance-fenced.
- Publish atomic 0600 `replace-intent.json` on cold starts and replacements, with a fixed 10 s expiry. Live identity-matched strictly newer intents make launchers yield before minting nonces, replacing or spawning; equal builds do not yield. A stalled live owner or intent reports `usage-server-busy` at the launch deadline.
- Never signal reused PIDs except for authenticated, identity-checked replacement by a strictly newer build. Verify instance/API/build before reuse; report the server's loaded rates/build.
- Embedding prior art supplies spawn/env/capability checks only, not disconnect or parent-death watchdog semantics.
- Survive launcher exit/SIGKILL before/after ready and removed launcher cwd. Private 0600 `crash.log` is code-only, at most 8192 bytes, readable by doctor; unsafe server directories use a private sibling `usage-server-failures` when the parent is private and owned.
- Authenticated idle timeout is 30 min; drain for 2 s, stop the optional participant, close the reader and remove only the owned lock. Heartbeats/rejections are inert.

### D8. Query bounds and performance

- Default to the current UTC month through now. Periods are half-open safe millisecond timestamps, at most 366 days.
- Limits: 16 AND filters, 3 groups, page 50/default or 200/maximum plus lookahead, timeline 200 buckets, daily page 31, top 8 roles plus Other and fixed actors.
- Bounds: labels 160 characters, keys 1024 bytes, prefixes 160 characters, cursors 2048 bytes and query strings 8192 bytes.
- Reject bad/duplicate/unknown parameters before SQL. Use keysets/null ordering, not OFFSET, client aggregation or N+1 queries.
- Use deferred snapshots, releasing before serialization. Caps: JSON 1 MiB, HTML 512 KiB, 600 authenticated requests/minute server-wide across sessions, 120 unauthenticated requests/minute server-wide and 32 sockets. Valid local mint bearers and live instance bootstrap nonces are exempt from unauthenticated admission; cross-site rejections have a separate 120/minute bucket that cannot spend owner admission. Keep-alive is 2 s, at most 100 requests per socket.
- Timeouts are 5 s/10 s, debounce 300 ms and busy 250 ms. Missing-reader retry is at most once per 5 s, never creating a DB. Status uses maintained totals, not health scans.
- Overview materializes its counted window/result once in one statement with `UNION ALL` totals/actor/role branches.
- A separate unfiltered account-month pass ends at a fresh current-month counter timestamp, using `counterSnapshotIsFresh` and persisted cadence. Comparison applies when `start` is the current UTC month start and `end >= now - 60000`.
- Published gap = counter - computed; ratio = computed / counter. Zero/unavailable denominators are `null`.
- Previous-month views retain dated observations, but current comparison/counter pace is `null`. Pace is linear over elapsed month with coverage qualifiers and D11 AIC.
- Budgets apply to the default month, allowing about 200 ms per Phase 1 month pass, not a year-window promise:

| /api/route | SELECT cap | KiB | Local p95 ms |
| --- | --- | --- | --- |
| status | 4 | 8 | 100 |
| source-errors | 1 | 64 | 300 |
| overview | 6, 2 call passes plus one per id-filtered field on a dictionary miss | 512 | 1000 |
| explorer | 1 plus one per id-filtered field on a dictionary miss | 256 | 1000 |
| filter-values | 2 including batched cache-miss id lookups | 64 | 500 |
| detail | 6 plus one per id-filtered field on a dictionary miss | 512 | Session 1000; run 1500 |
| detail-links | 2 | 64 | 300 |
| context | 0 | 8 | 50 |
| cache | 6 | 256 | 1500 |
| reconciliation | 4 | 256 | 1500 |
| rates | 3 | 512 | 750 |

- Exclude BEGIN/COMMIT/revision reads. Separately count calibration misses: one bounded snapshot SELECT and one indexed counted-call pass; hits add no call SELECT.
- CI uses actual SQL, EXPLAIN/counts/caps on 10,000 rows, without ANALYZE. Mutate captured hints/ranges, never shared source.
- Index-drop EXPLAIN runs on the same writable fixture connection inside rollback. A missing-index exception alone is not evidence.
- Local opt-in measures 1M rows/24 months, refuses CI with SKIP/77, and reports ten warmed sequential samples/p95 for the month and measured 366-day case.
- Include cold/warm calibration costs and ambient host load; run no concurrent work of our own. Report overages; failed commands are never samples.

### D9. Diagnostics and cache

- Source-error pages have at most 200 rows: string `sourceLabel`, `projectLabel`, `code`; numeric `count`, `lastCheckedAt`.
- Labels are clamped basenames or `Unknown project`. No raw/checked/encoded paths, including cursors; keyset is rowid plus kind.
- Parse errors use persisted counts; source errors count one current error, not lifetime totals. `lastCheckedAt` is `last_ingest_at`, not error time.
- One indexed correlated project probe supplies labels in the same statement. Labels never become filesystem inputs.
- Phase 1 doctor has aggregates only; Task 13 adds redacted source diagnostics and crash codes.
- Keep the private `<ledger>.explorer-salt` sidecar with the ledger. Unusable salts give `identity-unavailable` (503), cached for 5 s. Deleting a stray publication temp hardlink (`<ledger>.explorer-salt.<24 hex>`) preserves bookmarks; removing an unusable salt lets the next request after the 5 s failure-cache window recreate it without reopening, but invalidates opaque-id bookmarks (`unknown-filter-id`, 400). Reopen only to drop an already loaded salt. Task 13's guide must explain recovery and rebuilding bookmarks. Path labels use `~/` inside normalized home, `…/` plus the last two segments outside, including embedded paths.
- Cache copy is `Sessions with writes and no recorded reads`: bounded candidates, then global counted selection in indexed lifetime session probes.
- Selected reads outside the period count; fork copies/suppressed reports do not. Ongoing/incomplete evidence is provisional, not an item-reuse claim.

### D10. UI

- Follow spec palette/fonts/table parity. Use paired evidence rows, a 176 px rail, stacking at 720 px or less and no overflow at 390 px.
- Try `local()` first; failed `fonts.load()` permits Google CSS, then system fallback. Loading is nonblocking.
- Keyboard access, semantic tables, SVG titles and `aria-live` are required; never steal focus.
- Exact actions: Refresh, Table view, Chart view, Next page, Previous page, Add filter, Clear filters, Retry.
- Refresh queries every 60 s only while visible and active within 5 min. On shutdown show `Run /usage again`; bound retry/abort/disposal.
- Plain DOM throws on unsupported operations and proves no layout behavior. Synthetic CDP-pipe screenshots use `SPIDER_USAGE_BROWSER`; CI/missing browser gives SKIP/77.

### D11. Counter-calibrated AIC

**Estimator**

- The user chose measurement over time and calibration, not a fixed correction.
- Published AIC uses stored pricing/version provenance from `rates.ts` (`copilot-public-2026-10-04`), without repricing history.
- Snapshots arrive every 10 min while pi runs. Billing lags 3 to 5 min; integer AIC is quantized. The account-wide counter includes other clients.
- Inputs are `ts`, `credits_used`, `entitlement`, `remaining`, `reset_date`. Account identity is internal to compatibility checks; raw payloads never leave them.
- Anchor the trailing seven days at the latest valid snapshot. Build consecutive timestamp/stable-key pairs wholly inside that window; do not prorate boundary deltas.
- Split at `reset_date` changes or negative deltas, dropping spanning pairs. Also reject incompatible accounts, invalid values and non-increasing timestamps.
- Use D1 counted calls in each `[earlier.ts, later.ts)` interval. Fit account-wide, without display filters.
- `factor = sum(counter deltas) / sum(computed published-rate AIC)`. Exclude unpriced calls from AIC but count/report them.
- `coveredHours` sums retained non-overlapping spans, excluding rejected gaps. Require 24 h and 500 computed AIC; otherwise return `uncalibrated` with published fallback.
- No anchor or zero denominator is insufficient evidence. Clamp to `[0.05, 2.0]`; an outside raw ratio yields `implausible` and published fallback, not a clamped correction.
- In-range evidence yields `calibrated`. The clamped diagnostic factor and evidence explain implausible results; calibration proves neither exact billing nor completeness.

**Public types**

```ts
export type CalibrationResult = {
  status: "calibrated" | "uncalibrated" | "implausible" | "off";
  factor: number | null;
  windowStart: number | null; windowEnd: number | null;
  coveredHours: number; computedAic: number; counterDelta: number; unpricedCalls: number;
  method: "trailing-7d-ratio";
};
export type AicDisplay = {
  primaryAic: number | null; publishedAic: number | null;
  basis: "calibrated" | "back-applied" | "published";
};
```

- Uncalibrated/off factor is null; implausible factor is clamped diagnostic evidence. Endpoints are null without an anchor; evidence is finite/nonnegative.
- Only calibrated auto mode applies a factor. Otherwise primary equals published. Hoist `CalibrationResult` once per response (Overview uses `calibration`); measures retain primary/published values and basis, with unpriced counts on `UsageMeasure`. Preserve D1 zero/null/lower-bound distinctions.

**Computation and history**

- One bounded snapshot read and one indexed counted-call pass assign calls to pairs; no all-time scans or per-pair queries.
- Evaluate account-wide period endpoints once in a bounded batch per response. Owners publish on generation changes; followers reuse their DTO without scans.
- Memoize per `(latest snapshot rowid, call-selection revision)` within a fixed rate/build reader or worker instance. Lease/error/replay writes do not invalidate. Find the earliest fit in one chronological seven-day sliding pass, using one indexed counted-call query grouped by snapshot pair over accepted snapshot-covered intervals.
- Snapshots are append-only; validate duplicate anchors with stable-key tie rules. Off-to-auto validates the current generation before reuse.
- Rates returns daily trailing factors, at most 31 points/page, each anchored at its last snapshot at/before day end with actual window/status and no fake zero.
- Batch the page plus seven-day lookback in one call pass with prefix/daily aggregates. Cache page/end-day keys within that generation; cursors freeze stable anchors.
- Overview and per-period displays use `at(min(period.end, now) - 1)`. Back-apply the earliest calibrated fit only when the period endpoint is before its anchor, with basis `back-applied`, labelled `calibrated, back-applied`. All other windows without a fit use published with their own `uncalibrated` or `implausible` status. The current footer uses the latest factor.

**Presentation and config**

- Every AIC-displaying view, component and pace consumes `AicDisplay`. Tokens/counts/pi cost/coverage/overlap flags stay unchanged.
- Calibrated primary is labelled `calibrated`, for example `1,234 AIC`, with dynamic legend `calibrated x0.56 over 7 days` and actual window/coverage evidence.
- Show `published estimate` secondary where space permits: tables, Reconciliation, Rates and doctor. Published rates remain estimated; D2 placeholders are unchanged.
- Reconciliation shows counter, published and calibrated per compatible period, keeping published gap/ratio and adding calibrated gap/ratio/status.
- Doctor adds one line with status, factor, UTC window, covered hours, computed AIC, counter delta, unpriced calls and method; comparison retains both amounts.
- Footer shows primary only: `1,234 AIC cal` when calibrated, `~2,222 AIC ?` when uncalibrated/implausible, `~2,222 AIC est` when off. A back-applied fit, if shown, is explained by footer/doctor copy.
- `cal` means calibrated; `?` means unavailable calibration, explained by doctor; `est` means published by config. Preserve rounding, lower-bound `+` and whole-item drop priorities.
- `usage.calibration` is global-only, `auto` default or `off`. Add it to `DEFAULTS` in `packages/host/src/control.ts` through existing `USAGE_DEFAULTS` composition.
- Keep this exact key and Phase 1 three-part dotted-key support, including `usage.counter.poll`. Validation, local rejection/diagnostics and get/unset/source follow Phase 1.
- Reload updates worker/footer/server mode without token reset or browser launch. Server config is known global input, never an HTTP endpoint or browser-supplied path.
- Off skips computation, reports `off` and disables factor history explicitly while keeping published history/rates. Task 1a owns footer integration and 40-200-column parity tests.

## Public contracts

Task 1 freezes `dashboard-contract.ts`, including D11 types and Task 1a service signatures. Query APIs below use
`ctx: DashboardQueryContext`, `slice: Slice` and `page: { limit: number; cursor?: string }` unless otherwise stated.

```ts
export type Period = { start: number; end: number };
export type Dimension =
  | "project" | "repo" | "session" | "actor" | "role" | "agent" | "provider"
  | "model" | "requestedModel" | "thinking" | "run" | "runName" | "phase"
  | "parentRun" | "auxPurpose" | "api" | "day";
export type Filter = { field: Dimension; value: string | null };
export type Slice = Period & { filters: readonly Filter[] };
export type Page<T> = { rows: readonly T[]; nextCursor: string | null };
export type SeriesPoint = Period & { label: string; measure: UsageMeasure };
export type ApiEnvelope<T> = { apiVersion: 1; revision: string; period: Period; generatedAt: number; data: T };
```

- `TokenTotals`/`UsageMeasure` retain D1 fields; add `aicDisplay: AicDisplay`. Overview has top-level `calibration`; breakdowns have `isOther` to distinguish a real role named Other from the bucket. Public-field fixtures pin spec/D1/D2/D8/D9/D11 DTOs, without paths/accounts.
- `CompositionProvider.availability(slice: Slice & { sessionId?: string; runId?: string }): CompositionAvailability` uses D2.
- `DashboardQueryContext` has `db: Db`, `instanceId: string`, `revision: string`, `composition: CompositionProvider`, `now: () => number`, `rates: readonly RateVersion[]` and `status: () => DashboardStatus`.
- It also has `calibration: CalibrationService` and `calibrationMode: "auto" | "off"`.
- `DashboardRoute` is `{ path: string; handle(ctx: DashboardQueryContext, query: URLSearchParams): unknown }`.
- `DashboardReader` has `revision(): string`, `status(): DashboardStatus`, `snapshot<T>(read: (ctx: DashboardQueryContext) => T): T` and `close(): void`.
- `ReaderOptions`: `instanceId`, `now`, `serverBuild`; optional `rates`, `ingestStatus`, `calibrationMode: () => "auto" | "off"`.
- `HttpOptions`: `instanceId`, `serverBuild`, `reader`, `routes`, `html`, `secret`; optional `retryOpenReader`, `ingestStatus`, `onClose`, `now`, `idleMs`.
- `LaunchOptions`: `bundleUrl: string | URL`, `roots: UsageRoots`, `lockFile: string`, `serverBuild: string`.
- `IngestOptions`: `bundleUrl`, `roots`, optional `onSnapshot`. `IngestHandle`: `{ snapshot(): DashboardIngestState; stop(): Promise<void> }`.
- `DashboardIngestState` has four D3 roles including `standby`, and fixed `errorCode: string | null`. Callbacks return named reader/state/clock; close returns `Promise<void>`.

**Wire rules**

- GET/HEAD only, no HEAD body; JSON uses the envelope. Fixed errors are `{ apiVersion: 1, error: { code, message } }`.
- Codes: 400 invalid-query or unknown-filter-id; 401 unauthorized; 403 forbidden; 404 not-found; 405 method-not-allowed; 409 ledger-changed; 413 response-limit; 429 rate-limited.
- 503 codes are ledger-unavailable, identity-unavailable, unsupported-schema and busy; 500 is internal. The reader maps runtime SQLite errors to fixed codes, never raw messages. No ingest/config/reprice/shutdown API.
- Require start/end together; filters are JSON, `groupBy` comma-separated, days UTC. Use `URLSearchParams`; null differs from `Unknown`.
- HMAC-signed base64url cursors contain version/endpoint/revision/queryHash/full key/mac and an optional resolved window. Query mismatch or in-process tampering is 400; changed call content or a previous server instance is 409; counter history freezes stable anchors. Source-error cursors bind to the server instance, not call content, and page live stable `(rowid, kind)` keys.
- Reconciliation rejects filters; source-errors accepts only limit/cursor. Missing ID is 400, nonexistent 404; suppressed representations explain their accounting.

## Verification and step convention

```sh
PLAN_SCRATCH="$PWD/.spider/scratch/usage-ui"
mkdir -p "$PLAN_SCRATCH"/{tmp,npm-cache,npm-logs,reports,screenshots}
gate() {
 env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID \
  TMPDIR="$PLAN_SCRATCH/tmp" npm_config_cache="$PLAN_SCRATCH/npm-cache" npm_config_logs_dir="$PLAN_SCRATCH/npm-logs" npm "$@"
}
case_test() { gate test -- "$TEST" -t "$CASE"; }
visual() {
 env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID \
  TMPDIR="$PLAN_SCRATCH/tmp" node scripts/usage-dashboard-screenshot.mjs --out "$PLAN_SCRATCH/screenshots"
}
```

Each case checkbox records these four separate actions for that named behavior. Set `TEST` to its owning file and
`CASE` to its exact name. Record each action in the task report; do not combine cases.

- [ ] Write the failing test with the listed assertions.
- [ ] Run `case_test`; save behavior FAIL as RED. A tool failure is not RED.
- [ ] Implement only that tested API in owned files.
- [ ] Run `case_test`; save PASS as GREEN before the next case.

Task gates: `gate test -- <listed task tests>`, `gate run typecheck`, then read-only review.
Save counts/evidence to `$PLAN_SCRATCH/reports/task-<id>.md`; leave changes uncommitted.
Fixtures isolate HOME/global/agent roots/TMPDIR; copied bundles set `SPIDER_TEST_FIXTURE_CHECKOUT`.
SIGKILL/await owned survivors; guard `cd` with `|| exit 1`. Task 1's fixture is immutable; 1a/6-8 seed extras locally.
Task 13 alone owns final full-suite/build/visual acceptance.

## Task list and dependencies

- Task 0: Ledger v2 and content revision. Dependencies: none.
- Task 1: Reader, contracts and Overview. Dependencies: 0.
- Task 1a: Counter-calibrated AIC, config, footer and doctor. Dependencies: 1.
- Task 2: HTTP and security. Dependencies: 1.
- Task 3: Non-sticky ingest. Dependencies: 1a.
- Task 4: Detached server. Dependencies: 2, not 3.
- Task 5a: Slash command and packaged entry. Dependencies: 1a, 3, 4.
- Task 5b: Web primitives and Overview. Dependencies: 1a, 5a.
- Task 5c: Screenshot tool. Dependencies: 5b.
- Task 6: Explorer queries. Dependencies: 1a.
- Task 7: Session/Run queries. Dependencies: 1a, including 0 through 1.
- Task 8: Cache/Reconciliation/Rates queries. Dependencies: 1a.
- Task 9: Explorer view. Dependencies: 1a, 5b, 6.
- Task 10: Detail and Context views. Dependencies: 1a, 5b, 7.
- Task 11: Analytical views. Dependencies: 1a, 5b, 8.
- Task 12: API, small query plans and local benchmark. Dependencies: 1a, 5a, 6, 7, 8.
- Task 13: Integration, guide and visual acceptance. Dependencies: 1a, 5c, 9, 10, 11, 12.

## Task 0: Ledger v2 and content revision

**Needs:** none.

**Files:**
- Modify: `packages/host/src/usage/{schema.ts,migrate.ts,ledger.ts}`.
- Create: `packages/host/src/usage/{__tests__/ledger-v2.test.ts,__tests__/fixtures/usage-v1.sql}`.

**Interfaces:**
- Preserve `migrateUsageLedger(db: Db): void` and `assertUsageSchemaVersion(db: Db): void`.

- [x] `v1 upgrades additively and twice is harmless`: Preserve v1 facts, live leases and DDL after two migrations.
- [x] `unknown shipped layout fails without repair`: Preserve unknown and future layouts, bytes and rows.
- [x] `actual selection changes advance revision`: Strictly increase on actual D5 changes, including aliases and old-build writes.
- [x] `coordination and replay leave revision stable`: Keep lease/publication/counter/error/replay revisions stable.

## Task 1: Reader, contracts and Overview

**Needs:** 0.

**Files:** Create these under `packages/host/src/usage/`:
- `dashboard-contract.ts`, `dashboard-reader.ts`, `dashboard-selection.ts`, `query-overview.ts`, `query-source-errors.ts` and `composition-provider.ts`.
- `web/browser.d.ts`.
- `__tests__/{dashboard-contract.test.ts,dashboard-reader.test.ts,query-overview.test.ts,query-source-errors.test.ts}`.
- `__tests__/fixtures/dashboard-ledger.ts`.

**First action:** Add `/// <reference lib="dom" />` to `web/browser.d.ts` and run `gate run typecheck`.
Stop and escalate if this requires a second tsconfig or package change. No such change is authorized.

**Interfaces:**
- Freeze the public contracts. Until Task 1a, return uncalibrated published fallback through its reserved service.
- `openDashboardReader(file: string, options: ReaderOptions): DashboardReader | undefined`.
- Readers on a v1 DB with no `call-selection-revision` key must treat the revision as unavailable, not as a stable cache key.
- `parseSlice(params: URLSearchParams, now: number): Slice`.
- `compileSlice(slice: Slice, scope?: { sessionId?: string; runId?: string }): { sql: string; params: readonly (string | number | null)[] }`.
- `readMeasure(ctx, slice, scope?: { sessionId?: string; runId?: string }): UsageMeasure`.
- `queryOverview(ctx, slice, dailyStart?: number): OverviewData`.
- `querySourceErrors(ctx, page): Page<SourceErrorRow>`.
- `readSourceErrorDiagnostics(db: Db, limit: number): { rows: readonly SourceErrorRow[]; truncated: boolean }`.
- Produce `OVERVIEW_ROUTES` for status, overview, context and errors, and `phase2CompositionProvider`.
- `seedDashboardFixture(ledger: UsageLedger): void`.

- [x] `readonly opener never creates or upgrades`: Leave missing/v1/future ledgers untouched; open v2 with `query_only`.
- [x] `snapshot revision tracks only call content`: Keep lease/publication cursors valid; expose changed content in the next snapshot.
- [x] `matches Phase 1 period selection`: Match `summarize` for fork, coverage and report totals.
- [x] `Overview materializes its slice once`: Reconcile totals/actor/role/Other from one materialized window.
- [x] `month comparison ends at counter timestamp`: Computed 12 and counter 10 give gap -2 and ratio 1.2, unfiltered. Old-month counter pace is null.
- [x] `status separates ingest and counter freshness`: Test four roles, ingest staleness after 120 s and independent counter freshness.
- [x] `source errors are bounded and path-redacted`: Page 450 errors without path/cursor leaks.

## Task 1a: Counter-calibrated AIC, config, footer and doctor

**Needs:** 1.

**Files:**
- Create: `packages/host/src/usage/{calibration.ts,aic-display.ts,__tests__/calibration.test.ts,__tests__/aic-display.test.ts}`.
- Modify: `packages/host/src/usage/{dashboard-reader.ts,query-overview.ts,ledger.ts,config.ts,protocol.ts,runtime.ts,worker-entry.ts,mount.ts,doctor.ts}`.
- Modify: `packages/host/src/control.ts`.
- Modify: `packages/host/src/usage/{footer.ts,footer-state.ts}` only for typed AIC inputs and presentation; preserve accumulation and token accounting.
- Test: `packages/host/src/usage/__tests__/{dashboard-contract.test.ts,query-overview.test.ts,config.test.ts,config-tool.test.ts}`.
- Test: `packages/host/src/usage/__tests__/{footer-layout.test.ts,footer-state.test.ts,doctor.test.ts,runtime.test.ts,worker-entry.test.ts}`.
- Regression: `packages/host/src/__tests__/control.test.ts` and `packages/host/src/__tests__/slash.test.ts`.

**Interfaces:**
- `createCalibrationService(db: Db, options: { revision: () => string }): CalibrationService`.
- `CalibrationService.current(mode: "auto" | "off"): CalibrationResult`.
- `CalibrationService.at(windowEnd: number, mode: "auto" | "off"): CalibrationResult`.
- `CalibrationService.atMany(windowEnds: readonly number[], mode: "auto" | "off"): readonly CalibrationResult[]` batches historical endpoints in one indexed pass.
- `CalibrationService.history(period: Period, page: { limit: number; cursor?: string }, mode: "auto" | "off"): Page<CalibrationHistoryPoint>`.
- `CalibrationHistoryPoint` is `{ day: number; calibration: CalibrationResult }`.
- `toAicDisplay(publishedAic: number | null, unpricedCalls: number, calibration: CalibrationResult): AicDisplay`.
- `UsageLedger.getCalibration(mode: "auto" | "off"): CalibrationResult` reuses the ledger connection.
- Add optional `calibration?: CalibrationResult` to worker events/runtime snapshots; old DTOs fall back.
- Add optional mode to start/configure commands and the second argument of `UsageRuntime.start(poll)`/`configure(poll)`; preserve old callers.
- Add `calibration: "auto" | "off"` to `UsageConfig` using D11 config conventions.
- `FooterInput` adds optional calibration; call `toAicDisplay` without changing `FooterAccumulator` totals.
- Keep `usageDoctorLines(snapshot, config, diagnostics?)` pure.
- Readers/workers share helpers; pi-main/footer/doctor open no DB.

**Tests:** Use `calibration.test.ts` unless a file is named.

- [x] `calibration uses counted interval calls`: Exclude copies/covered reports; count boundaries once. At 24 h, computed 1000 and counter 560 give factor 0.56 and status `calibrated`.
- [x] `calibration drops reset-spanning pairs`: Reset-date changes and negative deltas exclude spanning calls/deltas/hours; retain valid later pairs.
- [x] `calibration requires covered span and priced evidence`: 23.99 h or 499.99 AIC fails; 24 h and 500 AIC passes. Rejected gaps do not count; no anchor/zero gives null.
- [x] `calibration rejects implausible ratios`: 0.05 and 2.0 pass; 0.049 and 2.01 clamp but fall back, with status `implausible` and doctor evidence.
- [x] `calibration tolerates five minute billing lag`: Seven days of steady priced calls, 10 min snapshots and integer credits: shifting billing 5 min changes the factor by less than 1%.
- [x] `calibration excludes and reports unpriced calls`: Count unpriced calls but exclude their AIC; preserve mixed lower bounds and fail all-unpriced evidence.
- [x] `calibration cache invalidates only on evidence changes`: New snapshot/call revision recomputes; leases/publication/errors/replay do not. Off-to-auto checks generation.
- [x] `calibration history batches daily trailing windows`: Use each day's own window/status, at most 31 points and one bounded call pass; preserve reset/account/clock gaps.

**Integration cycles:**

- [x] `aic-display.test.ts`: `all AIC displays share calibration fallback`: Scale AIC only when calibrated; preserve D1 tokens/counts/pi cost/coverage/null/zero/lower bounds and all
  fallbacks.
- [x] `query-overview.test.ts`: `Overview calibration is account wide`: Filters leave factor unchanged; all branches expose primary/published AIC and unchanged tokens.
- [x] `config.test.ts`: `calibration config is global only auto by default`: Test auto default, auto/off, invalid values and ignored local overrides.
- [x] `config-tool.test.ts`: `calibration config preserves dotted key conventions`: Test get/set/unset/source, local rejection and existing `usage.counter.poll` parsing.
- [x] `runtime.test.ts` and `worker-entry.test.ts`: `calibration DTO preserves old snapshots and reloads`: Old DTOs fall back; owners publish without revision churn, followers reuse,
  and reload preserves polling/tokens.
- [x] `footer-layout.test.ts`: `footer calibration markers fit forty to two hundred columns`: Every width from 40 to 200 fits whole primary-only items: `cal`, `?` for both unavailable
  statuses and `est` when off.
- [x] `footer-state.test.ts`: `footer calibration leaves token parity unchanged`: Auto/off/factor changes preserve all Phase 1 parity cases and published append/reset totals.
- [x] `doctor.test.ts`: `doctor reports calibration evidence and fallback`: Add one complete D11 evidence line and both AIC amounts; make fallback explicit without account identity.

## Task 2: HTTP and security

**Needs:** 1.

**Files:** Create `packages/host/src/usage/{server-security.ts,server.ts,__tests__/{server-security.test.ts,server.test.ts}}`.

**Interfaces:**
- `startUsageHttpServer(options: HttpOptions): Promise<{ pid: number; port: number; close(): Promise<void> }>`.
- `validateTransport(req: IncomingMessage, port: number, path: string): boolean` (Host/origin/metadata only; supply the parsed canonical path). Protected resources use one instance-local `requireSession` cookie gate.

- [x] `binds only authenticated IPv4 loopback`: Use IPv4/random port; unauthenticated resources return 401.
- [x] `local nonce mint requires lock secret`: Reject cookie/browser minting; accept the authenticated local channel.
- [x] `bootstrap nonce is single use and short lived`: Return 303; reject replay/expiry; issue an independent D6 cookie.
- [x] `Host rebinding fails before reader access`: Reject malformed/duplicate/missing Host before reader access.
- [x] `API accepts only same-origin fetch metadata`: Reject API `none`; permit document `none`.
- [x] `authenticated admission is bounded`: Request 601 returns 429; oversized output returns valid 413.

## Task 3: Non-sticky ingest

**Needs:** 1a.

**Files:**
- Create: `packages/host/src/usage/{server-ingest.ts,__tests__/server-ingest.test.ts,__tests__/fixtures/dashboard-ingest.mjs}`.
- Modify: `packages/host/src/usage/{protocol.ts,runtime.ts,worker-entry.ts,__tests__/{runtime.test.ts,worker-entry.test.ts}}`.

**Interfaces:**
- Add optional `dashboardMode?: boolean`, default false, to `UsageRuntimeOptions` and the start command; expose a standby event.
- `startUsageServerIngest(options: ServerIngestOptions): IngestHandle`, with required `getCalibrationMode: () => "auto" | "off"`.

- [x] `server worker always disables polling`: Never read auth, fetch or acquire counter, even after configure.
- [x] `server never holds ingest across passes`: Release after success/failure, then standby for 10 s.
- [x] `running pi reacquires within one pass plus three seconds`: Pi owns ingest by pass end plus 3 s; no duplicate ingestion.
- [x] `handback restores pi counter polling`: Followers cannot poll; pi polls after handback.
- [x] `server takes over after pi stops or dies`: Stop/kill permits takeover within remaining backoff plus 3 s.
- [x] `unattended ingestion keeps minute cadence`: Next pass starts after completion plus 60 s, without retained ownership.

Graceful stop retries any pending lease release once and reports whether release completed. After termination, only the dashboard parent may perform fenced release-style cleanup of ingest and counter ownership, preserving schedules and diagnostics. If cleanup remains busy, or in pi mode where the main thread never opens the ledger, TTL/PID recovery applies. First-open failures retry from 3 s with exponential backoff capped at 60 s; unsupported schema failures use the cap immediately. Calibration getter failures retain the last good mode (off before the first successful read) and report `usage-calibration-config-failed`; stopping clears the reload timer.

## Task 4: Detached server

**Needs:** 2, not 3. Minimal HTTP/Overview works without an ingest participant.

**Files:**
- Create: `packages/host/src/usage/{server-lock.ts,server-runtime.ts,server-entry.ts}`.
- Create: `packages/host/src/usage/{__tests__/{server-lock.test.ts,server-runtime.test.ts,server-entry.test.ts},__tests__/fixtures/dashboard-process.mjs}`.
- Modify: `packages/host/src/extension.ts`, limited to the module-scope entry guard and exports.

**Interfaces:**
- `readUsageServerCrashCodes(dir: string): Promise<readonly string[]>`.
- `UsageServerLock` contains `version: 1`, `instanceId: string`, `pid: number`, `port: number | null`, `secret: string`, `processIdentity` and `serverBuild`.
- `UsageServerLaunchOptions = LaunchOptions & { calibrationMode: "auto" | "off"; calibrationConfigFile?: string }`.
- Build IDs are `<sha>@<ISO time>`. Task 5a MUST pass the bundle's own `${LOADED_BUILD.sha}@${LOADED_BUILD.builtAt}`, the same constant `/doctor` shows. Any other label disables upgrades; an unparseable launcher ID logs `usage-server-build-invalid` once.
- `ensureUsageServer(options: UsageServerLaunchOptions): Promise<{ pid: number; port: number; bootstrapUrl: string; reused: boolean; serverBuild: string; rateVersions: readonly string[] }>`.
- `bootUsageServer(options: UsageServerLaunchOptions & { instanceId: string; startParticipant?: () => IngestHandle }, testHook?: { now?: () => number; idleMs?: number }): Promise<void>`.
- `runUsageServerEntry(moduleUrl: string | URL, hooks?: { startParticipant?: () => IngestHandle; testHook?: { now?: () => number; idleMs?: number } }): Promise<void>`.

- [x] `concurrent launchers reuse only authenticated owner`: Reuse authenticated PID/port with fresh nonces; only an authenticated, identity-matched strictly older build may be signalled for replacement.
- [x] `server survives launcher exiting`: Survive exit/kill before/after ready and deleted launcher cwd.
- [x] `new start rotates secret and rejects old session`: Rotate secret; reject previous cookies/nonces.
- [x] `startup files are bounded and fenced`: Enforce private permissions, bounds, symlink rejection and stale/corrupt instance fencing.
- [x] `import and worker entry are inert`: Start HTTP only with the direct-main sentinel.
- [x] `private crash log contains only codes`: Fixed codes, at most 8192 bytes, never tokens.

## Task 5a: Slash command and packaged entry

**Needs:** 1a, 3, 4.

**Files:**
- Create: `packages/host/src/usage/{api-routes.ts,dashboard-command.ts,web/assets.ts}` and `scripts/usage-dashboard-assets.mjs`.
- Create: `packages/host/src/usage/__tests__/{dashboard-command.test.ts,dashboard-assets.test.ts,dashboard-bundle.test.ts}`.
- Modify: `packages/host/src/usage/{server-entry.ts,web/browser.d.ts}`, `packages/host/src/extension.ts` and `vite.config.mjs`.
- Test: `packages/host/src/__tests__/slash.test.ts`.

**Interfaces:**
- `registerUsageDashboardCommand(pi: ExtensionAPI, bundleUrl: string | URL): void`, for `/usage` only.
- Initially `DASHBOARD_ROUTES = OVERVIEW_ROUTES`; import `DASHBOARD_HTML` from `virtual:spider-usage-dashboard`.
- Vite uses `configFile: false`, `write: false`, IIFE output and inline CSS; preserve SSR externals and watch support.
- Resolve roots through `mount.ts`; lock and guard live under `join(paths.globalRoot, "usage-server")`.
- Produce a minimal D11 primary-AIC/token page and connect the Task 3 participant hook.
- The bundle test or a check asserts no non-browser host or worker source references `document` or `window`; the DOM lib reference applies program-wide.

- [ ] `only usage slash can open browser`: Reject control/lifecycle launch and child sessions.
- [ ] `reuse command mints a new nonce`: Reused PID produces a fresh nonce URL.
- [ ] `browser assets stay inside one bundle`: Browser graph has no Node/pi/DB imports, runtime Vite or extra dist assets.
- [ ] `packaged slice works without source checkout`: Test `extension.js` alone, poisoned links and native/shim fixtures; no host browser imports.

## Task 5b: Web primitives and Overview

**Needs:** 1a, 5a.

**Files:**
- Create: `packages/host/src/usage/web/{app.ts,views.ts,client.ts,dom.ts,charts.ts,tables.ts,format.ts,fonts.ts,overview.ts,theme.css}`.
- Create: `packages/host/src/usage/{__tests__/{web-primitives.test.ts,web-overview.test.ts},__tests__/fixtures/plain-dom.ts}`.
- Modify: the browser asset entry in `scripts/usage-dashboard-assets.mjs`, after Task 5a.

**Interfaces:**
- `ViewRoute.view` is `"overview" | "explorer" | "session" | "run" | "context" | "cache" | "reconciliation" | "rates"`.
- Other route fields are optional `id: string`, `period: Period` and `filters: readonly Filter[]`.
- `ViewContext` contains `document: Document`, `root: HTMLElement`, `client: DashboardClient`, `period`, `filters` and `signal: AbortSignal`.
- `ViewContext.navigate(route: ViewRoute): void`; `MountedView` is `{ dispose(): void }`.
- `DashboardClient.get<T>(path: string, params: URLSearchParams, signal: AbortSignal): Promise<ApiEnvelope<T>>`.
- `ChartPoint` contains `start: number`, `end: number`, `label: string`, `value: number | null`, `tokens: TokenTotals | null` and optional `note: string`.
- `chartWithTable(document: Document, options: { title: string; points: readonly ChartPoint[]; unit: ChartUnit }): HTMLElement`.
- `ChartUnit` is `"estimated-aic" | "calibrated-aic" | "tokens" | "percent" | "ratio"`; retain `estimated-aic` for published fallback.
- `renderTable(document: Document, options: { caption: string; columns: readonly string[]; rows: readonly (readonly (string | HTMLElement)[])[] }): HTMLTableElement`.
- Keep `formatEstimatedAic(value: number | null, unpricedCalls: number): string` for published secondary formatting.
- Add `formatAicDisplay(display: AicDisplay, unpricedCalls: number, calibration: CalibrationResult): { primary: string; secondary: string; legend: string }`, using D11 copy and markers.
- `formatTokens(value: number): string`; `mountOverview(ctx: ViewContext): Promise<MountedView>`.

- [ ] `chart table has identical observations`: Share points, AIC basis and tokens; preserve keyboard focus.
- [ ] `hostile labels remain text`: Keep payloads inert, with no HTML/style attributes.
- [ ] `fonts load locally before conditional link`: Local success adds no link; failure stays readable.
- [ ] `Overview pairs estimates and tokens`: Pair actor/role/pace primary AIC with tokens, legend and table secondary; no insights.
- [ ] `Overview health separates ages and errors`: Keep roles/ages/error paging independent.

## Task 5c: Screenshot tool

**Needs:** 5b.

**Files:**
- Create: `scripts/usage-dashboard-screenshot.mjs`.
- Create: `packages/host/src/usage/__tests__/{visual-script.test.ts,dashboard-visual.test.ts}`.
- Create: `packages/host/src/usage/__tests__/fixtures/dashboard-browser-fixture.ts`.

**Interfaces:**
- CLI uses `SPIDER_USAGE_BROWSER` and `--out`; the exported capture helper is inert on import.
- Use Node-only, null-delimited CDP with remote-debugging-pipe, headless mode and a new scratch profile.
- CLI runs installed Vitest `dashboard-visual.test.ts`; the test imports the helper, without CLI recursion.
- Use a synthetic bundle and block network access.

- [ ] `CI and missing browser skip explicitly`: Emit SKIP/77 and a regular-suite skip reason.
- [ ] `capture errors fail and close owned processes`: Return nonzero on errors and close all fixtures.
- [ ] `real Overview chart toggles to table`: Capture 1440x1000 PNG and verify toggle/parity.

## Task 6: Explorer queries

**Needs:** 1a.

**Files:** Create `packages/host/src/usage/{query-explorer.ts,__tests__/query-explorer.test.ts}`.

**Interfaces:**
- `queryExplorer(ctx, query: ExplorerQuery): ExplorerData`.
- `queryFilterValues(ctx, slice, field: Dimension, prefix: string, limit: number, cursor?: string): Page<FilterValue>`. Produce `EXPLORER_ROUTES`.

- Task 6 owns `dashboard-identities.ts`, the shared helper for Tasks 7/8. Keys are dimension-scoped opaque HMAC ids except session/run, which use stored ids matching `^[A-Za-z0-9._:-]{1,128}$`; unsupported ids still count, carry no key and label `unsupported id`. Filter-values rows are `{id, label}` (null stays null), with an informational `count` for unsupported ids. Missing values are `{id: null, label: null}` rows, shown as Unknown and selectable with `{field, kind: "missing"}` (SQL IS NULL, counted against the 16-filter cap). Unsupported-id count rows have a non-null label and no filter action; explicit null-id and raw null filters reject with 400. Discovery filters explicitly use `kind: "id"`, never inferred from shape.
- Persist a private 0600 ledger-adjacent salt across restarts with exclusive atomic publication; refuse symlinks, nonregular/multiply linked or foreign-owned files. Skip the mode check on win32. Hash distinct values after grouping, never per row; resolve explicit ids through per-revision/period distinct caches using `calls_period_read`, never decode paths from client tokens.
- Normalize HOME through realpath and remove trailing separators; replace its prefix on a separator boundary with `~`, keeping worktrees distinguishable. Outside-home paths use `…/` plus the last two segments. Redact embedded POSIX/drive/UNC paths including after `=`, `[`, a backtick or comma, preserving `file:`. Clamp labels to 160 code points.
- Sort Explorer null-first by its full identity tuple; typeahead sorts case-insensitively by label then id, bounded and keyset-paged. Sign cursors with a process-private instance secret; bind canonical filters and carry the resolved first-page window when end is omitted.
- Shorten pages to their byte budgets with a continuation cursor. Prefixes are literal and ASCII-case-insensitive; non-ASCII case remains significant.

- [x] `every attribution pivot reconciles`: All dimensions and 2-3 groups reconcile published/calibrated totals, tokens and unpriced counts.
- [x] `filter values continue safely`: Page 450 values with literal LIKE wildcards.
- [x] `cursor belongs to complete query and content`: Stable ties; query mismatch 400, changed content 409, lease changes valid.

## Task 7: Session/Run queries

**Needs:** 1a.

**Files:** Create `packages/host/src/usage/{query-detail.ts,__tests__/query-detail.test.ts}`.

**Interfaces:**
- `queryDetail(ctx, query: DetailQuery): DetailData`.
- `queryDetailLinks(ctx, query: DetailQuery): DetailData["links"]`. Produce `DETAIL_ROUTES`; reporting session differs from child transcript.

- [ ] `timeline covers all selected calls`: Page exactly 450 calls, 200 per page, with at most 200 full-timeline buckets; preserve AIC and token totals.
- [ ] `covered run explains report representation`: Explain coverage, not priced zero.
- [ ] `session links use migrated index and correct identity`: Page nested/ongoing/deduplicated links using the v2 session index.

## Task 8: Cache/Reconciliation/Rates queries

**Needs:** 1a.

**Files:**
- Create: `packages/host/src/usage/{query-cache.ts,query-reconciliation.ts,query-rates.ts}`.
- Create: `packages/host/src/usage/__tests__/{query-cache.test.ts,query-reconciliation.test.ts,query-rates.test.ts}`.

**Interfaces:**
- `queryCache(ctx, slice, page, dailyStart?: number): CacheData`.
- `queryReconciliation(ctx, period: Period, options: { bucket: "day" | "month" | "snapshot"; limit: number; cursor?: string }): ReconciliationData`.
- `queryRates(ctx, slice, page): RatesData`; produce `ANALYSIS_ROUTES`.
- Inject `COPILOT_RATE_VERSIONS`; do not edit `rates.ts`.
- Reconciliation preserves published fields and adds `calibratedAic`, `calibratedGap`, `calibratedRatio` and the period-end `CalibrationResult`.
- Batch period ends with `atMany`; never query per row. Missing calibration leaves calibrated fields `null` and primary published.
- Rates returns `factorHistory: Page<CalibrationHistoryPoint>`, plus current calibration, primary/published summaries and immutable rate provenance.
- Use its existing page cursor to bound the daily history to 31 points; the cursor freezes a stable counter anchor and binds the slice and call revision.

- [ ] `hit rate weights selected prompt tokens`: Weight cache read by prompt tokens; zero denominator is null. Keep warmer use separate and token weights unchanged.
- [ ] `fork-copy reads do not defeat no-read observation`: Ignore copied/suppressed reads; count native selected lifetime reads.
- [ ] `reconciliation pairs actual compatible anchors`: Computed 12 and counter 10 give published gap -2 and ratio 1.2; use actual periods/older anchors and period-end calibration, never a future
  fit.
- [ ] `reset account and clock boundaries are explicit`: Reset/account/clock/zero remain explicit or null in both comparisons.
- [ ] `rates preserve stored amounts and provenance`: Metadata changes do not reprice calls; factor history uses bounded Task 1a results/status gaps.

## Task 9: Explorer view

**Needs:** 1a, 5b, 6.

**Files:** Create `packages/host/src/usage/{web/explorer.ts,__tests__/web-explorer.test.ts}`.

**Interfaces:**
- `mountExplorer(ctx: ViewContext): Promise<MountedView>`.

- [ ] `typeahead debounces twenty characters`: 20 fast keys yield one request after 300 ms; cancellation rejects stale results.
- [ ] `pivot cells drill into exact tuples`: Keyboard null/Unknown drill-in preserves slice and chart/table AIC/token parity.

## Task 10: Detail and Context views

**Needs:** 1a, 5b, 7.

**Files:** Create `packages/host/src/usage/{web/{detail.ts,context.ts},__tests__/{web-detail.test.ts,web-context.test.ts}}`.

**Interfaces:**
- `mountDetail(ctx: ViewContext & { kind: "session" | "run"; id: string }): Promise<MountedView>`.
- `mountContext(ctx: ViewContext): Promise<MountedView>`. Show latency/subsets only when recorded.

- [ ] `timeline is independent of call pagination`: Next call page leaves timeline observations/basis unchanged.
- [ ] `historical fill and composition remain unavailable`: Keep exact D2 copy and no fake zero; Context links to Overview and Session/Run for tokens and primary AIC. Detail keeps aggregate, covered and unpriced explanations beside those measures.

## Task 11: Analytical views

**Needs:** 1a, 5b, 8.

**Files:** Create `packages/host/src/usage/{web/{cache.ts,reconciliation.ts,rates.ts},__tests__/{web-cache.test.ts,web-reconciliation.test.ts,web-rates.test.ts}}`.

**Interfaces:**
- `mountCache(ctx: ViewContext): Promise<MountedView>`.
- `mountReconciliation(ctx: ViewContext): Promise<MountedView>`.
- `mountRates(ctx: ViewContext): Promise<MountedView>`.

- [ ] `Cache describes session observations not item reuse`: Show provisional session evidence/D2, not item claims; pair primary component AIC with tokens.
- [ ] `Reconciliation displays matched endpoints and signed gap`: Show published gap -2 and ratio 1.2 for computed 12/counter 10, plus calibrated comparison; never plot null as zero.
- [ ] `Rates renders changing metadata without constants`: Render dynamic tiers, aliases, dates and unpriced evidence, with daily factor parity. Off mode preserves published amounts.

## Task 12: API, small query plans and local benchmark

**Needs:** 1a, 5a, 6, 7, 8.

**Files:**
- Modify: `packages/host/src/usage/api-routes.ts`.
- Create: `packages/host/src/usage/{__tests__/{dashboard-api.test.ts,dashboard-perf.test.ts},__tests__/fixtures/dashboard-plan.ts}`.
- Create: `scripts/usage-dashboard-benchmark.mjs`.

**Interfaces:**
- Concatenate `OVERVIEW_ROUTES`, `EXPLORER_ROUTES`, `DETAIL_ROUTES` and `ANALYSIS_ROUTES`.
- `seedPlanLedger(file: string, rows: number): { periods: readonly Period[]; sessionId: string; runId: string; expected: Record<string, number> }`.
- Seed 10,000 rows; locally benchmark 1,000,000 across 24 months. Count calibration misses/hits separately.

- [ ] `all routes preserve wire and read-only boundary`: Check D6 headers, auth, HEAD, errors, caps and shared AIC DTOs; allow no writes or account identity.
- [ ] `small fixture plans enforce range access`: Require range/session/metadata indexes, calibration miss/hit counts and one-pass history; no call scan.
- [ ] `range-predicate and hint mutants are meaningful`: Fail the plan oracle, not a missing-index exception.
- [ ] `million row timing is local opt in only`: CI/unset gives SKIP/77; failures are never samples.

## Task 13: Integration, guide and visual acceptance

**Needs:** 1a, 5c, 9, 10, 11, 12.

**Files:**
- Modify: `packages/host/src/usage/web/{views.ts,app.ts,theme.css}`.
- Modify: `scripts/usage-dashboard-screenshot.mjs` and `docs/guide/usage.md`.
- Modify: `packages/host/src/usage/__tests__/{dashboard-bundle.test.ts,dashboard-visual.test.ts,visual-script.test.ts}`.
- Modify: `packages/host/src/usage/{doctor.ts,mount.ts,ledger.ts,protocol.ts,runtime.ts,worker-entry.ts}`.
- Modify: `packages/host/src/usage/__tests__/doctor.test.ts` and the doctor await in `packages/host/src/extension.ts`.
- Create: `packages/host/src/usage/__tests__/web-app.test.ts`.

**Interfaces:**
- Attach all views and hash state.
- Publish optional `sourceErrorDiagnostics`: at most 20 D9 rows plus truncation in protocol/runtime snapshots.
- `UsageLedger.getSourceErrorDiagnostics(limit: number)` reuses Task 1's helper and returns rows plus truncation.
- Preserve pure `usageDoctorLines(snapshot, config, diagnostics?)` and D11 output.
- `diagnostics` contains `sourceErrors: readonly SourceErrorRow[]`, `truncated: boolean` and `serverCodes: readonly string[]`.
- Make `mount.doctor` async to read bounded crash codes; the extension's `handleControl` awaits it.
- Follower copy says another ingest participant. Source counts are recorded/current, not a lifetime total.

- [ ] `navigation disposes old view and preserves selection`: Routes/back preserve slice and dispose old fetches.
- [ ] `hidden abandoned tabs stop refreshing`: Hidden/inactive for 5 min stops fetch; reopen uses bounded refresh.
- [ ] `doctor shows bounded redacted source diagnostics`: At most 20 code/count/label rows, no paths; truncation points to `/usage`; retain calibration line.
- [ ] `doctor explains failed startup without secret`: Codes only, never corrupt startup bytes.
- [ ] `real browser all-view acceptance has no overflow`: Verify desktop/narrow parity, keyboard access and no overflow in all calibration states, Rates history and three-way Reconciliation.

## Test ownership and integration commands

`TEST` is the owning `.test.ts` path in each task's Files block; `CASE` is the exact case name.
Multi-file case ownership:

- Task 1: reader first two; Overview next four; errors last. Task 1a cases name their owning file.
- Task 2: security owns nonce/Host/metadata; server owns binding/admission. Task 3: server-ingest owns the six cases.
- Task 4: lock owns reuse/files; entry owns inert import; runtime owns the rest.
- Task 5a: command first two, assets third, bundle last. Task 5b: primitives first three, Overview rest. Task 5c: script first two, visual last.
- Task 8: Cache first two, Reconciliation next two, Rates last. Task 11 uses each named view's file.
- Task 12: API first, perf rest. Task 13: app first two, doctor next two, visual last.

Additional cases follow the same cycle in their owning task:

- `dashboard-contract.test.ts`: `invalid slice fails before SQL`, test the D8 validator.
- `dashboard-contract.test.ts`: `tokens do not double-count subsets`, 10 input + 20 read + 30 write + 10 output gives prompt 60/total 70.
- `dashboard-contract.test.ts`: `empty unpriced and priced zero remain distinct`, test D1 for both AIC figures.
- `dashboard-contract.test.ts`: `phase two availability touches no context tables`, test D2.
- `query-overview.test.ts`: `daily chart windows preserve aggregate totals`, test D8 paging/D11 parity.
- `server.test.ts`: `idle deadline resets only for authenticated requests`, alive at 1799999 ms, closed at 1800000 ms.
- `server.test.ts`: `database unavailable keeps identity usable`, status 200, data 503, read-only retry.
- `server-entry.test.ts`: `idle and signals stop optional participant`, one stop and lease release.
- `web-context.test.ts`: `Context exact unavailable copy`, test D2.

Regression suites: Task 0 ledger/lease; Task 1 ledger-counting/ledger-round4; Task 1a all listed existing tests;
Task 3 runtime/worker-entry/lease/counter; Task 5a build/slash/extension-shim/worker-bundle.

Local benchmark:

```sh
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID \
 TMPDIR="$PLAN_SCRATCH/tmp" SPIDER_USAGE_BENCHMARK=1 node scripts/usage-dashboard-benchmark.mjs --out "$PLAN_SCRATCH/reports/benchmark.json"
```

Task 13 final acceptance:

- [ ] Document D1-D11 in `docs/guide/usage.md`: cookie/nonce risks, handback cost, watcher deviation and local commands.
- [ ] Include auto/off, footer markers, account-wide limits, evidence gates/history and published fallback, without account data.
- [ ] Verify bundled routes, pi-server-pi handback, zero server polling and idle release.
- [ ] Capture eight routes at 1440x1000 and Overview/Explorer/Session at 390x844; check keyboard/parity/error paging/overflow/local and blocked fonts.
- [ ] Run `gate run typecheck` and targeted plus affected slash/extension-shim/controller/worker-bundle tests; save counts.
- [ ] Run full `gate test` once; rerun only exec-timing failures once and disclose both.
- [ ] Run `gate run build`; only `extension.js` is emitted.
- [ ] Run `gate test -- packages/host/src/usage/__tests__/dashboard-bundle.test.ts` against the fresh bundle.
- [ ] Run `visual`, inspect/critique PNGs; 77 is missing acceptance. Report benchmark overages/load.
- [ ] Check no survivors or private-data/token/path/dependency leaks; obtain fresh orchestrator read-only review.
- [ ] Make no git mutations; report skips and billing limitations as concerns.

## Parallel-worktree map and shared ownership

Use one writer/worktree per task. Integrate reviewed dependencies; reviewers are read-only.

| Stage | Parallel lanes | Ownership transfer |
| --- | --- | --- |
| Foundations | 0, then 1 | Task 1 freezes contracts/fixture. |
| Calibration/security | 1a and 2 after 1 | 1 -> 1a: reader/Overview. |
| Runtime/queries | 3, 6, 7, 8 after 1a; 4 after 2 | 1a -> 3: protocol/runtime/worker entry. |
| Packaged slice | 5a after 1a, 3, 4 | 4 -> 5a: server entry/extension. |
| Web primitives | 5b after 1a, 5a | 5a -> 5b: browser asset entry. |
| Views/tools/API | 5c, 9, 10, 11, 12 after listed needs | 5a -> 12: API registry. |
| Acceptance | 13 after listed needs | 5b -> 13: app/theme; 3 -> 13: worker diagnostics; 5c -> 13: screenshots. |

- Task 1a owns `footer.ts`, `footer-state.ts`, `footer-layout.test.ts`, `footer-state.test.ts` and config/control. No parallel edits.
- Task 1a -> 13 transfers doctor/mount/ledger diagnostics; footer fixes need 1a review and both parity suites.
- Tasks 1a/6-8 never edit Task 1's fixture. Shared fixes need owner review.
