# Usage Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the usage dashboard with Overview, whole-session detail, and Calibration & data, backed by attributable, billing-corrected credits and optional monthly pacing budgets.

**Architecture:** Keep the vanilla TypeScript/SVG page, authenticated loopback server, read-only reader and existing calibration engine. Build the extension and browser dashboard separately; the server loads packaged HTML and hashed assets once, then serves exact authenticated paths from memory. Add an immutable v4 ledger migration and resumable metadata ingestion, then use one canonical selected-call projection for local buckets, session ownership, roles and corrected totals. Freeze wire contracts and synthetic fixtures first so independent server and web workers can build against identical interfaces.

**Tech Stack:** TypeScript, better-sqlite3 through the existing DB wrapper, Intl, hand-built SVG, separate Vite 8 extension/browser builds, Vitest and @playwright/test 1.63.0 driving installed Edge locally and installed Chrome in CI.

**Spec:** `docs/superpowers/specs/2026-10-08-usage-dashboard-redesign.md` at 722f6fc: build/serving section 12, schema/settings/footer/removals sections 13-16, Playwright verification section 17. Also read `packages/host/PRODUCT.md`, the direction contract in `packages/host/.impeccable/surfaces/src-usage-web-app-ts.md`, and the approved mock (path given in each task brief). The spec wins where the mock differs, especially no even-pace or limit tick.

## Deviations

- Tasks 4 and 5 were implemented together so metadata ownership and shared queries could use one consistent contract.
- Task 17 was split into retirement and page wiring. Its browser retirement work was completed with Task 11, and unused composition-provider code was removed.
- Chip styling was refined to match the approved mock.
- Whole-branch review fixes rounded Calibration figures, aligned pace semantics, corrected font loading, preserved refresh state, reduced keyboard stops, disclosed combined Session details, and completed the legacy-helper and documentation cleanup.

## Global Constraints

- `@playwright/test` 1.63.0 is the one authorized new dev dependency, already committed. No other dependency changes or lockfile edits. Only Tasks 2 and 12 edit package.json scripts in exclusive sequence. Never run npm install, npm ci or `npx playwright install`; never download browsers.
- No framework or chart library. Charts are hand-built SVG, as today.
- Public repo hygiene: no internal names, no absolute user paths, no real figures. Fixtures, runtime screenshots and docs are synthetic only. No committed screenshots or pixel baselines; only DESIGN.md and `.impeccable/design.json` are finish artifacts for eventual commit. Do not ship the direction contract in HTML, CSS, JavaScript, hidden DOM or assets.
- No em-dashes in docs or UI copy. Credits have no AIC, est, cal, ~, + or basis markers. Correction basis belongs only on Calibration & data.
- Tests use fixtures only. Never open real databases, configs, credentials or account endpoints. Task 19 is a controller-only supplied-copy exception; Task 20 permits only an explicitly approved controller deployment backup before linking. No model calls in implementation/test workers.
- Strict TDD: write assertions first, run RED and retain its output, implement minimally, run GREEN and retain exact counts. Do not implement on a test that already passes for the wrong reason.
- Required static gate: `npm run -s typecheck`, exit 0. Run targeted tests per task; the controller runs the full `npm test` once, at the final gate, and `npm run build` with the bundle guard. Reviewers do not rerun the full suite.
- Leave all edits uncommitted. No git add, commit, stash, checkout, reset, branch or rebase in workers. A fresh read-only reviewer gate replaces the skill's commit step. Integration/worktree preparation is controller-owned outside worker steps.
- One writer per separately prepared worktree, one fresh read-only reviewer per task. No subagents inside workers. Do not edit another lane's files. Reports and RED/GREEN logs use the absolute scratch root supplied in each task brief, under that worktree's `.spider/scratch/`. Never use /tmp, TMPDIR defaults or volatile scratch.
- Before npm commands, set `TMPDIR`, `npm_config_cache` and `npm_config_logs_dir` to owned directories under the supplied scratch root. Any test/probe loading spider or pi uses `env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID`. Guard every `cd` with `|| exit 1`. Do not alter real HOME.
- Playwright is headless. Channel is `SPIDER_PLAYWRIGHT_CHANNEL`, else `chrome` when `CI` is set, else `msedge`. Launch args: `--use-mock-keychain --password-store=basic --no-first-run --no-default-browser-check --disable-sync --disable-features=MediaRouter`. Keep real HOME. Set TMPDIR before launching browsers; local profiles/output stay under `.spider/scratch/playwright/`, CI output under gitignored `playwright-results/`. SIGKILL only owned fixture processes in teardown, and close all browser contexts.
- Preserve bootstrap cookie/origin checks, CSP, server lifecycle, native worker packaging, counter polling, v1-v3 migration SQL, canonical selection and dimension_values. Keep the package DAG and browser runtime-import boundary. Import pi packages from their roots.
- Desktop browsers only; dark only; keyboard operable; WCAG AA text contrast; equivalent table for every chart. Font stacks list installed families first, then separately named Google Fonts faces, then named system fallbacks, without requiring network access. Script/style CSP is 'self' only with no inline code or style attributes; use packaged CSS/FontFace sources at fonts.gstatic.com, not a Google Fonts stylesheet link.
- Overview defaults to rolling 7 days, credits. Custom range is local date/time, at most 93 days. Session always uses its entire lifetime. Half-open time bounds use milliseconds; browser IANA zone is sent to the API and invalid zones fall back to UTC. Calibration timestamps/buckets are UTC.
- Every task brief includes the approved mock (path given in each task brief) and its source facts. Do not reproduce its preview controls, illustrative downstream scaling, nested boxes, extra events table or even-pace tick.

## Review Focus

- Nested launches, unavailable child transcripts and cyclic/ambiguous ownership must not create false human sessions or duplicate credits; unresolved runs have one Unattributed runs identity. Pinned in Tasks 4, 5, 7 and 8.
- DST transitions, skipped midnights, repeated hours and fractional-offset zones must produce unique monotonic buckets and matching selected totals, not missing or duplicated usage. Pinned in Tasks 5 and 13.
- Reset dates on short months, account switches, sparse/stale counters and absent denominators must produce honest fallback pacing without NaN, infinity or a fabricated billing figure. Pinned in Tasks 6 and 16.
- Huge/malformed/inherited messages and source replacements must not leak prompt bodies or paths, exhaust memory, overwrite a later name, or break resumable backfill. Pinned in Tasks 3 and 4.
- Slow out-of-order requests, navigation during loading and collapsed-route keyboard focus must settle to the latest state without stale data, stranded spinners or lost focus. Pinned in Tasks 11, 13 and 14.

---

## File structure and ownership

All paths below are relative to the repository root. In task file lists, `usage/` abbreviates `packages/host/src/usage/`, `web/` abbreviates `packages/host/src/usage/web/`, and `tests/` abbreviates `packages/host/src/usage/__tests__/`, while `e2e/` abbreviates `packages/host/src/usage/e2e/`; expand these prefixes literally in task briefs. No path is a wildcard unless explicitly used for the retirement audit.

| Unit | Responsibility | Sole writer |
| --- | --- | --- |
| `usage/dashboard-v4-contract.ts`, `tests/fixtures/redesign-contract.ts` | Wire DTOs, view interfaces, fixture builders | Task 1 |
| `vite.dashboard.config.mjs`, browser boundary/fixture middleware, `web/index.html`, `web/states.html`, asset loader, extension build/boot and bundle guards | Separate builds and authenticated memory-only asset serving | Task 2 |
| `usage/schema-v4.ts`, `usage/ledger.ts`, migration/layout declarations | Durable v4 storage and revision invalidation | Task 3 |
| `usage/session-metadata.ts`, `usage/session-backfill.ts`, ingest/projection/runtime publication | Private metadata, ownership evidence, resumable backfill, collector publication | Task 4 |
| `usage/query-redesign-shared.ts`, `usage/time-buckets.ts` | Canonical cube, roles, owner resolution, daily correction and local boundaries | Task 5 |
| `usage/billing-pace.ts` | Billing period, counter window, pure pacing | Task 6 |
| `usage/query-overview-v4.ts` | Overview and paged sessions | Task 7 |
| `usage/query-session.ts` | Whole-session data and transit inputs | Task 8 |
| `usage/query-calibration.ts`, `usage/counter-intervals.ts`, `usage/ingestion-status.ts` | Calibration, rates, data health and status | Task 9 |
| `usage/server.ts`, `usage/api-routes.ts`, reader/launcher/boot files | HTTP integration, cookie-local opener context and budget callback | Task 10 |
| Shell and shared browser helpers | Routing, menu, theme, fonts, client, states, chart/table primitives | Task 11 |
| `playwright.config.ts`, fixture/static/real-server harness, CI and e2e smoke | Installed-browser Playwright harness | Task 12 |
| `web/overview-v4.ts` (finally `web/overview.ts`), `web/overview.css`, `web/pace.ts` | Overview interactions and e2e | Task 13 |
| `web/session.ts`, `web/session-route.ts`, `web/session.css` | Session and transit interaction | Task 14 |
| `web/calibration.ts`, `web/calibration.css` | Calibration & data | Task 15 |
| Config registration, footer, mount and footer worker snapshot | Positive optional budget and footer | Task 16 |
| Retired files/tests, usage guide, compatibility test rewrites | Retirement and docs | Task 17 |
| `e2e/visual-acceptance.e2e.ts`, screenshot matrix and computed layout/contrast assertions | Desktop Playwright verification in local/CI runs | Task 18 |
| Scratch-only copied-data report | Real-data acceptance, controller only | Task 19 |
| Built-design docs and review evidence | Impeccable finish, controller only | Task 20 |

Task 2 releases package.json scripts to Task 12 and server/build/security tests to Tasks 10, 11 and 17. Its font-loading changes release fonts.ts/theme.css to Task 11. Task 11 releases shell/states support before Task 12 can prove the real v4 smoke. Task 12 releases `.gitignore` to Task 20 and browser helpers to disjoint page spec writers. Task 3 releases `ledger.ts` to Task 4 after its gate; Task 4 releases worker protocol/publication and `mount.ts` to Task 16. Task 1 releases the foundational legacy contract to Task 10 and finally Task 17. No concurrent writers touch those handoffs. Tasks 2 and 12 add the build and browser-test deliverables; Task 12 follows the shell so its smoke test asserts the real nav/freshness, not a fake shell. The parallelism map, not numeric order, governs execution. Existing `query-overview.ts` remains until Task 17; new page queries never import it for production logic.

### Task 1: Freeze every response contract and synthetic fixture

**Files:**
- Create: `usage/dashboard-v4-contract.ts`, `tests/fixtures/redesign-contract.ts`, `tests/redesign-contract.test.ts`.
- Modify: `usage/dashboard-contract.ts:115-155` only to add optional reader-context hooks/types, without removing old route types yet.

**Interfaces:**
- Consumes: existing `Period`, `TokenTotals`, `ApiEnvelope<T>`, `ApiErrorBody`, `DashboardQueryContext`, `DashboardReader` from `usage/dashboard-contract.ts`.
- Produces the following data-only types. Every wire field is present; unavailable values are null, missing lists are empty. Numbers are unrounded, finite and nonnegative except explicit signed differences. Public strings are redacted. Never return dbPath, sourceFile, accountLogin, lease owner/token, prompt text or configuration paths.

```ts
type Unit = "credits" | "tokens";
type RangePreset = "24h" | "7d" | "30d" | "month" | "custom";
type RangeQuery = { range: RangePreset; from: number; to: number; tz: string;
  unit: Unit; buckets: readonly number[] }; // effective aligned, unclipped bucket-start keys
type SessionSort = "credits" | "last-active" | "runs";
type SessionsQuery = RangeQuery & { sort: SessionSort; offset: number; limit: number };
type Value = { credits: number | null; tokens: TokenTotals; calls: number; unpricedCalls: number };
type Role = "own" | "workers" | "reviewers" | "others";
type FlowRole = "own" | "workers" | "reviewers" | "scouts" | "other-runs" | "compaction" | "background";
type RunStatus = "completed" | "cancelled" | "failed" | "running";
type Collector = "this-session" | "another-session" | "dashboard-server" | "none";
type ModelStyle = { color: string; shape: "circle" | "square" | "triangle" | "diamond" };
type ModelRow = { id: string; value: Value; share: number; note: string; style: ModelStyle };
type RoleValue = { role: Role; value: Value; share: number; runs: number };
type FlowEdge = { role: FlowRole; model: string; value: Value; share: number };
type FlowData = { total: Value; edges: readonly FlowEdge[]; models: readonly ModelRow[] };
type Bucket = Period & { key: number; label: string; total: Value;
  models: readonly { model: string; value: Value }[] };
type Pace = { period: Period; used: number | null; budget: number | null;
  allowance: number | null; scale: number | null; remaining: number | null;
  evenPace: number | null; projected: number | null; daysLeft: number;
  ratePerDay: number | null; usedSource: "counter" | "pi" | "unavailable";
  rateSource: "counter" | "pi" | "unavailable"; counterAvailable: boolean;
  overPace: boolean; overBudget: boolean; overAtPace: number | null };
type SessionRow = { id: string | null; name: string; project: string | null;
  lastActive: number; value: Value; roles: readonly RoleValue[]; runs: number };
type SessionsData = { rows: readonly SessionRow[]; total: number; offset: number;
  limit: number; nextOffset: number | null; summary: { runs: number; top3Share: number } };
type OverviewDataV4 = { range: RangeQuery; bucketSize: "hour" | "day"; pace: Pace;
  total: Value; buckets: readonly Bucket[]; selectedTotal: Value;
  models: readonly ModelRow[]; unpriced: readonly { reason: string; calls: number }[];
  sessions: SessionsData; flow: FlowData };
type SessionRun = { id: string | null; name: string; role: string; model: string | null;
  thinking: string | null; start: number | null; end: number | null;
  durationMs: number | null; status: RunStatus | null; value: Value; style: ModelStyle | null };
type OwnCallBin = Period & { value: Value }; // one aggregate per active period
type IdleGap = { start: number; end: number; cacheWriteCredits: number | null }; // duration is end - start; no per-gap id or period copy
type SessionData = { id: string; name: string; project: string | null; span: Period | null;
  total: Value; stats: { runs: number; ownCalls: number; compaction: number; idleGaps: number };
  runs: readonly SessionRun[]; ownCallBins: readonly OwnCallBin[];
  compaction: readonly { ts: number; value: Value }[]; idleGaps: readonly IdleGap[];
  activePeriods: readonly Period[]; models: readonly ModelRow[]; flow: FlowData };
type SessionNotFound = { apiVersion: 1; error: { code: "not-found"; message: "Session not found" } };
type StatusData = { lastIngestAt: number | null; collector: Collector;
  latestCounterAt: number | null; serverBuild: string; rateVersions: readonly string[] };
type CounterInterval = Period & { counterDelta: number; publishedEstimate: number | null;
  ratio: number | null };
type RateRowV4 = { model: string; tier: string; abovePromptTokens: number;
  input: number | null; cacheRead: number | null;
  cacheWrite: number | null; output: number | null; sourceDate: string };
type SourceError = { pathLabel: string; code: string; count: number; lastCheckedAt: number };
type CalibrationData = { correction: { factor: number | null; publishedEstimate: number | null;
  accountCounter: number | null; coveredHours: number;
  status: "calibrated" | "back-applied" | "published-only" | "counter-unavailable" };
  daily: readonly { day: number; publishedEstimate: number | null; counterDelta: number | null }[];
  intervals: readonly CounterInterval[]; rates: readonly RateRowV4[];
  unpricedModels: readonly { model: string | null; calls: number; reason: string }[];
  ingestion: { collector: Collector; lastIngestAt: number | null; filesTracked: number;
    callsToday: number; errors: number }; errors: readonly SourceError[];
  gaps: { unpricedCalls: number; compactionWithoutModel: number; daysWithoutCounter: readonly number[] } };
```

- Produces `RESPONSE_CAPS_V4` in bytes: `/api/status`: `8 * 1024`; `/api/overview`: `1024 * 1024`; `/api/sessions`: `512 * 1024`; `/api/session/<id>`: `2 * 1024 * 1024`; `/api/calibration`: `1024 * 1024`. These shared constants let Task 8 size-test before Task 10 HTTP integration.
- Produces route mapping: `/api/status` -> `ApiEnvelope<StatusData>`; `/api/overview` -> `ApiEnvelope<OverviewDataV4>`; `/api/sessions` -> `ApiEnvelope<SessionsData>`; `/api/session/<id>` -> `ApiEnvelope<SessionData>` or HTTP 404 `SessionNotFound`; `/api/calibration` -> `ApiEnvelope<CalibrationData>`. Other failures retain `ApiErrorBody`.
- Produces `DashboardPageContext = { document: Document; root: HTMLElement; client: DashboardClient; route: DashboardRouteV4; signal: AbortSignal; navigate(route: DashboardRouteV4, options?: { replace?: boolean }): void; overview: RangeQuery; now(): number; back(): void }`, `DashboardPage = { refresh(): Promise<void>; dispose(): void }`, `DashboardPageMount = (ctx: DashboardPageContext) => DashboardPage`. `DashboardClient` retains existing `get<T>(path, params, signal): Promise<ApiEnvelope<T>>`.
- `DashboardRouteV4` is the discriminated union `{ page: "overview"; query: RangeQuery } | { page: "session"; id: string; unit: Unit; tz: string } | { page: "calibration" }`. View-interface imports are type-only, including the existing browser client. `navigate(..., { replace: true })` reconciles the hash and remembered Overview without pushing history, remounting or refetching.
- Add optional `monthlyBudget?(): number | undefined` and `viewerSessionId?: string` to query context, optional budget callback to ReaderOptions, and optional opener id to LaunchOptions. No runtime behavior changes yet.
- Fixture builders: `statusFixture(overrides?: Partial<StatusData>): StatusData`, `overviewFixture(overrides?: Partial<OverviewDataV4>): OverviewDataV4`, `sessionsFixture(overrides?: Partial<SessionsData>): SessionsData`, `sessionFixture(overrides?: Partial<SessionData>): SessionData`, `calibrationFixture(overrides?: Partial<CalibrationData>): CalibrationData`, `envelope<T>(data: T, period?: Period): ApiEnvelope<T>`. Builders produce fresh nested objects, not shallow-shared arrays.
- Fixture-only exports in tests/fixtures/redesign-contract.ts: `FixtureScenario = "default" | "no-data" | "no-budget" | "counter-unavailable" | "over-pace" | "stale" | "unknown-session" | "error"`; `FixtureStateCase = { name: string; page: DashboardRouteV4["page"]; scenario: FixtureScenario; responses: Readonly<Record<string, { status: number; body: ApiEnvelope<unknown> | ApiErrorBody | SessionNotFound }>> }`; `fixtureStateCases(): readonly FixtureStateCase[]`. Include the section 9 cases and default for every page, applying page-specific empty/error/not-found and component states honestly. Consumers transport these as JSON; browser imports of the types are erased, never runtime imports of builders.

- [x] **Step 1: Write failing contract tests.**
  - `five routes have complete finite fixture DTOs`: assert `overviewFixture().range.range === "7d"`, `.range.unit === "credits"`, `.sessions.limit === 10`, all five builders satisfy their DTOs with `satisfies`, and no forbidden private field occurs recursively.
  - `fixtures are isolated`: mutate one result's nested arrays and assert a second result is unchanged; fixtureStateCases covers every section 9 state/default, returns fresh response data and has no forbidden private fields.
  - `session 404 is typed`: assert `body satisfies SessionNotFound` and `body.error.message === "Session not found"`.
- [x] **Step 2: Run RED.** `node node_modules/vitest/vitest.mjs run packages/host/src/usage/__tests__/redesign-contract.test.ts`; expect missing exports/contracts, not environment errors.
- [x] **Step 3: Implement the contracts/builders.**
  - Use existing tokens/envelope types, plain synthetic model/session names, and small independently invented values.
  - Sessions additionally accept optional unit/buckets although omitted from the spec's route table, because expanded selection must match Overview; defaults are credits/no selection.
  - Share is a fraction in [0,1].
  - Unknown legacy terminal status is null, rendered unavailable rather than guessed.
- [x] **Step 4: Run GREEN and typecheck.** Repeat the test command and `npm run -s typecheck`; expect all assertions pass and exit 0.
- [x] **Step 5: Fresh reviewer gate.** Check every spec section 11 field against the DTOs, no browser runtime server import, fixture isolation, and no private data. Leave files uncommitted and record the released contract.

### Task 2: Split the dashboard build and serve authenticated packaged assets

**Files:**
- Create: `vite.dashboard.config.mjs`, `scripts/usage-dashboard-browser-boundary.mjs`, `scripts/usage-dashboard-fixtures.mjs`, `web/index.html`, `web/states.html`, `web/states.ts`, `web/states.css`, `web/states.css.d.ts`, `usage/dashboard-assets.ts`, `tests/dashboard-asset-routes.test.ts`, `tests/dashboard-build-isolation.test.ts`.
- Modify: `vite.config.mjs`, package.json scripts only, `scripts/assert-bundle.mjs`, `packages/host/src/extension.ts:89-97`, `usage/server.ts`, `usage/server-entry.ts`, `usage/server-runtime.ts`, `usage/server-crash-codes.ts`, `usage/dashboard-command.ts`, `usage/doctor.ts`, `web/fonts.ts` (font transport only; keep legacy families).
- Rewrite for external assets: `tests/dashboard-assets.test.ts`, `tests/dashboard-bundle.test.ts`, `tests/dashboard-entry.test.ts`; adapt `tests/worker-bundle.test.ts` to build the production dashboard beside its scratch extension before running assert-bundle, retaining native-import/worker assertions; adapt `tests/server.test.ts`, `tests/server-fix.test.ts`, `tests/server-round2.test.ts`, `tests/dashboard-api.test.ts`, `tests/query-explorer-fix.test.ts`, `tests/query-explorer-round2.test.ts`, `tests/server-security.test.ts`, `tests/server-runtime.test.ts`, `tests/server-entry.test.ts`, `tests/dashboard-command.test.ts`, `tests/doctor-diagnostics.test.ts` to fixture dashboard directories. Preserve lifecycle/security assertions. Update `.github/workflows/release.yml` tarball-required entries to include dist/dashboard/index.html and hashed JS/CSS, with no states/maps; its native-import/security checks remain intact. Keep legacy browser capture callers green with a fixture-only external-asset adapter in tests/fixtures/dashboard-browser-fixture.ts until Task 17 retires it; do not use the dead nested build for production. Adapt tests/fixtures/all-view-browser-fixture.ts, scripts/usage-dashboard-screenshot.mjs/.d.mts, tests/dashboard-visual.test.ts, tests/web-detail-visual.test.ts, tests/visual-script.test.ts and tests/screenshot-lifecycle.test.ts for external fixture assets where they consume the old HTML transport; preserve launch/cleanup/lifecycle assertions and do not weaken CSP. These interim consumers are all removed in Task 17.

**Interfaces:**
- Consumes Task 1 fixture builders/envelope and existing app.ts browser entry, server lifecycle, raw request-path parser and bootstrap cookie.
- This task runs alongside Task 3; it opens no ledger and changes no API contract or page design.
- Browser config root: `packages/host/src/usage/web`.
- Production input `index.html` only with external module `/app.ts` and `<div id="usage-app"></div>` (existing auto-start root).
- Absolute output `dist/dashboard/`, `assets/[name]-[hash].js` and `.css`.
- Target `es2022`, sourcemap false, publicDir false.
- `build.modulePreload: { polyfill: false }` and `build.assetsInlineLimit: 0`.
- `mode=development` and `mode=e2e` add states.html; e2e requires an explicit output directory under owned scratch, never production dist.
- `npm run dev:dashboard` uses this config and fixture middleware.
- Produces `usageBrowserBoundary(webRoot: string): Plugin` in scripts/usage-dashboard-browser-boundary.mjs.
- Reject runtime imports outside web, bare/Node/pi/database imports and escaping symlinks; allow Vite's own HTML/CSS virtual plumbing and erased type-only imports.
- Apply it to build and dev.
- Fixture middleware imports Task 1 builders server-side only, never into the browser graph.
- Produces `fixtureApiMiddleware(): Plugin` in scripts/usage-dashboard-fixtures.mjs, dev-only.
- Serve all five fixture API envelopes plus `/api/fixture-states`; the latter is a JSON catalogue of fixture cases (page, state, envelopes/errors), made by Task 1 builders.
- It is not a production API. states.ts imports only web code, loads this catalogue, and renders isolated component/page examples.
- Initially show existing app components in a states root without id usage-app so importing app.ts does not auto-start a second page; Tasks 11 and 13-15 extend it to the new components/states, Task 17 registers final mounts.
- The fixture API never reads databases/configs/transcripts.
- Script values: `build` = `vite build && npm run build:dashboard && node scripts/assert-bundle.mjs`.
- `build:dashboard` = `vite build --config vite.dashboard.config.mjs`.
- `dev:dashboard` = `vite --config vite.dashboard.config.mjs`.
- `test:e2e` = `playwright test` (configuration follows in Task 12).
- Keep `bundle` extension-only and `dev` as extension watch.
- Extension config drops the nested asset plugin and uses `emptyOutDir: false`; browser config uses `emptyOutDir: true` scoped to its own dashboard/e2e directory.
- Extension first, dashboard second.
- Extension watch never cleans dist; dashboard rebuild removes stale hashes only inside dashboard/.
- Unexpected old root files fail the guard rather than being silently removed.
- No build empties the other's output, including reversed standalone builds.
- Produces `DashboardAssetsError extends Error` with `.code: "usage-dashboard-missing" | "usage-dashboard-invalid"`.
- Produces `loadDashboardAssets(directory: string): Promise<ReadonlyMap<string, { body: Buffer; contentType: "text/html; charset=utf-8" | "text/javascript; charset=utf-8" | "text/css; charset=utf-8"; cacheControl: string }>>` in usage/dashboard-assets.ts.
- Require index.html, at least one hashed JS and CSS, and every local HTML reference; validate the same allowlist/512 KiB total dashboard cap as assert-bundle.
- Reject symlinks, maps, states page and unexpected entries.
- Missing/partial -> missing; bad shape/size -> invalid.
- Read each file once per start, not per request.
- extension.ts passes `dashboardDir: fileURLToPath(new URL("./dashboard/", import.meta.url))` to runUsageServerEntry; replace html hooks/options with required dashboardDir through BootOptions/HTTP options.
- Resolve from the running bundle URL, never cwd or an HTTP/startup-record path.
- Load assets before reader/participant startup.
- `/usage` maps typed failures to fixed path-free actionable copy; propagate the allowlisted code across standalone startup/crash handling; `/doctor` adds a dashboard-assets line and does not print paths.
- Ordinary extension imports/workers remain inert.
- `/` and exact `/assets/<hashed-file>` map keys require existing cookie and transport checks, support GET/HEAD, and never join request paths to disk paths.
- HTML uses no-store; JS/CSS use `public, max-age=31536000, immutable` after auth.
- For raw `req.url` beginning `/assets/`, run the existing cookie/transport checks first, then serve only an exact map key; every other asset target returns 404.
- Check this raw prefix before the generic parse-failure 400.
- No URL normalization; encoded/double-encoded traversal variants are unknown asset targets.
- Preserve existing 400 behavior for malformed non-asset targets.
- Unknown API matching is unchanged.
- `usageSecurityHeaders(): Readonly<Record<string,string>>` drops HTML/hash input and createHash, retaining timingSafeEqual and all other security headers.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`.
- FontFace loading uses local faces first, direct Google font files second, system fallback last; no inline style/script or remote stylesheet link.
- Keep the old page/app.ts working, with legacy font families until Task 11.

- [x] **Step 1: Write failing build/asset tests.**
  - `two independent builds preserve each other` (explicit Vitest test timeout `180_000` ms): build extension/dashboard into owned scratch; assert dist entries exactly extension.js/dashboard, dashboard entries index.html/assets, only hashed JS/CSS, no maps/states/virtual HTML string and total dashboard bytes <=512 * 1024. Run dashboard first then extension and compare asset hashes; run extension watch through its initial write and one source-triggered rebuild and compare them again; dashboard rebuild preserves extension bytes and removes stale dashboard hashes. Watch fixture uses a copied synthetic checkout, never edits a concurrent worker's source.
  - `dev and e2e states never ship`: resolved production config has only index input; dev/e2e add states and return fresh Task 1 envelopes. Resolved dashboard config pins modulePreload polyfill false and assetsInlineLimit 0. Boundary rejects a runtime outside-web import (including symlink escape) but accepts a type-only contract import and HTML/CSS entry plumbing.
  - `asset routes require cookies and exact paths`: bootstrap synthetic server, assert unauthorized asset 401, GET/HEAD types/cache/body behavior, origin 403, exact keys only. Raw `/assets/../extension.js`, encoded dots/slashes, double encoding, nested paths, absolute paths and unknown hashes return 401 without a cookie and 404 after authentication, never the generic parse-failure 400; no request-time filesystem access. Change/delete files after startup and assert cached bytes still served; spy each file read exactly once.
  - `assets fail clearly before startup`: missing HTML/JS/CSS or a referenced file throws the typed missing code; invalid shape/cap throws invalid. Launcher reports the same safe code, /usage actionable notification and /doctor line; no reader/participant or leftover process on failure.
  - `external CSP has no inline permission`: exact directives above, no sha256/unsafe-inline/remote style permission, existing nonce/cookie/transport/native-worker lifecycle stays intact. Bundle guard rejects extra root files, missing/extra dashboard files, maps, states and oversize payloads.
- [x] **Step 2: Run RED.** Run the new build-isolation/asset-routes tests and rewritten dashboard-assets/dashboard-bundle/dashboard-entry/server-security tests with Vitest; expect embedded build/inline CSP/absent asset-loader assertions to fail, not native fixture errors.
- [x] **Step 3: Implement the separate builds, middleware, loader and safe startup errors.** Extract the small boundary plugin, keep app.ts the HTML entry, replace only the server's HTML transport and font loading, and extend the bundle guard to the exact two-level shape/cap. Preserve old views and routes until their owning tasks; no unsafe inline fallback when files are missing.
- [x] **Step 4: Run GREEN.** Repeat all new/rewritten tests plus adapted server/launcher/doctor and worker-bundle tests; `npm run -s typecheck`, then `npm run build`. Expect old app still usable, output isolation including watch verified, exact package shape and no inline CSP hash code. Retain exact counts.
- [x] **Step 5: Fresh reviewer gate.** Review output ownership/watch proof, import boundary, cookie-gated exact memory routes, CSP/fonts and typed cross-process startup error. Release package.json, server/entry/security and font files in sequence; leave uncommitted. Old nested-build script/declaration remain dead until Task 17 removes them explicitly.

### Task 3: Add immutable ledger v4 storage

**Files:**
- Create: `usage/schema-v4.ts`, `tests/ledger-v4.test.ts`, `tests/fixtures/usage-v3.sql`.
- Modify: `usage/schema.ts:4-5`, `usage/migrate.ts:7-11`, `usage/ledger.ts:67-105,119-145,347-365`; update only latest-schema expectations in `tests/ledger-v3.test.ts`, `tests/ledger-open.test.ts`, `tests/ledger.test.ts`, `tests/ledger-v2.test.ts`, `tests/ledger-v2-triggers.test.ts`. Explicit frozen-version tests retain their original version assertions.

**Interfaces:**
- Consumes existing v3 schema/migration/layout assertion and `UsageLedger.apply(batch): boolean` fence semantics.
- Produces `RunMeta.status?: "queued" | "running" | "paused" | "done" | "failed" | "cancelled" | null`, `SessionMeta = { id: string; ownerSessionId: string | null; name: string; nameSource: "name" | "first-user" | "id"; project: string | null; firstActivity: number | null; lastActivity: number | null; nameOrder: number }`, and `MetadataCheckpoint = { path: string; generation: number; offset: number; size: number; complete: boolean }` in ledger.ts.
- Add optional `ImportBatch.sessions`, `.metadataCheckpoints`; add `UsageLedger.getSessions(): readonly SessionMeta[]` and `.getMetadataCheckpoint(path: string): MetadataCheckpoint | undefined`.
- SQL: `runs_meta.status` nullable with `CHECK (status IN ('queued','running','paused','done','failed','cancelled'))`; `sessions` keyed by id, owner_session_id, name/name_source, project, nullable first_activity/last_activity, name_order; `session_metadata_import` keyed by path with generation/offset/size/complete checks. Index `sessions_owner(owner_session_id,id)`; revision triggers for session/status changes. Metadata fields are private store inputs, public outputs still redact.

- [x] **Step 1: Write failing tests.**
  - `v3 upgrades once without changing selected calls`: assert version 4, identical selected fingerprints/tokens/published credits before/after, retained dimension_values, and unchanged v1-v3 SQL.
  - `status only update invalidates revision`: assert revision increments on status change, not no-op.
  - `fenced metadata batch is atomic`: assert `apply` false leaves runs/sessions/checkpoints unchanged.
  - `metadata preserves later name and span`: older nameOrder cannot replace later name; min/max activity extends span.
  - `durable v4 drift is rejected`: an extra persistent table or altered trigger fails schema assertion.
  Assertions: `expect(version).toBe(4)`; `expect(selectedAfter).toEqual(selectedBefore)`; `expect(ledger.apply(rejectedBatch)).toBe(false)`; `expect(revisionAfterStatus).not.toBe(revisionBeforeStatus)`.
- [x] **Step 2: Run RED.** `node node_modules/vitest/vitest.mjs run packages/host/src/usage/__tests__/ledger-v4.test.ts`; expect missing v4 schema/API.
- [x] **Step 3: Implement storage and migration.**
  - Append version 4, increment only the version constant, keep the existing layout marker and shipped SQL immutable.
  - Add all new durable objects through schema-v4.ts, not ad hoc writable opens.
  - Legacy status starts null.
  - Upsert the session map without clobbering newer names; preserve lease transactions and existing import state.
- [x] **Step 4: Run GREEN.** Run ledger-v4.test.ts, ledger-v3.test.ts, ledger-open.test.ts, ledger-counting.test.ts and ledger-leases.test.ts with Vitest, then `npm run -s typecheck`; expect fixture-only pass, no selection changes.
- [x] **Step 5: Fresh reviewer gate.** Review upgrade SQL/layout objects, revision triggers, fence rollback and name precedence. Document backup-before-upgrade and release ledger.ts to Task 4. Leave uncommitted.

### Task 4: Capture metadata, run status, ownership and collector identity

**Files:**
- Create: `usage/session-metadata.ts`, `usage/session-backfill.ts`, `tests/session-metadata.test.ts`, `tests/session-backfill.test.ts`.
- Modify: `usage/jsonl-projection.ts:1-8,46-52`, `usage/ingest.ts:67-89,112-185,277-331,413-454`, `usage/discovery.ts:147-161`, `usage/ledger.ts` metadata methods from Task 3, `usage/protocol.ts:7-28`, `usage/runtime.ts:9-17,68-82`, `usage/worker-entry.ts:144-152,204-226`, `usage/mount.ts:149-160` only to pass the pi session identity to runtime.

**Interfaces:**
- Consumes `SessionMeta`, `MetadataCheckpoint`, optional batch fields and run status from Task 3.
- Produces `readSessionMetadata(source: SourceInfo, checkpoint: MetadataCheckpoint | undefined, signal: AbortSignal, maxBytes: number): Promise<{ session: SessionMeta | null; checkpoint: MetadataCheckpoint; errors: readonly { path: string; code: string }[] }>`; `backfillSessionMetadata(ledger: UsageLedger, discovery: Discovery, at: number, signal: AbortSignal, guard: () => boolean, maxBytes: number): Promise<{ complete: boolean; sourcesRead: number; bytesRead: number }>`.
- Produces cached `resolveSessionProject(cwd: string, registeredRepo: string | null): Promise<string>` and pure `redactSessionName(text: string): string`; latest name order is source generation/entry ordering, not an untrusted clock alone.
- Produces `METADATA_BACKFILL_BYTES_PER_PASS = 4 * 1024 * 1024`; the worker supplies it to backfill only after normal ingest in each pass.
- Publish optional worker collector metadata `{ kind: "pi" | "dashboard"; sessionId: string | null; owner: string }` alongside the fenced worker snapshot. Owner is coordination only, never a public DTO. Pass optional `sessionId` in UsageRuntimeOptions and worker start command. No counter-poller changes.

- [x] **Step 1: Write failing tests.**
  - `latest name wins over first user and id`: named fixture wins, unnamed fixture uses trimmed first line of at most 80 code points, blank/nontext first message uses short id.
  - `name is redacted before storage`: encoded home/drive paths and terminal controls do not persist literally.
  - `huge content retains only a bounded first line`: multi-megabyte tool/assistant/user suffixes do not enter projected source_entries or metadata buffers.
  - `malformed metadata is resumable`: truncated JSONL tail leaves its checkpoint at the last complete line; appending the rest resumes once, non-string name is ignored, later valid lines still ingest.
  - `inherited user is not a name`: forked/resumed fixture's first user entry is inherited history; skip it and name from the first new user entry, or short id if none.
  - `backfill resumes without billing reimport`: interrupt a fixture scan, resume at metadata checkpoint, assert calls/fingerprints and billing offsets unchanged and completed second pass reads zero historical bytes.
  - `replacement clears stale metadata safely`: changed generation cannot reuse the old name/span/checkpoint.
  - `nested child maps to top level`: child header id maps to run owner even with no parent_run_id.
  - `status only ingest persists`: done -> cancelled with unchanged source file changes stored status.
  - `every real status commits`: ingest one run record each for queued, running, paused, done, failed, cancelled plus an unknown string in one fenced batch; assert committed status readback is `["queued", "running", "paused", "done", "failed", "cancelled", null]`.
  - `collector publication is fenced`: lost lease writes no collector or snapshot.
  - `backfill never starves ingest`: with historical bytes beyond the per-pass budget, new live calls ingest first, lastIngestAt advances each pass while backfill.complete is false, and backfill.bytesRead <= `METADATA_BACKFILL_BYTES_PER_PASS`.
  - `deleted cwd preserves registered repo`: git failure for a nonexistent cwd uses the registered repo basename; no repo uses folder basename.
  Assertions: `expect(stored.nameSource).toBe("name")`; `expect([...stored.name].length).toBeLessThanOrEqual(80)`; `expect(billingOffsetAfter).toBe(billingOffsetBefore)`; `expect(secondPass.bytesRead).toBe(0)`.
- [x] **Step 2: Run RED.** Run session-metadata.test.ts and session-backfill.test.ts; expect absent metadata behavior.
- [x] **Step 3: Implement incremental capture and bounded backfill.**
  - Capture string session_info.name and only the first non-inherited user text line before compact() discards them; redact before storage. Latest nonempty /name wins. Never retain whole message bodies or use inherited history as the name.
  - Metadata activity uses canonical call timestamps, nullable with no calls; rebuild after replacement. Owned child rows retain ownerSessionId for evidence, not display.
  - Resolve project by cached git main-worktree name, then registered repo basename, then cwd folder basename, including deleted cwd. Do not walk repositories in discovery.
  - Join runStates by `(dbPath,id)`; normalize unknown status to null before comparing/writing RunMeta so the CHECK cannot reject ingest.
  - Each pass runs normal ingest first, then backfill with fixed `METADATA_BACKFILL_BYTES_PER_PASS = 4 * 1024 * 1024`. Sum all bytes read across sources; large lines can resume across passes with bounded projection state.
  - Backfill each source once in fenced resumable chunks; metadata cursor never resets billing cursor. Preserve complete-line checkpoints and sanitize missing-file diagnostics.
- [x] **Step 4: Run GREEN.** Run the two new tests plus ingest.test.ts, jsonl-projection.test.ts, discovery.test.ts, runtime.test.ts and worker-entry.test.ts; then `npm run -s typecheck`. Expect unchanged canonical call totals and counter cadence.
- [x] **Step 5: Fresh reviewer gate.** Review privacy/buffer bounds, first-user text-block behavior, source-generation recovery, nested owner evidence, status-only updates and lease fencing. Release worker/mount publication files to Task 16; leave uncommitted.

### Task 5: Build the shared canonical rollup and time-zone projector

**Files:**
- Create: `usage/time-buckets.ts`, `usage/query-redesign-shared.ts`, `tests/time-buckets.test.ts`, `tests/query-redesign-shared.test.ts`.
- Existing reference only: `usage/schema.ts:80-122`, `usage/calibration.ts`, `usage/dashboard-selection.ts:136-162`, `usage/dashboard-identities.ts:550-556,609-634`.

**Interfaces:**
- Consumes Task 1 DTOs, Task 3 tables, canonical `countedUsageSql`, calibration at/atMany/earliest, and dashboardLabel/supportedDetailId.
- Produces `normalizeTimeZone(value: string): string`, `resolveRange(params: URLSearchParams, now: number, month?: Period): RangeQuery`, `timeBuckets(period: Period, tz: string, size: "hour" | "day"): readonly (Period & { key: number })[]`. Each key is the aligned, unclipped local hour/day start; start/end bound the bucket's intersection with the requested period.
- Produces `readUsageCube(ctx: DashboardQueryContext, query: RangeQuery, scope?: { sessionId: string }): UsageCube`, `readCorrectedComponents(ctx: DashboardQueryContext, callIds: readonly string[]): ReadonlyMap<string, { cacheWriteCredits: number | null }>`, `sumValues(values: readonly Value[]): Value`, `flowFromCube(cube: UsageCube): FlowData`, `modelRows(cube: UsageCube): readonly ModelRow[]`, `sessionRows(cube: UsageCube): readonly SessionRow[]`.
- `UsageCube = { total: Value; selectedTotal: Value; buckets: readonly Bucket[]; rows: readonly { bucketKey: number; sessionId: string | null; runId: string | null; role: FlowRole; model: string; value: Value }[] }`. Rows contain only aggregated measures, never transcript bodies. Internal full-session range processing chunks beyond 93 days; public Overview validation still caps 93 days.
- Produces `resolveOwner(ctx: DashboardQueryContext, sessionId: string | null, runId: string | null): string | null`, fixed `UNATTRIBUTED_SESSION_ID = "unattributed-runs"`, and `modelStyles(ctx: DashboardQueryContext): ReadonlyMap<string, ModelStyle>`. The reserved id always resolves only to Unattributed runs, never suffixes; a colliding stored human id keeps its totals but has a null drill-down id.
- Human display rule (spec section 10): a sessions entry with null owner represents its own non-run transcript; before backfill, require own `actor IN ('parent','compaction','aux','warmer')` calls from a non-run transcript. Never promote a subagent-only id to a human row. Unresolvable ownership, including missing child transcripts with no parent_run_id, maps to the reserved row.

- [x] **Step 1: Write failing tests.**
  - `daily correction reconciles every slice`: two synthetic UTC-day published totals 10 and 20 with factors 0.5 and 1 produce 25 credits in total/buckets/models/sessions/flow, never period-factor 30. An hourly/local-day bucket crossing UTC midnight has the same 25 across its pieces.
  - `token subsets are not added twice`: total equals input + cacheRead + cacheWrite + output.
  - `selection remains globally canonical`: native detail replaces report, copied history and covered descendants do not reappear under selected buckets.
  - `DST buckets are monotonic`: local spring/fall days are 23/25 hours, repeated hours have different keys; half-hour transition and UTC+05:45 preserve all calls.
  - `skipped midnight and invalid zone`: first valid date instant, no fake skipped date, invalid zone becomes UTC.
  - `ownership cycles and duplicate run ids`: cycles/ambiguous evidence resolve null; direct, pipeline and mapped nested runs have one owner.
  - `model styles do not rerank on unit or selection`: identical model styles across page/scope switches and ingest revisions within a UTC day; next day refreshes the catalogue.
  - `two years stay bounded`: two years of synthetic history returns styles and corrected totals; spy on atMany to assert every batch has <=200 endpoints and max-min <=366 days; model rank uses an uncorrected indexed aggregate without atMany.
  - `missing nested child is not human`: nested run without parent_run_id and missing child transcript has only subagent calls; before backfill its credits appear only in Unattributed runs, after child-to-owner backfill they move once to the known human owner.
  - `reserved identity is stable`: saved unattributed link and totals remain synthetic after a colliding stored session arrives, with no suffix.
  - `SQL uses bounded indexes`: EXPLAIN includes calls_period_read or calls_session_read with timestamp bounds, not a raw unbounded calls scan.
  Assertions: `expect(cube.total.credits).toBeCloseTo(25, 10)`; `expect(sumValues(cube.buckets.map(b => b.total)).credits).toBeCloseTo(25, 10)`; `expect(new Set(bucketKeys).size).toBe(bucketKeys.length)`; `expect(normalizeTimeZone("Not/AZone")).toBe("UTC")`.
- [x] **Step 2: Run RED.** Run time-buckets.test.ts and query-redesign-shared.test.ts; expect missing shared functions.
- [x] **Step 3: Implement one reusable aggregation.**
  - Compute Intl boundaries in JS and bind bounded JSON/json_each to SQL. Hours for duration <=48h, days otherwise; aligned keys never change when the first/last bucket's measure bounds are clipped.
  - Split local buckets at UTC days; fit clipped day-end minus 1 ms with earliest back-application. Every atMany batch, including corrected components, has <=200 endpoints and a span <=366 days. Batch component call ids in bounded SQL sets, not one query per idle gap.
  - Retain the last accepted factor for counter-unavailable fallback without changing acceptance maths. Sum corrected pieces consistently; preserve null prices.
  - Resolve ownership with unique evidence/cycle checks and the human display rule above. Role uses runs_meta when report role is absent. Unknown subagent roles map to `other-runs`, labelled Other runs; omit empty flow nodes per spec sections 6/10.
  - Rank model styles by a cheap all-history uncorrected canonical published-credit aggregate, then model name, using `calls_provider_model_ts`. Cache per ledger and UTC day, not revision; no calibration pass for this catalogue. Use tomato/sky/sage/mustard first, deterministic warm extensions and shape markers.
  - Keep no per-call HMAC or per-row query loop.
- [x] **Step 4: Run GREEN.** Run both new files plus selection-v3-differential.test.ts and calibration-differential.test.ts; `npm run -s typecheck`. Expect exact token counts and credit assertions within floating precision, unchanged engine differential results and bounded index plans.
- [x] **Step 5: Fresh reviewer gate.** Review correction reconciliation, full-session chunking, role completeness, reserved identity stability, human display evidence, DST algorithm and query plans. Leave uncommitted.

### Task 6: Implement billing period and pace calculations

**Files:**
- Create: `usage/billing-pace.ts`, `tests/billing-pace.test.ts`.
- Reference: `usage/counter.ts:82-88`, `usage/query-reconciliation.ts:18-37`; do not change the poller or old route.

**Interfaces:**
- Consumes `Pace`, canonical corrected UTC daily values, `CounterSnapshot` and `Period`.
- Produces `billingPeriod(now: number, snapshot: CounterSnapshot | undefined): Period`, `counterRate(snapshots: readonly CounterSnapshot[], window: Period): number | null`, and `computePace(input: { now: number; snapshots: readonly CounterSnapshot[]; budget: number | undefined; correctedMonth: number | null; correctedWindow: number | null }): Pace`.
- Rates and remaining days use fractional UTC days, not inclusive calendar-date counts. A snapshot's reset is the next UTC reset instant. Subtract one calendar month with day clamping; unusable counter period falls back to the UTC calendar month.

- [x] **Step 1: Write failing tests.**
  - `reset defines billing month`: reset March 31 in a non-leap fixture implies February 28 start, not March 3.
  - `counter takes account-wide used`: in-period used 100, budget 200 -> remaining 100, scale 200; budget absent and entitlement 400 -> scale 400, evenPace null.
  - `seven day projection`: full covered window delta 70 over 7 days -> rate 10, used 100 with 2 days left -> projected 120.
  - `short month-to-date window`: use month-start to now when under 7 days.
  - `sparse identity or reset evidence falls back`: gaps without a bracketing accepted chain, decrease, account switch or reset crossing use pi corrected window, not remaining/entitlement deltas.
  - `stale observation still counts if in period`: preserve valid used and label freshness separately.
  - `no denominator or counter`: null scale/projected when evidence absent, no NaN/infinity; pi estimate available still supplies used.
  - `danger semantics`: projected > budget means overAtPace, used above elapsed budget means overPace; these flags do not depend on Tokens mode.
  Assertions: `expect(pace.ratePerDay).toBe(10)`; `expect(pace.projected).toBe(120)`; `expect(noBudget.evenPace).toBeNull()`; `expect(unavailable.scale).toBeNull()`.
- [x] **Step 2: Run RED.** Run billing-pace.test.ts; expect missing pace exports.
- [x] **Step 3: Implement pure pace math.**
  - Validate dates/counters and use only same-account/reset monotonic accepted chains.
  - Interpolate bracketing counter endpoints for the rate estimate only; never daily Calibration chart values.
  - When coverage fails use corrected pi window / elapsed days.
  - Used picks a valid in-period snapshot regardless of whether its freshness is stale, otherwise corrected month estimate.
  - Latest valid entitlement supplies allowance.
  - Zero/invalid denominators remain null, not zero-filled. overAtPace is excess over budget, or allowance without a budget.
- [x] **Step 4: Run GREEN.** Run billing-pace.test.ts and calibration-periods.test.ts; `npm run -s typecheck`; expect pure fixture calculations and no poller edits.
- [x] **Step 5: Fresh reviewer gate.** Review reset boundaries, interpolation disclosure, fallback window and danger flags; leave uncommitted.

### Task 7: Implement Overview and paged Sessions queries

**Files:**
- Create: `usage/query-overview-v4.ts`, `tests/query-overview-v4.test.ts`, `tests/query-sessions.test.ts`.

**Interfaces:**
- Consumes `readUsageCube`, modelRows/sessionRows/flowFromCube, resolveRange, computePace and optional ctx.monthlyBudget callback.
- Produces `queryOverviewV4(ctx: DashboardQueryContext, query: RangeQuery): OverviewDataV4`, `querySessions(ctx: DashboardQueryContext, query: SessionsQuery): SessionsData`, and route definitions `OVERVIEW_V4_ROUTES: readonly DashboardRoute[]` for exact `/api/overview` and `/api/sessions`.
- Overview first page: credits sort descending, limit 10, offset 0. Sessions sort credits/last-active/runs descending with stable id tie-break; offset >=0, limit 1..200, default 10. Paging is snapshot-local; refresh resets offset and never merges revisions.
- Grammar: range is 24h/7d/30d/month/custom. `range=custom` requires paired numeric millisecond from/to and <=93 days; presets ignore from/to and derive bounds at the server. Month uses billingPeriod clipped to now. Buckets is a JSON array of unique safe-integer aligned start keys; malformed grammar/values (including unknown parameters) or duplicates return invalid-query, not well-formed aged-out keys.
- Intersect requested selection with current bucket keys and echo it in `OverviewDataV4.range.buckets`; no selection means full range. Response from/to are resolved bounds, not a preset freeze. Paging uses the same preset/custom grammar; discard stale pages if refreshed bounds/revision differ. Freeze a shared range only by converting it to custom.

- [x] **Step 1: Write failing tests.**
  - `default seven days uses hourly threshold correctly`: default 7d is daily, 24h is hourly, exactly 48h hourly and larger daily.
  - `noncontiguous selection filters downstream only`: selected bucket keys change selectedTotal/models/sessions/flow, while range total/bars and pace stay unchanged; empty selection means full range.
  - `top sessions reconcile roles and notes`: each role split sums to its row, top3Share is over all matching sessions, model source note comes from actual dominant actor/role, unpriced reasons counted once.
  - `Show all paging matches Overview`: first 10 identical; custom requests with the Overview's resolved from/to preserve exact range/unit/selection across offsets, ties do not duplicate rows; token presentation never changes credits ranking.
  - `unknown ownership has one row`: direct/pipeline/nested owner rollups plus one unattributed row.
  - `missing child never creates human row`: nested run with missing child transcript and no parent_run_id is Unattributed before backfill; after owner evidence arrives, its credits move exactly once to the human row with total unchanged.
  - `rolling selection ages out silently`: advance a 24h window until one of two selected aligned keys leaves; response succeeds, echoes only the retained key, downstream totals match it, range bars/totals stay whole. All keys pruned -> empty selection/full range.
  - `grammar is explicit`: custom missing either bound and duplicate values fail; presets ignore supplied from/to.
  - `custom caps and SQL index use`: 93 days accepted, longer rejected; EXPLAIN bounded indexes.
  - `pace ignores custom historical range`: current billing pace is unaffected by historical or bucket selection.
  Assertions: `expect(data.sessions.limit).toBe(10)`; `expect(selected.pace).toEqual(unselected.pace)`; `expect(selected.total).toEqual(unselected.total)`; `expect(selected.flow.total).toEqual(selected.selectedTotal)`; `expect(firstPage.rows).toEqual(data.sessions.rows)`.
- [x] **Step 2: Run RED.** Run query-overview-v4.test.ts and query-sessions.test.ts; expect absent new queries.
- [x] **Step 3: Implement focused route queries.**
  - Intersect well-formed selection with timeBuckets keys before reading the cube and echo it in range.buckets. Read one cube for that effective range, derive downstream totals, and read the separate billing window for pace.
  - Model note uses a deterministic strongest source with percentage where known; no inferred prompt composition.
  - Use range summary counts for total sessions/runs and top-three share.
  - Validate optional sessions unit/buckets exactly as Overview.
- [x] **Step 4: Run GREEN.** Run both new tests; `npm run -s typecheck`; expect consistent routes, no retired generic endpoint dependency.
- [x] **Step 5: Fresh reviewer gate.** Review exact parameter validation, selection invariants, stable pagination and bounded plans; leave uncommitted.

### Task 8: Implement whole-session query and transit inputs

**Files:**
- Create: `usage/query-session.ts`, `tests/query-session.test.ts`.

**Interfaces:**
- Consumes shared owner/cube/correction functions, v4 sessions/runs and stable model styles.
- Produces `querySession(ctx: DashboardQueryContext, id: string, tz: string): SessionData`, `sessionPeriod(ctx: DashboardQueryContext, id: string): Period | null`, `sessionRoute(id: string): DashboardRoute`. Task 10 derives the envelope period in the reader snapshot from the returned span; null span uses `{ start: now, end: now }` as an empty transport period, not invented activity.
- Resolve supported stored ids exactly, plus fixed `UNATTRIBUTED_SESSION_ID`. Unknown ids throw DashboardQueryError("not-found"); a known metadata-only session returns empty SessionData, not 404.
- Compute span at query time via indexed MIN/MAX(ts) over canonical calls for the owner and mapped children, never cached metadata activity. End is MAX(ts)+1 ms; no calls -> span null. Use canonical own-call order `(ts,id)`; >5min gaps are idle, >30min splits active periods.
- Return one `ownCallBins` aggregate per active period, not per-call ownCalls. Preserve the raw count in stats.ownCalls and compute gaps/next-call cache-write values server-side. Request all next-call ids in one bounded `readCorrectedComponents` operation, then omit those ids from the wire. Each idleGaps entry contains only start, end and cacheWriteCredits; derive duration as end - start, with no per-gap ids or copied periods.

- [x] **Step 1: Write failing tests.**
  - `old session ignores Overview range`: historical fixture returns every lifetime selected call including last call and nested children.
  - `header models flow and runs reconcile`: sum role/model credits equals header, direct-run totals do not recursively duplicate descendant usage. Zero-call runs remain in the runs list if owned, without invented cost/model.
  - `statuses use facts`: done -> completed, failed/cancelled keep their pills; queued/running/paused without end -> running, unknown/null -> null, never guessed completed.
  - `idle thresholds are strict`: exactly 5 minutes is not idle, exactly 30 minutes is not collapsed; 5 minutes + 1 ms is dotted, 30 minutes + 1 ms splits periods. Cache-write credits use `readCorrectedComponents` for the next canonical own call, under the same daily factor as its total.
  - `running and report-only runs are honest`: missing times/duration/model do not borrow a neighboring model, aggregate chronology is not fabricated.
  - `whole lifetime beyond 93 days`: long synthetic session returns all chunks, including child activity beyond a stale metadata span.
  - `six month payload is bounded`: fixture about six months with 50000 own calls in 250 active periods and 300 runs; within the periods include at least 10000 idle gaps between 5 minutes + 1 ms and 30 minutes, plus >30-minute boundaries between periods. Use short call bursts for the remaining calls so the entire fixture stays within six months. It returns HTTP 200 through an exact-path fixture adapter, serializing the full envelope under `RESPONSE_CAPS_V4["/api/session/<id>"]`; stats.ownCalls === 50000 and bins reconcile with own-call totals, with no per-call ownCalls wire list. Task 10 repeats through the production matcher.
  - `own calls without runs`: baseline-only inputs, empty runs list/state, own-calls-only flow and exact totals.
  - `known session without calls`: HTTP 200, header/name/project intact, span null, zero stats, empty bins/runs/flow, no calls recorded state.
  - `unknown and unattributed identities`: unknown is not-found; synthetic owner detail returns one consistent flow and span.
  - `session query uses scoped index`: EXPLAIN uses calls_session_read plus owner mapping, not a whole-ledger raw call scan.
  Assertions:
  - `expect(data.flow.total).toEqual(data.total)`
  - `expect(data.span?.end).toBe(lastCallTs + 1)`
  - `expect(longReply.status).toBe(200)`; `expect(Buffer.byteLength(longReply.body, "utf8")).toBeLessThanOrEqual(RESPONSE_CAPS_V4["/api/session/<id>"])`
  - `expect(longData.stats.ownCalls).toBe(50000)`; `expect(longData.ownCallBins).toHaveLength(250)`; `expect(longData.runs).toHaveLength(300)`; `expect(longData.idleGaps.length).toBeGreaterThanOrEqual(10000)`
  - `expect(longData.idleGaps.every(g => Object.keys(g).sort().join(",") === "cacheWriteCredits,end,start")).toBe(true)`
  - `expect(data.runs.map(r => r.status)).toEqual(["completed", "cancelled", "failed", "running", "running", "running", null])`
  - `expect(data.idleGaps.map(g => g.end - g.start)).toEqual([300001, 1800001])` for the isolated threshold fixture.
- [x] **Step 2: Run RED.** Run query-session.test.ts; expect absent whole-session query.
- [x] **Step 3: Implement SessionData and period resolution.**
  - Resolve indexed query-time span over owner/mapped children; include every canonical lifetime call, with no Overview filter or generic detail/relationship requests.
  - Attach distinct runs/compaction; compute own sequence, gaps and active periods server-side. Send aggregated ownCallBins and count, never the raw own-call sequence; serialize compact idleGaps with only start/end/cacheWriteCredits, no nextCallId, durationMs or copied period. Separate auxiliary/warmer from own calls.
  - Batch corrected next-call components under Task 5 limits; derive the same shared flow/models.
  - Join status by metadata identity using the mappings above; retain unavailable values. Known no-call sessions return the header/empty state; zero-run sessions retain baseline/own flow only.
- [x] **Step 4: Run GREEN.** Run query-session.test.ts and selection-v3-detail.test.ts; `npm run -s typecheck`; expect exact lifetime membership, honest nulls and index-plan assertions.
- [x] **Step 5: Fresh reviewer gate.** Review ownership, report-only timeline limits, terminal statuses, threshold boundaries and long-session memory; leave uncommitted.

### Task 9: Implement Calibration & data and Status queries

**Files:**
- Create: `usage/source-error-diagnostics.ts`, `usage/counter-intervals.ts`, `usage/ingestion-status.ts`, `usage/query-calibration.ts`, `tests/query-calibration.test.ts`, `tests/ingestion-status.test.ts`.
- Reference/extract without deleting: `usage/query-reconciliation.ts:18-45,69-109`, `usage/query-source-errors.ts`, `usage/rates.ts`.

**Interfaces:**
- Consumes existing calibration service, rate versions, selected-call helpers, collector publication and leases/import_state.
- Produces preserved diagnostic exports in source-error-diagnostics.ts: `sourceErrorLabel(value: string | null, fallback: string): string`, `sourceErrorCode(value: string): string`, `readSourceErrorDiagnostics(db: Db, limit: number): { rows: readonly SourceErrorRow[]; truncated: boolean }`. Task 17 redirects ledger.ts/doctor.ts consumers there before deleting the retired route module.
- Produces `readCounterIntervals(ctx: DashboardQueryContext, period: Period): readonly CounterInterval[]`, `readIngestionStatus(ctx: DashboardQueryContext): CalibrationData["ingestion"]`, `queryStatusV4(ctx: DashboardQueryContext): StatusData`, `queryCalibration(ctx: DashboardQueryContext): CalibrationData`, `CALIBRATION_V4_ROUTES: readonly DashboardRoute[]` for exact `/api/status` and `/api/calibration`.
- Calibration default evidence is the current billing period in UTC; intervals are newest first; response returns the period's full small interval list, web initially shows 10. Account counter delta and published estimate use exactly matching accepted intervals, not the absolute used figure. Rate numbers are published credits per 1M tokens, converted from existing public USD rates at 100 credits/USD. Expose one row per tier with tier name, abovePromptTokens and source date. Stored cache-write 0 displays/prices as 0; only genuinely unavailable values are null.

- [x] **Step 1: Write failing tests.**
  - `matched correction summary is evidence not whole month`: both sums use matching intervals; factor/status follows existing engine.
  - `counter gaps remain null`: no snapshot evidence -> null day, never zero; accepted zero delta remains numeric zero. Cross-midnight intervals are grouped by later UTC endpoint with no invented apportionment, and published comparison uses the same matched spans.
  - `rates and unpriced counts are truthful`: source date and 100 credits/USD conversion correct; a two-tier model yields two rows with exact tier/abovePromptTokens thresholds; stored cacheWrite 0 remains numeric/displayed 0, genuine null stays unavailable, unknown models are not priced at zero.
  - `collector distinguishes caller privately`: live pi owner matching viewer -> this-session, another -> another-session, dashboard -> dashboard-server, expired/no owner -> none; no owner/session id in JSON.
  - `ingestion has UTC today and redacted errors`: selected-call count only, tracked files from import state, unknown codes sanitized, paths redacted, five-minute dashboard staleness handled by web.
  - `gaps count missing model compaction`: unpriced and model-less compaction are distinct diagnostics.
  - `status has build freshness and unavailable fallback shape`: fields remain present even with no ledger/counter.
  - `snapshot interval query is indexed`: EXPLAIN uses counter_snapshots_ts and bounded call indexes.
  Assertions: `expect(data.daily[0].counterDelta).toBeNull()` for an uncovered day; `expect(data.daily[1].counterDelta).toBe(0)` for an accepted zero pair; `expect(status.collector).toBe("this-session")`; `expect(JSON.stringify(status)).not.toContain(ownerId)`.
- [x] **Step 2: Run RED.** Run query-calibration.test.ts and ingestion-status.test.ts; expect absent new query functions.
- [x] **Step 3: Implement focused evidence queries.**
  - Extract accepted-pair/redacted-error behavior into new focused helpers; retain engine maths.
  - Show calibrated/back-applied/published-only/counter-unavailable status from actual evidence.
  - Read live lease state rather than interpreting follower as the collector.
  - Preserve later-endpoint UTC interval grouping and honest missing observations; short UI copy will disclose observed intervals, not imply precise calendar-day billing.
  - Do not read raw counter responses.
- [x] **Step 4: Run GREEN.** Run both new tests plus calibration.test.ts and calibration-invalid-anchor.test.ts; `npm run -s typecheck`; expect immutable engine results and no private fields.
- [x] **Step 5: Fresh reviewer gate.** Review matched-span comparisons, null gaps, collector expiry, rate units and redaction; leave uncommitted.

### Task 10: Integrate the five authenticated HTTP routes

**Files:**
- Modify: `usage/api-routes.ts:1-9`, `usage/server.ts:10-38,61-80,81-101,155-187,203-240`, `usage/dashboard-reader.ts:35-93`, `usage/server-runtime.ts:14-15,55-82` and mint call sites, `usage/server-entry.ts:24-48,112-117`, `usage/dashboard-command.ts:35-42`, `usage/dashboard-contract.ts` reader/status transport definitions from Task 1.
- Create: `tests/redesign-api.test.ts`.
- Modify only expected response shapes, preserving assertions: `tests/server-security.test.ts`, `tests/server-runtime.test.ts`, `tests/dashboard-command.test.ts`, `tests/server-entry.test.ts`.

**Interfaces:**
- Consumes Task 2 DashboardAssetsError/loadDashboardAssets/dashboardDir boot and fixed self-only CSP; Task 7/8/9 route/query exports and Task 16 `UsageConfig.monthlyBudget`. Keep Task 2 memory-only asset mapping unchanged.
- Produces exactly the Task 1 HTTP mapping, keeping HEAD behavior and snapshot transactions. Declare explicit `responseCaps` for all five routes using Task 1 `RESPONSE_CAPS_V4`: status 8 KiB, overview 1 MiB, sessions 512 KiB, session 2 MiB, calibration 1 MiB. Dynamic session lookup uses the matched route's template key `/api/session/<id>`, never the raw pathname/default cap; compare UTF-8 envelope bytes directly. Dynamic session matcher accepts exactly one supported id segment. Optional openerSessionId is sent only through the bearer-authenticated local mint request, stored in nonce/cookie context, injected privately as ctx.viewerSessionId and never exposed in URL/JSON/logs. Reused server mints the correct caller context anew.
- Reader budget callback reads current normalized global usage config from the already supplied calibration config file, never a ledger write. `serverBuild` and rateVersions stay in status for launcher build-reuse validation.

- [x] **Step 1: Write failing HTTP tests.**
  - `five route envelopes match fixture contracts`: boot isolated fixture server, bootstrap once, assert all responses/types/periods.
  - `session 404 has no generic retry body`: status 404 and exact SessionNotFound; unsupported id -> 400; traversal/extra path segment never matches.
  - `retired routes return not-found`: every spec section 11 removal is 404, not an alias.
  - `security survives new paths`: unauthorized without cookie, forbidden cross-origin/unsafe metadata, single-use nonce, self-only external-asset CSP and read-only reader unchanged; authenticated hashed JS/CSS still served from the Task 2 memory map.
  - `two opener sessions on one reused server`: separate minted cookie contexts classify collector independently, no ids on wire.
  - `budget changes apply live`: configured positive budget affects the next Overview response without restart.
  - `status remains available without ledger`: exact new DTO, null timestamps and none collector.
  - `full session envelope ignores Overview bounds`: no old start/end preflight applies to session route; span/envelope resolve within the same reader snapshot and known no-call session returns 200 with empty period.
  - `all five caps are enforced`: each matched route uses its explicit cap, including dynamic session and no-ledger status fallback; oversized envelopes return 413 response-limit. Repeat Task 8's six-month/50000-call/300-run fixture with at least 10000 compact idle gaps through the real matcher: HTTP 200, all gaps/runs retained and UTF-8 body <= `RESPONSE_CAPS_V4["/api/session/<id>"]` (2 MiB).
  Assertions: `expect(reply.status).toBe(404)`; `expect(reply.body).toEqual({ apiVersion: 1, error: { code: "not-found", message: "Session not found" } })`; `expect(unauthenticated.status).toBe(401)`; `expect(crossOrigin.status).toBe(403)`.
- [x] **Step 2: Run RED.** Run redesign-api.test.ts; expect missing dynamic route/new contract integration.
- [x] **Step 3: Wire focused routes and private context.**
  - Replace old registration/preflight with focused route validation and explicit byte caps, including dynamic session/fallback status. Do not use retired parseSlice/parsePage.
  - Resolve session envelope span inside the same reader snapshot; null span uses the empty transport period from Task 8. Override only session not-found body; retain generic fixed path-free errors.
  - Validate opener header after bearer/transport gates, bind to credentials, and preserve origin/security parsing.
  - Keep status fallback build validation and reloadable settings.
- [x] **Step 4: Run GREEN.** Run redesign-api.test.ts plus server-security.test.ts, server-runtime.test.ts, server-entry.test.ts, dashboard-command.test.ts and server-ingest.test.ts; `npm run -s typecheck`.
- [x] **Step 5: Fresh reviewer gate.** Review dynamic matching, session 404, fallback envelopes, nonce caller context, security regression and read-only access. Leave uncommitted.

### Task 11: Replace the shell and shared browser primitives

**Files:**
- Modify: `web/app.ts:1-39` and shell lifecycle, `web/views.ts`, `web/navigation.ts`, `web/theme.css`, `web/fonts.ts`, `web/client.ts`, `web/format.ts`, `web/charts.ts`, `web/tables.ts`, `web/dom.ts`, `web/representation.ts`.
- Create: `web/flow.ts`, `web/model-style.ts`, `web/state-examples.ts`, `tests/web-shell-v4.test.ts`, `tests/web-primitives-v4.test.ts`, `tests/web-contrast.test.ts`.
- Migrate shell callers/tests that need the new mount types: `tests/web-app.test.ts`, `tests/web-entry.test.ts`, `tests/web-fix-round.test.ts`, `tests/web-review-c.test.ts`; retain their non-retired lifecycle/focus assertions. Replace obsolete shell-integration test cases in `tests/web-detail-registration.test.ts`, `tests/web-explorer.test.ts`, `tests/web-cache.test.ts`, `tests/web-overview.test.ts` with compile-safe imports of the injected new shell where they test shared behavior; retired-page assertions remain until Task 17 removes those files. These test files are released to Task 17 after this gate.
- Modify released Task 2 `web/states.ts`, `web/states.css` for the shared shell/component examples; register only shell/primitives here.
- Test fixture modification: `tests/fixtures/plain-dom.ts` only when an actual missing DOM event API needs support; do not turn it into a browser framework.

**Interfaces:**
- Consumes Task 1 DashboardPageContext/PageMount/RouteV4, FixtureStateCase/fixtureStateCases JSON and typed client; Task 2 HTML/hashed CSS/script entry, browser boundary and direct-font-file transport. No reintroduction of embedded HTML or inline styles/scripts.
- Produces `startDashboard(options?: DashboardOptions): DashboardPage` with injectable `mounts: Partial<Record<DashboardRouteV4["page"], DashboardPageMount>>`. This task tests injected mounts and temporarily renders an unavailable section for any absent mount, without importing not-yet-created page modules. Task 17 wires the three production mounts. Keep legacy ViewContext/MountedView/ViewRoute exports and old helper signatures until Task 17 so retired modules still typecheck.
- Produces `routeHash(route: DashboardRouteV4): string`, `hashRoute(hash: string, now: number, tz: string): DashboardRouteV4`, `formatValue(value: Value, unit: Unit): string`, `formatLocalTime(ts: number, tz: string): string`, `formatUtcTime(ts: number): string`.
- Defines CSS tokens: `--usage-ground: #16120f`, `--usage-surface: #201a16`, `--usage-control: #332b24`, `--usage-ink: #f3eadb`, `--usage-muted: #c4b7a8`, `--usage-border: #493d33`, `--usage-hatch: #c4b7a8`, `--usage-danger: #f8785c`, `--usage-focus-ring: #91c7e5`; model tomato/sky/sage/mustard `#f8785c/#91c7e5/#8fbf8a/#e5b840`; role own/workers/reviewers/others `#f3eadb/#46b5aa/#da91bc/#a395e4`; freshness fresh/stale `#8fbf8a/#9b9690`. Each model/role/freshness value has its own `--usage-model-*`, `--usage-role-*`, or `--usage-freshness-*` token. Page lanes reuse these; they never edit theme.css.
- Produces `chartPair(document: Document, options: { id: string; title: string; svg: SVGElement; table: HTMLTableElement }): HTMLElement`, `renderFlow(document: Document, flow: FlowData, unit: Unit, id: string): HTMLElement`, `renderModelMarker(document: Document, style: ModelStyle): HTMLElement`, `sectionState(root: HTMLElement, state: "loading" | "empty" | "error", message: string, retry?: () => void): void`. Existing renderTable/tableRegion/element/action/liveMessage survive.
- Produces `renderStateExamples(root: HTMLElement, mounts: Partial<Record<DashboardRouteV4["page"], DashboardPageMount>>, cases: readonly FixtureStateCase[]): Promise<void>` in web/state-examples.ts; cases use isolated roots, fixture-backed clients and bounded settled loading/empty/error/success renders. Page lanes export `mountOverviewStates`, `mountSessionStates`, `mountCalibrationStates` (each `(root: HTMLElement, cases: readonly FixtureStateCase[]) => Promise<void>`) from separate web/states-overview.ts, states-session.ts, states-calibration.ts, respectively. Each states module also exports `pageMount: DashboardPageMount` and `page: DashboardRouteV4["page"]`. Before Task 17, states.ts uses `import.meta.glob("./states-*.ts", { eager: true })` to discover only existing page modules inside web; `/states.html?page=<page>&scenario=<scenario>` mounts the actual startDashboard with these injectable mounts instead of the gallery (root is not usage-app). This fixture-only entry lets each e2e spec run GREEN before production registration, without duplicated UI or a shared registry edit. Task 17 replaces discovery with explicit final registry imports and moves page specs to index.html; parallel writers only create their own states module.

- [x] **Step 1: Write failing tests.**
  - `only three hash pages and default seven days`: #/ default, #/session/id and #/calibration parse; unknown routes -> Overview; URL range/unit/selected starts reload exactly.
  - `back uses dashboard history or remembered Overview`: direct entry falls back to last range/unit/selection, not an old calendar month.
  - `freshness is five minutes`: at 300000 ms fresh, above grey #9b9690; tooltip/label contain last update.
  - `slow refresh cannot overwrite a new route`: aborted/out-of-order responses do not repaint; hidden tabs stop automatic 60s refresh and dispose aborts all pending work.
  - `each state settles and retries correctly`: empty/errors never leave loading; typed not-found is nonretryable.
  - `unparseable session id stays local`: malformed percent encoding or decoded unsupported id preserves a Session route with invalid sentinel id `""`; Session not found/Back renders with zero requests, not generic Retry or Overview.
  - `font and CSP boundary`: installed text/code/wordmark families first, remote Fira Sans/Cascadia Code/Bebas Neue font files from fonts.gstatic.com only if needed, offline renders system fallback; no Google Sans or fonts.googleapis.com stylesheet link under style-src self.
  - `primitives pair equal numbers`: Chart/Table persists per chart and focus survives refresh.
  - `text contrast pairs meet AA`: derive actual text/background pairs from CSS declarations using theme tokens, resolving inheritance, not a hand-written colour list. Assert >=4.5 for normal text, >=3 for large text (>=24px or bold >=18.67px); newly used token pairs must join this check. Model colours are not relied on as body text.
  - `shell has no rail or shipped contract`: only menu/nav/status/refresh, no design metadata.
  Assertions: `expect(hashRoute("#/unknown", now, "UTC").page).toBe("overview")`; `expect(formatLocalTime(fixtureTuesday, "UTC")).toBe("Tue 6 OCT 09:12")`; `expect(root.querySelector(".usage-rail")).toBeNull()`; `expect(lastPaintedRoute).toBe(currentRoute)`.
- [x] **Step 2: Run RED.** Run web-shell-v4.test.ts, web-primitives-v4.test.ts and web-contrast.test.ts; expect old shell/fonts/route assertions to fail.
- [x] **Step 3: Implement shell/primitives against fixture page mounts.**
  - Menu uses ground/bottom border, monochrome currentColor web mark, Bebas Neue SPIDER only, nav pills Overview/Calibration & data, right freshness/refresh.
  - Replace the legacy remote font families through Task 2 FontFace transport without changing CSP. Define the complete tokens above; one rounded 1px-border box per section, never nested. Use stylesheet/SVG attributes, no unsafe HTML or CSP-forbidden style attributes.
  - Dates Fri 2 OCT, times Tue 6 OCT 09:12; repeated hours have offset-bearing accessible labels. API whitelist contains exactly the new routes with validated ids.
  - Default credits; carry unit into Session/remembered Overview. Nav/freshness survive page errors; abort/dispose stale requests.
  - Released signatures/injected mounts unblock pages; Task 17 owns production imports. Retain deprecated helper wrappers until that cleanup.
- [x] **Step 4: Run GREEN and classify compatibility failures.**
  - Run the three new tests plus web-primitives.test.ts and dashboard-assets.test.ts; adjust obsolete basis assertions only in new primitives tests until Task 17.
  - Also run dashboard-bundle.test.ts, web-theme.test.ts and server-security.test.ts. Record every failure as an expected visual pin (old font/theme only, owned by Task 17) or a regression; fix regressions here, never absorb them into the retirement rewrite.
  - CSP and packaging assertions must stay green throughout. A recorded visual-pin failure is not a passing command.
  - Run `npm run -s typecheck`; expect exit 0, browser-only graph and offline shell.
- [x] **Step 5: Fresh reviewer gate.** Review keyboard/navigation/abort behavior, CSS/font/CSP compatibility and contrast. Release stable shared helpers to page lanes; leave uncommitted.

### Task 12: Add the installed-browser Playwright harness and CI smoke

**Files:**
- Create: `playwright.config.ts`, `scripts/usage-dashboard-playwright.mjs`, `scripts/usage-dashboard-e2e-server.mjs`, `scripts/usage-dashboard-e2e-real-server.mjs`, `packages/host/src/usage/e2e/fixtures.ts`, `packages/host/src/usage/e2e/smoke.e2e.ts`, `packages/host/src/usage/e2e/real-server.e2e.ts`, `packages/host/src/usage/e2e/profile-location.e2e.ts`, `tests/playwright-config.test.ts`.
- Modify after Task 2 script handoff: package.json `test:e2e` only, `.github/workflows/ci.yml`, `.gitignore`, `tsconfig.json` include (add root `playwright.config.ts`), `vitest.config.ts` coverage excludes (add `packages/host/src/usage/e2e/**` without changing test include). Add `playwright-results/` and `playwright-report/` ignores; do not install or modify dependencies.

**Interfaces:**
- Consumes Task 1 fixture builders/envelope, Task 2 config/states catalogue/assets/real-server boot, Task 11 actual shell/nav/status client.
- Prerequisites 1, 2 and 11 make the smoke independently green without inventing a replacement shell or waiting for the three page implementations.
- Config: `testDir: "packages/host/src/usage/e2e"`, `testMatch: "**/*.e2e.ts"`.
- One chromium project, headless. Channel `process.env.SPIDER_PLAYWRIGHT_CHANNEL || (process.env.CI ? "chrome" : "msedge")`; exactly the six launch args in Global Constraints.
- Timeout 60s, expect timeout 15s, webServer timeout 180s, one worker locally/CI, no browser download and no missing-browser skip.
- Vitest keeps `include: ["packages/**/src/**/*.test.ts"]`; e2e suffixes are outside it.
- `playwright.config.ts` exports a side-effect-free config: importing it never mutates process.env or creates directories.
- The test:e2e launcher and CI set absolute scratch TMPDIR before the CLI loads; webServer/browser subprocesses inherit it.
- Keep HOME unchanged.
- Local outputDir `.spider/scratch/playwright/results/`, HTML report `.spider/scratch/playwright/report/`; CI outputDir `playwright-results/`, report `playwright-report/`.
- Retain trace on failure and screenshot on failure; Task 18 adds explicit review screenshots for all states.
- Results never ship or get committed.
- Add root `playwright.config.ts` to tsconfig.json include so `npm run -s typecheck` covers it.
- Exclude `packages/host/src/usage/e2e/**` from Vitest coverage, not typechecking.
- `webServer.command` invokes `node scripts/usage-dashboard-e2e-server.mjs`; port is validated integer `SPIDER_PLAYWRIGHT_PORT` or 4177, shared through the command env/baseURL/readiness URL.
- The controller supplies distinct ports in parallel lane briefs.
- Build Vite `mode: "e2e"` with absolute outDir `.spider/scratch/playwright/site/`, then serve only its static index/states/assets on 127.0.0.1 (owned port, no reuseExistingServer), ready endpoint and production-equivalent CSP.
- It has no fixture API or user roots.
- Server readiness checks never open a database.
- Terminate owned server process/group in teardown, SIGKILL any survivor.
- `installFixtureRoutes(page: Page, scenario?: "default" | "no-data" | "no-budget" | "counter-unavailable" | "over-pace" | "stale" | "unknown-session" | "error"): Promise<void>` in e2e/fixtures.ts.
- Produces `expectNoBrowserErrors(page: Page): () => readonly string[]` in e2e/fixtures.ts.
- `page.route("**/api/**", ...)` answers exact routes from fresh Task 1 builders, including fixture-only `/api/fixture-states`.
- Unexpected API paths fail; errors/typed 404 are explicit.
- Expose request counters and replaceable fixtures for refresh, selection and Retry tests.
- Block unrelated outbound traffic; font-blocked cases still render fallback.
- `startRealUsageFixture(): Promise<{ bootstrapUrl: string; origin: string; stop(): Promise<void> }>` in e2e/fixtures.ts.
- Real fixture invokes the real-server script with an absolute scratch SPIDER_GLOBAL_ROOT, synthetic ledger/registry/session directories, sanitized PI env and polling/account access disabled.
- Bootstrap startup record and ledger are synthetic; run the actual bundle's server mode/boot entry and actual cookie/API transport, not the static server or page.route.
- Build the extension and a production-mode dashboard once in setup into absolute owned `.spider/scratch/playwright/real-dist/{extension.js,dashboard/}`, never the repo's dist/.
- Launch that scratch extension so its bundle-relative dashboardDir resolves to the adjacent production dashboard (no states.html).
- Native externals resolve through the repo's node_modules.
- Do not invoke extension factory/organism/model.
- Close browser and SIGKILL only owned fixture PIDs on every path.
- `test:e2e` becomes `node scripts/usage-dashboard-playwright.mjs`.
- Launcher creates project scratch dirs and sets TMPDIR before loading the Playwright CLI.
- Launcher forwards arguments to the installed node_modules/playwright/cli.js test command using process.execPath (no npx/install/download locally).
- CI adds steps inside the existing ubuntu build job after its production build/shape gate.
- Check `command -v google-chrome` and its version first (missing Chrome fails).
- Run `npx --no-install playwright test` with CI set, sanitized PI env and owned scratch npm cache/log.
- Create/export TMPDIR as `.spider/scratch/playwright/tmp/` before npx starts, not inside config.
- Step timeout 15 minutes, job timeout 35 minutes.
- `actions/upload-artifact@v4` with `if: failure()` uploads playwright-results/playwright-report, not profiles/ledgers.
- Keep the required job name unchanged; existing CI npm ci is not a worker install instruction.

- [x] **Step 1: Write failing configuration and browser specs.**
  - `installed browser policy`: Vitest config assertions pin suffix/include disjointness, e2e coverage exclusion, root config typecheck inclusion, channel precedence (override/CI/local), exact args, headless, output paths, early TMPDIR in launcher/CI before CLI import, owned port validation and no install/download command. Snapshot process.env before config import; assert import has no env/filesystem side effects, and restore env in finally after channel-precedence tests.
  - `profiles stay in scratch`: assert realpath(os.tmpdir()) is under `.spider/scratch/playwright/tmp/`, then snapshot its profile directories and those in HOME/default system temp (read-only observations, never scratch writes there). Launch through the real config; assert a new `playwright_chromiumdev_profile-*` directory exists on disk under that scratch TMPDIR while the browser is live, and HOME is unchanged. Close browser/context in finally; assert the new profile directory is gone and HOME/default system temp gained no profile. Do not use Browser.getBrowserCommandLine, CDPSession or any custom CDP transport.
  - `shell smoke refreshes fixture status`: load actual shell, assert Overview and Calibration & data nav pills, fresh/stale dot from statusFixture, click refresh and observe a new /api/status request and updated dot/last-update label; assert no browser exceptions. Missing page mounts may show the Task 11 unavailable state until Task 17 integrates pages; do not fake nav/status behavior.
  - `real server bootstrap and one API call`: pin setup's extension and production-dashboard outputs under scratch real-dist, snapshot repo dist hashes before/after setup and teardown and assert unchanged; assert scratch dashboard has no states.html. Real synthetic server, reject unauthenticated page/asset, visit single-use bootstrap, assert HttpOnly SameSite=Strict cookie, loaded page/asset and one successful real /api/status envelope with apiVersion 1 and serverBuild; second bootstrap use fails. Until Task 10 HTTP integration, assert the existing common transport fields, not an invented v4 server response; the final integrated run pins the full Task 1 StatusData shape. No page.route interception in this spec, no live roots/account/model calls.
- [x] **Step 2: Run RED.** Run playwright-config.test.ts with Vitest and `npm run test:e2e -- --grep "profiles stay|shell smoke|real server"`; retain missing harness/config assertions, not a skipped or missing-installed-browser run.
- [x] **Step 3: Implement config, static fixture transport, isolated real-server setup and CI steps.** Build states to scratch, use Task 1 builders through page.route, set TMPDIR before launch, preserve real HOME, and make startup/teardown bounded. No new browser transport or production API.
- [x] **Step 4: Run GREEN.** Repeat configuration test and selected Playwright specs, `npm run -s typecheck`; check workflow/upload/ignore definitions statically. Report executed counts/channel/profile path locally and no surviving fixture process. CI must execute Chrome specs, never an opt-in skip.
- [x] **Step 5: Fresh reviewer gate.** Review actual temp-profile proof, fixture-only routing, unmocked real-server coverage, failures/timeouts/artifact policy and Vitest separation. Release read-only harness helpers to Tasks 13-15 and 18; leave uncommitted.

### Task 13: Build Overview and its pace interaction

**Files:**
- Create: `web/overview-v4.ts` using Task 11 page mount signature. Task 17 removes the old `web/overview.ts` and renames this new file to `web/overview.ts` after old imports/tests are retired.
- Create: `web/overview.css`, `web/overview.css.d.ts`, `web/pace.ts`, `web/states-overview.ts`, `tests/web-overview-v4.test.ts`, `tests/web-pace.test.ts`, `e2e/overview.e2e.ts`.

**Interfaces:**
- Consumes Task 1 OverviewDataV4/SessionsData, Task 11 format/chartPair/renderFlow/model marker/page context/renderStateExamples, and Task 12 installed-browser fixture routing/request counters. Wait for Tasks 11 and 12; unit and e2e tests remain separate.
- Produces `mountOverview(ctx: DashboardPageContext): DashboardPage` from `web/overview-v4.ts`, `renderPace(document: Document, pace: Pace, now: number): HTMLElement`, and Task 11 mountOverviewStates signature. Export `pageMount = mountOverview`, `page = "overview"`; its e2e spec uses Task 11 `/states.html?page=overview&scenario=default` until Task 17 registers it in app.ts and moves tests to index.html. It uses the real shell/page, not duplicated test UI.
- GET Overview with URL range/from/to/tz/unit/buckets. For Sessions expansion/sort, convert the resolved Overview bounds to `range=custom` in the request only, with identical from/to/tz/unit/effective buckets plus sort/offset/limit; leave the Overview URL's preset unchanged. This freezes paging without asking a preset to honour from/to.
- Refresh replaces data/resets expansion; discard pages from different bounds/revisions. Range changes clear selection, unit changes preserve it.
- After response, reconcile effective selection/resolved bounds via `ctx.navigate({ page: "overview", query: data.range }, { replace: true })`; update the URL and remembered state without a request/history loop.

- [x] **Step 1: Write failing DOM tests and e2e/overview.e2e.ts specs.**
  - `browser Overview interactions and keyboard`: real page fixture mount, ring-anchored pace hover/focus and Escape without blur; Cmd/Ctrl-click, click-away, arrows/modified Enter/Space/Escape selection with exact request buckets and echoed totals/hash; sessions sort/Show all/row click and Enter open; each Chart | Table has equal values and keyboard focus. Intercept responses via Task 12, never live data.
  - `pace is topmost standalone bar without ticks`: no surrounding heading/box/big-number tiles, used on fill or just after short fill, OCT for October calendar period, `to 14 NOV` for a period starting mid-month/resetting 15 November UTC; ring/hatch, no even-pace or limit tick.
  - `pace overflow clamps`: used 120/scale 100 -> fill/ring at end, danger, in-bar `120 · 20 over`; projected 250/scale 100 -> hatch stops at end, not a rescaled bar; null scale/used 80 -> figure 80 without proportional fill, popover used/projected/days left.
  - `pace keyboard popover anchors and closes`: focus/hover opens at ring, Escape closes without blur, resize clamps while pointer stays aligned; rows month/year, used, budget, even pace, projection, allowance, remaining, days left.
  - `no budget omits budget/even rows`: allowance scale and exact hint `/spider config set usage.monthlyBudget <credits> --global`; unavailable counter and account-wide use disclosed; danger projection/overAtPace shown.
  - `noncontiguous bucket keyboard selection`: Cmd/Ctrl click, modified Enter, ordinary Space toggle; arrows move roving tabindex; ordinary click focuses only, outside click/Escape clears, controls preserve selection.
  - `selected downstream totals are real fixture data`: bars/range chips retain full range, selected chip/model/session/flow/table values match selectedTotal rather than multiplying by a percentage.
  - `panels and session controls`: Models is the only daily legend, rank/shape/source notes/unpriced line, role pills once, wide segment labels/tooltips, sortable list starts at 10 then Show all N, row click/Enter opens actual id.
  - `range unit and states`: 24h/hourly and tokens change all headings/values, custom local bounds >93d rejected; every empty/error state settles with Retry only for recoverable errors.
  - `out of order expansion cannot mix selection`: only latest range/buckets appear; paging sends range=custom and echoed from/to while the hash retains its rolling preset.
  - `server pruning rewrites URL`: aged-out requested key disappears from hash/remembered selection after response, retaining the surviving key/totals; replace history without remount/refetch, and reload uses the pruned URL.
  - `DST fall-back bars are distinct`: America/New_York repeated 01:00 hours have two keys and offset-bearing labels (`UTC-04:00`, `UTC-05:00`); keyboard selects both independently, request/totals retain both.
  Assertions: `expect(request.params.get("buckets")).toBe(JSON.stringify([firstKey, thirdKey]))`; `expect(root.querySelector(".even-pace-tick")).toBeNull()`; `expect(visibleSessionRows).toHaveLength(10)`; `expect(noBudgetPopover.textContent).not.toContain("Even pace")`.
- [x] **Step 2: Run RED.** Run web-overview-v4.test.ts/web-pace.test.ts and `npm run test:e2e -- packages/host/src/usage/e2e/overview.e2e.ts`; expect missing page/interaction assertions, not missing-browser skips.
- [x] **Step 3: Implement the Overview layout/interactions.**
  - Follow approved mock with spec overrides: Daily two-thirds/Models one-third, equal height, Total/Average per bucket/Peak chips, no legend under bars.
  - Stacked SVG and same-number tables; numeric session/run/top3 summaries, full-width flow nodes with value/share; role tooltip carries role/credits/tokens/share/runs.
  - Pace remains credits. Clamp fill, ring and hatch to scale end; past scale use danger, used overflow reads `<used> · <n> over`. No even-pace or limit tick. Null scale shows used without proportional fill and used/projected/days-left popover.
  - Calendar billing period label uses its UTC start month (OCT); a start not on day 1 reads `to <day-before-reset UTC date>` (to 14 NOV). Keep label at the bar's empty end when space exists.
  - Anchor focusable popover to ring; omit no-budget rows and show the exact global slash hint. Danger ring/hatch/popover follow over-pace/budget flags.
  - Keep distinct offset-labelled repeated-hour bars; reconcile server-pruned selection into URL/remembered state. Ordinary right click never selects; Playwright covers the platform modifier and contextmenu behavior.
  - Never zero-fill all-unpriced values or add basis suffixes.
- [x] **Step 4: Run GREEN.** Run both DOM tests, web-contrast.test.ts and the Overview Playwright command; `npm run -s typecheck`. Assert synthetic fixture mounts and no old endpoint requests; retain exact unit/e2e counts separately. Extend Overview states examples (pace, selection, models, sessions, flow, Chart/Table, loading/empty/error).
- [x] **Step 5: Fresh reviewer gate.** Review selection/table reconciliation, pace anchoring/overflow states, sorting/paging, keyboard and no explanatory-design copy; leave uncommitted.

### Task 14: Build Session and the mirrored transit route

**Files:**
- Create: `web/session.ts`, `web/session-route.ts`, `web/session.css`, `web/session.css.d.ts`, `web/states-session.ts`, `tests/web-session.test.ts`, `tests/session-route-layout.test.ts`, `e2e/session.e2e.ts`.

**Interfaces:**
- Consumes SessionData and Task 11 format/chartPair/renderFlow/model marker/page context/renderStateExamples; Task 12 fixture route harness. Wait for Tasks 11 and 12. Session API needs only tz; receives both credits/tokens. Export Task 11 mountSessionStates signature plus `pageMount = mountSession`, `page = "session"`; use `/states.html?page=session&scenario=default` until Task 17 production registration.
- Produces `mountSession(ctx: DashboardPageContext): DashboardPage`, `layoutSessionRoute(data: SessionData, unit: Unit, width: number): RouteLayout`, `renderSessionRoute(document: Document, data: SessionData, unit: Unit, selectRun: (id: string | null) => void): HTMLElement`.
- `RouteLayout = { branches: readonly { runId: string | null; side: -1 | 1; height: number; startX: number; endX: number }[]; breaks: readonly { period: Period; startX: number; width: number }[]; maxValue: number }`. Fixed collapsed break width is 28px; run side minimizes overlap with deterministic id tie-break; absolute y uses one mirrored linear scale, never log/rank scaling. Branch joints are 45 degrees.

- [x] **Step 1: Write failing DOM/layout tests and e2e/session.e2e.ts specs.**
  - `browser transit and runs keyboard paths`: route hover dims other branches, click pins the real runs-table row, Escape clears with focus retained; Tab/arrows/Enter reach/activate branches and runs rows; sort/Show all preserves data; Chart | Table switches using keyboard with identical lifetime totals, Back restores remembered Overview. Use Task 12 page.route fixtures and assert no stale card after navigation.
  - `header and flow reconcile`: total/run/own/compaction/idle stats, project folder pill, complete span, unit carries, no pace.
  - `branch cost is mirrored linear height`: values 10/20 have heights in ratio 1:2 on equal scale; Tokens uses independent raw counts.
  - `idle collapse preserves run endpoints`: >30min gap -> 28px break with actual duration tooltip; >5min dotted gap exposes next-call cache-write credits, no labels at rest.
  - `overlap chooses quieter side deterministically`: stable side assignments under input reorder.
  - `status mark grammar`: completed ring, cancelled x, failed danger x, running open ring at right; unavailable evidence labelled unavailable, never a completion ring.
  - `route focus and pinning`: Tab/arrows/Enter work, focus dims other branches and shows all run card fields; click pins matching runs row and Escape clears without losing focus.
  - `tables show and sort`: runs start at 20/Show all, columns start/name/role/model/thinking/credits/tokens/duration/status, models calls/credits/tokens/share; Chart/Table route has same data.
  - `typed 404 settles`: Session not found with Back only, no retry/relationships/spinner.
  - `unparseable id makes no request`: unsupported/undecodable hash ids render the same Back-only state, client request count 0.
  - `zero runs and zero calls render honestly`: own-only fixture has baseline/empty runs state/own flow; metadata-only fixture keeps header, no span/chart and exactly one no-calls line.
  - `navigation cancels stale lifetime response`: no old session card after id change.
  Assertions: `expect(layout.branches[1].height / layout.branches[0].height).toBeCloseTo(2)`; `expect(layout.breaks[0].width).toBe(28)`; `expect(visibleRunRows).toHaveLength(20)`; `expect(notFoundRoot.textContent).toContain("Session not found")`; `expect(retryButtons).toHaveLength(0)`.
- [x] **Step 2: Run RED.** Run web-session.test.ts/session-route-layout.test.ts and `npm run test:e2e -- packages/host/src/usage/e2e/session.e2e.ts`; expect missing page/layout/browser interactions.
- [x] **Step 3: Implement Session page and deterministic route.**
  - Use ownCallBins on y=0, coloured model branches, compaction ticks, collapsed idle periods and mirrored linear Credits per run/Tokens per run axis. Fit active periods, not dormant months.
  - No runs -> baseline only/empty runs state/own-calls-only flow. Null span -> header and one line saying no calls were recorded, never fabricated activity.
  - Validate id before client.get; unsupported/undecodable ids render Session not found/Back without a request or Retry.
  - No labels at rest; focused/hovered/pinned card exposes all run fields. Preserve covered/report-only/zero-cost rows with honest unavailable values.
  - Sorting changes table order only; flow reconciles with header.
- [x] **Step 4: Run GREEN.** Run both DOM/layout tests, web-contrast.test.ts and the Session Playwright command; `npm run -s typecheck`. Expect stable geometry, deterministic keyboard/pinning, no retired detail calls and separate unit/e2e counts. Extend Session states examples for header/route/run marks/idle breaks/tables/flow, own-only, no-calls, 404 and errors.
- [x] **Step 5: Fresh reviewer gate.** Review long idle transforms, branch crossings, linear scale, marks/unknown evidence, row pinning, keyboard and typed 404; leave uncommitted.

### Task 15: Build Calibration & data

**Files:**
- Create: `web/calibration.ts`, `web/calibration.css`, `web/calibration.css.d.ts`, `web/states-calibration.ts`, `tests/web-calibration.test.ts`, `e2e/calibration.e2e.ts`.

**Interfaces:**
- Consumes CalibrationData and Task 11 formatUtcTime/chartPair/renderTable/tableRegion/page context/renderStateExamples; Task 12 fixture route harness. Wait for Tasks 11 and 12. Export Task 11 mountCalibrationStates signature plus `pageMount = mountCalibration`, `page = "calibration"`; use `/states.html?page=calibration&scenario=default` until Task 17 production registration.
- Produces `mountCalibration(ctx: DashboardPageContext): DashboardPage`; fetch exactly `/api/calibration` with no inherited Overview filters or tz/unit parameters. Calibration rates/correction remain credits; token-rate columns explicitly say per 1M tokens.

- [x] **Step 1: Write failing DOM tests and e2e/calibration.e2e.ts specs.**
  - `browser calibration table and keyboard`: navigate by nav pill, switch Chart | Table with keyboard and compare null/zero/credit values, Tab/Enter/Space on Show more expands newest-first intervals from 10, rate tiers/zero/unavailable remain honest, Retry settles without stale navigation. Use Task 12 page.route and actual mounted page.
  - `correction has matched figures and status`: factor, published/account matched totals, hours and all four status pills; <=2 plain explanatory sentences.
  - `honest UTC gaps`: null counter days break SVG line and show unavailable in table; zero accepted delta displays 0, intervals start/end UTC newest-first, first 10 then Show more.
  - `rates include source date and tiers`: one row per tier with tier/abovePromptTokens, input/cache read/cache write/output per million; stored 0 displays 0, genuine null displays unavailable, unpriced counts visible.
  - `ingestion shows truthful source`: collector label, last ingest, files/calls today/errors, redacted path list or short empty state, unpriced/model-less compaction/counter-day gaps.
  - `failures end loading`: error Retry refreshes same section/page, abort during route navigation never paints stale content.
  - `no pace or design explanation`: no basis labels outside correction, no inherited preview controls.
  Assertions: `expect(visibleIntervalRows).toHaveLength(10)`; `expect(gapCell.textContent).toBe("unavailable")`; `expect(root.querySelector(".pace-bar")).toBeNull()`; `expect(request.path).toBe("/api/calibration")`.
- [x] **Step 2: Run RED.** Run web-calibration.test.ts and `npm run test:e2e -- packages/host/src/usage/e2e/calibration.e2e.ts`; expect missing page/table/keyboard behavior.
- [x] **Step 3: Implement the three non-nested sections.**
  - Correction chart/table and expandable interval table; Rates and unpriced models; Ingestion facts/errors/gaps.
  - Use short UTC interval coverage copy to distinguish observed deltas from exact calendar-day billing.
  - Keep count/reason labels, not explanatory design prose.
  - Match the approved mock (path given in each task brief), but omit nested section boxes and prototype design options.
- [x] **Step 4: Run GREEN.** Run web-calibration.test.ts, web-contrast.test.ts and the Calibration Playwright command; `npm run -s typecheck`. Expect equal chart/table values, keyboard Show more, offline content and separate unit/e2e counts. Extend correction/rates/ingestion states examples with every correction status, honest gaps, loading/empty/error and expanded intervals.
- [x] **Step 5: Fresh reviewer gate.** Review UTC/matched interval semantics, honest gaps, state settling and concise copy; leave uncommitted.

### Task 16: Register optional monthly budget and replace footer copy

**Files:**
- Modify: `usage/config.ts:1-32`, `packages/host/src/control.ts:17-19,149-169,189-201`, `packages/ui/src/screens/config-schema.ts:3-6,62-68,98-110`, `usage/footer.ts:18-30,99-133`, `usage/mount.ts:81-88,101-105`, `usage/protocol.ts`, `usage/worker-entry.ts` only footer month snapshot fields/calculation after Task 4.
- Modify: `tests/config.test.ts`, `tests/config-tool.test.ts`, `tests/footer-layout.test.ts`, `tests/footer-state.test.ts`, `tests/mount.test.ts`, `packages/ui/src/screens/__tests__/config-schema.test.ts`.
- Modify: `docs/guide/configuration.md:7,75-79,114`. Task 17 owns usage.md.

**Interfaces:**
- Consumes computePace/billingPeriod (Task 6), corrected cube/projector (Task 5), collector publication from Task 4.
- Produces the exact flat config key `usage.monthlyBudget` and optional `UsageConfig.monthlyBudget?: number` (normalized read returns undefined when unset), USAGE_DEFAULTS entry unset (undefined, never zero), strict-positive finite validator, UI optional-number coercion where blank unsets and positive fraction is valid. Extend ConfigField only as needed with `optional?: boolean` and `exclusiveMin?: number`, respecting unrelated number fields.
- FooterInput gains `monthlyBudget?: number` and `monthUsed?: number | null`; worker snapshot supplies corrected monthUsed fallback. Pure renderUsageFooter reads no DB/config and takes budget denominator before available entitlement. Server consumes the normalized config through Task 10 callback.

- [x] **Step 1: Write failing tests.**
  - `budget defaults unset and is global only`: global positive value accepted, local diagnosed/ignored, tool rejects local set, unset clears without zero.
  - `strict positive coercion`: 0/negative/NaN/infinity/nonnumeric rejected; blank -> undefined, 0.5 accepted; other existing nonnegative fields unchanged.
  - `footer has credits without basis markers`: synthetic `45.2%/200k · 1.2k credits · CH92.1% · month 24% · ↑… ↓… · R… W…` shape, context item first, with cal/est/?/~ /+ and AIC absent from credit segment.
  - `month budget wins allowance`: used 48/budget 200 -> 24%, unset with allowance 400 ->12%; used 49/budget 200 rounds to month 25% (whole percent, never 24.5%); valid stale snapshot and no-counter corrected fallback use shared billing semantics.
  - `unavailable month omitted`: no usable used/denominator does not emit NaN or month ?.
  - `narrow footer keeps whole items`: existing context/model/thinking priority and terminal-width bounds maintained.
  - `live setting refreshes footer and snapshot`: no model calls, no new poller or DB work on render.
  Assertions: `expect(readUsageConfig({}, {}).value.monthlyBudget).toBeUndefined()`; `expect(coerce(budgetField, "")).toEqual({ ok: true, value: undefined })`; `expect(coerce(budgetField, "0").ok).toBe(false)`; `expect(statsLine).toContain("month 24%")`; `expect(creditSegment).not.toMatch(/AIC|cal|est|[~+?]/)`.
- [x] **Step 2: Run RED.** Run the modified config/footer/UI schema tests; expect unsupported key and old footer text.
- [x] **Step 3: Implement budget and plain footer.**
  - Register global-only optional positive usage.monthlyBudget in screen/control. Executable examples: `/spider config set usage.monthlyBudget <credits> --global` and `/spider config unset usage.monthlyBudget --global`.
  - Tool form remains `command:"config" op:"set" key:"usage.monthlyBudget" value:<number> scope:"global"`.
  - Preserve context item first, then corrected credits/CH/month/tokens with middle dots. Month is `Math.round(100 * used / denominator)` plus %, budget first/allowance second.
  - Use worker-computed monthUsed for counter fallback and normalized live budget. Footer traversal/render never opens the ledger.
  - Document unset default, positive constraint, live behavior, exact global slash examples and read-only dashboard setting boundary.
- [x] **Step 4: Run GREEN.** Run all listed tests plus mount.test.ts; `npm run -s typecheck`. Assert existing FooterAccumulator token counting and lease/poller behavior unchanged.
- [x] **Step 5: Fresh reviewer gate.** Review config validation/provenance, blank unset, live callbacks, pure width-safe footer and no-counter month math. Leave uncommitted.

### Task 17: Retire obsolete surfaces, routes and tests; rewrite the guide

**Files:**
- Remove old `web/overview.ts`; rename `web/overview-v4.ts` to `web/overview.ts`, then wire mountOverview/mountSession/mountCalibration into app.ts using the Task 1 interfaces.
- Modify after page/harness handoff: `web/states.ts` for explicit final module registration and `e2e/smoke.e2e.ts`, `e2e/overview.e2e.ts`, `e2e/session.e2e.ts`, `e2e/calibration.e2e.ts` to exercise production index.html instead of the pre-integration states fixture entry; update `e2e/real-server.e2e.ts` to assert the full StatusData response.
- Remove web modules: `web/explorer.ts`, `web/cache.ts`, `web/context.ts`, `web/detail.ts`, `web/detail.css`, `web/detail.css.d.ts`, `web/detail-navigation.ts`, `web/rates.ts`, `web/reconciliation.ts`, `web/pager.ts`, `web/analysis-shared.ts`.
- Remove legacy query modules after extracted helper imports are migrated: `usage/query-explorer.ts`, `usage/query-cache.ts`, `usage/query-detail.ts`, `usage/query-rates.ts`, `usage/query-reconciliation.ts`, `usage/query-source-errors.ts`, `usage/query-overview.ts`.
- Modify shared dead exports/imports only after all lanes release them: `usage/dashboard-contract.ts`, `usage/dashboard-reader.ts`, `usage/dashboard-selection.ts`, `usage/ledger.ts:2`, `usage/doctor.ts:9`, `web/format.ts`, `web/charts.ts`, `web/client.ts`, `web/app.ts` registration/import cleanup if needed.
- Remove: `scripts/usage-dashboard-assets.mjs`, `scripts/usage-dashboard-cdp.mjs`, `scripts/usage-dashboard-cdp.d.mts`, `scripts/usage-dashboard-screenshot.mjs`, `scripts/usage-dashboard-screenshot.d.mts`, and the virtual module declaration from `web/browser.d.ts` (retain surviving CSS declarations). Remove their tests `tests/dashboard-visual.test.ts`, `tests/visual-script.test.ts`, `tests/web-detail-visual.test.ts`, `tests/screenshot-lifecycle.test.ts`, `tests/dashboard-browser-fixture.test.ts`, `tests/cdp-transport.test.ts`; migrate any surviving lifecycle/transport safety assertion to Task 12 Playwright/Task 2 asset tests first.
- Update `tests/web-app.test.ts`, `tests/web-fix-round.test.ts` and `tests/web-review-c.test.ts`: remove browser-capture cases/imports of the outgoing dashboard/all-view fixtures and screenshot script once Task 12 smoke and Tasks 13-15 interaction specs cover the same behavior; retain plain-DOM lifecycle/focus assertions. Do not delete these three test files.
- Rewrite: `docs/guide/usage.md`, `tests/dashboard-bundle.test.ts`, `tests/query-cross-route-consistency.test.ts`, `tests/dashboard-api.test.ts`, `tests/dashboard-contract.test.ts`, `tests/dashboard-perf.test.ts`, `tests/dashboard-benchmark.test.ts`, `tests/dashboard-assets.test.ts`; adapt `scripts/usage-dashboard-benchmark.mjs` and its declarations if they enumerate old routes.
- Remove retired query tests: `tests/query-cache.test.ts`, `tests/query-detail.test.ts`, `tests/query-detail-round2.test.ts`, `tests/query-detail-round3.test.ts`, `tests/query-explorer.test.ts`, `tests/query-explorer-round2.test.ts`, `tests/query-explorer-round3.test.ts`, `tests/query-explorer-final.test.ts`, `tests/query-explorer-fix.test.ts`, `tests/query-explorer-perf.test.ts`, `tests/query-rates.test.ts`, `tests/query-reconciliation.test.ts`, `tests/query-reconciliation-density.test.ts`, `tests/query-source-errors.test.ts`, `tests/query-overview.test.ts`. Move surviving shared/privacy/interval assertions into the new query tests first.
- Remove retired web tests: `tests/web-analysis.test.ts`, `tests/web-cache.test.ts`, `tests/web-context.test.ts`, `tests/web-detail.test.ts`, `tests/web-detail-cursors.test.ts`, `tests/web-detail-registration.test.ts`, `tests/web-detail-theme.test.ts`, `tests/web-explorer.test.ts`, `tests/web-overview.test.ts`, `tests/web-rates.test.ts`, `tests/web-reconciliation.test.ts`. Its former detail visual coverage is now in e2e/session.e2e.ts and Task 18 Playwright acceptance; do not create another opt-in Vitest visual suite.
- Migrate preserved engine/selection/diagnostic tests importing retired readers: `tests/selection-v3.test.ts`, `tests/selection-v3-analysis.test.ts`, `tests/selection-v3-detail.test.ts`, `tests/selection-v3-fixes.test.ts`, `tests/selection-v3-final.test.ts`, `tests/selection-v3-benchmark.test.ts`, `tests/calibration-capability.test.ts`, `tests/calibration-differential.test.ts`, `tests/calibration-periods.test.ts`, `tests/aic-display.test.ts`, `tests/query-review-b.test.ts`, `tests/doctor-diagnostics.test.ts`, `tests/server.test.ts`, `tests/server-fix.test.ts`, `tests/server-security.test.ts`, `tests/dashboard-command.test.ts`, `tests/web-primitives.test.ts`, `tests/web-theme.test.ts`, `tests/web-css-types.test.ts`. Latest-version expectations in runtime.test.ts, dashboard-reader.test.ts, dashboard-perf.test.ts and server-round2.test.ts become 4; explicit legacy fixture assertions stay frozen.
- Preserve frozen SQL/selection fixtures. `tests/fixtures/overview-v2-frozen.ts` needs its retired querySourceErrors import redirected to a test-only `tests/fixtures/source-errors-legacy.ts` adapter preserving its original behavior; frozen query/selection logic stays unchanged. Remove `tests/fixtures/dashboard-browser-fixture.ts` and `tests/fixtures/all-view-browser-fixture.ts` with their legacy capture consumers; Task 1 builders and Task 12 routing replace them. Audit imports first, including script declarations. Record the remove/migrate/retain list in scratch before edits and audit for any additional imports, without deleting shared differential/redaction assertions.
- Create: `tests/redesign-retirement.test.ts`.

**Interfaces:**
- Consumes all new query/page functions, Task 2 split build/asset loader and Task 12 Playwright fixtures/specs. Produces only three production page registrations/five public API routes, final states.ts imports of the three disjoint page-state modules, a basis-free browser graph, revised guide and preserved selection/redaction/security/calibration coverage. E2e fixture-entry injection is removed after real production registrations become available; specs now exercise actual app.ts.
- Keep dimension-values.ts, dimension_values and immutable schema-v3.ts. Keep dashboard-identities.ts/keys and selected-call helpers. Keep composition-provider.ts only if a surviving reader/ledger consumer requires its internal type; otherwise remove its import and dead file together. Keep numeric/token/time format helpers, chart/table/dom/client/fonts/representation; delete marker/old-discovery-only helpers only when import audit proves them dead.

- [x] **Step 1: Write failing retirement tests.**
  - `bundle contains only new surfaces and no basis markers`: old route/view registration names absent, three new mounts present, direction contract absent.
  - `obsolete endpoints are unreachable`: every removed API returns 404 through authenticated fixture server.
  - `cross route totals match`: Overview selectedTotal, Sessions rows and Session lifetime slice reconcile in synthetic overlapping fixtures through the shared projector.
  - `dictionary and privacy foundations survive`: schema still has dimension_values, redaction regression fixtures pass through the replacement queries.
  - `bundle pins new fonts/theme not security relaxation`: new families/direct fonts.gstatic.com sources and self-only script/style CSP asserted; external HTML references resolve to hashed JS/CSS, no inline code/styles or virtual module, no states in production, exact dist shape/cap and source-free packaging retained.
  - `guide matches controls`: 7d/credits defaults, 93d custom, Session lifetime, budget command and new footer, no retired navigation instructions; contributor note pins `npm run dev:dashboard` for UI work and `npm run build:dashboard` plus a server restart for checks against real data.
  Assertions: `expect(retiredAuthenticatedReplies.every(r => r.status === 404)).toBe(true)`; `expect(stylesheet).toContain("#16120f")`; `expect(fontUrl).not.toContain("Google+Sans")`; `expect(selectedTotal.credits).toBeCloseTo(sumValues(sessionValues).credits!, 10)`.
- [x] **Step 2: Run RED.** Run redesign-retirement.test.ts plus updated cross-route/bundle tests; expect retired modules/expectations remain.
- [x] **Step 3: Apply the audited removals and docs.**
  - Redirect reusable interval/error/rate assertions to Task 9 first. Delete the now-dead nested build/virtual declaration/CDP/screenshot harness and tests, audit all remaining imports, and register final page/state mounts without weakening security. Drive interaction specs through production app.ts after this handoff.
  - Rewrite old UX/performance tests for bounded indexed queries, not wall-clock thresholds.
  - Retain security/lifecycle/worker-bundle and all canonical differential/redaction evidence.
  - Guide explains three pages, Chart/Table/keyboard, correction gaps/account-wide pace, positive optional budget with `/spider config set usage.monthlyBudget <credits> --global` and `/spider config unset usage.monthlyBudget --global`, unknown session Back state and context-first whole-percent footer; no real figures/paths or mock absolute location. Add a contributor note: UI work uses `npm run dev:dashboard` (fixture data); checks against real data require `npm run build:dashboard` plus a server restart because extension watch does not rebuild browser assets.
- [x] **Step 4: Run GREEN.**
  - Run redesign-retirement.test.ts, query-cross-route-consistency.test.ts, dashboard-api.test.ts, dashboard-contract.test.ts, dashboard-bundle.test.ts, worker-bundle.test.ts, dashboard-assets.test.ts and migrated privacy tests; `npm run -s typecheck`, then `npm run build`.
  - Expect the existing assert-bundle guard passes and no retired module import remains.
  - Run `npm run test:e2e` against final app.ts, including smoke/profile/real-server/page specs; expect no browser skips or exceptions and no legacy harness imports. Do not run the full Vitest suite yet.
- [x] **Step 5: Fresh reviewer gate.** Review the removal inventory, preserved shared regressions, packaging/CSP and guide accuracy. Leave uncommitted.

### Task 18: Add Playwright desktop visual and state acceptance

**Files:**
- Create: `e2e/visual-acceptance.e2e.ts`. Use read-only Task 12 fixtures/helpers and final Task 17 states registry; material UI fixes require exclusive handoff to the owning page lane, never edits during captures.
- Runtime screenshots/layout/contrast results: local `.spider/scratch/playwright/results/`; CI gitignored `playwright-results/` and `playwright-report/`. No committed pixel baselines, snapshots or replacement CDP scripts.

**Interfaces:**
- Consumes Tasks 1/12 fresh fixtureStateCases/installFixtureRoutes and Task 17 integrated app/states e2e artifact. Produces screenshots and behavior/layout/contrast assertions for every page and every section 9 state at widths 1280, 1440 and 1600 (height 1000), plus states.html's every-component/every-state examples at those widths. No phone matrix, opt-in browser flag or CI skip.
- Matrix: Overview/Session/Calibration, default/no data/no budget/counter unavailable/over pace or budget/stale/unknown session/network or server error. Apply states honestly: unknown id is the Session Back-only page, pages with no pace still render their own sections; states.html explicitly covers loading/success/empty/error, pace extremes, chart/table, run marks and popover/pinning examples.
- Computed layout assertions: Daily/Models boxes equal height within 1 px, document and each example have scrollWidth <= clientWidth, mark/wordmark centres within 1 px, pace popover pointer anchored to ring centre within 1 px before/after resize (popover may clamp but pointer stays aligned), no overlapping/clipped menu controls. Contrast derives every rendered text/background pair, compositing inherited/translucent backgrounds and classifying size/weight: >=4.5 normal, >=3 large (>=24px or bold >=18.67px). It is not a hard-coded palette-only check.
- Save named `page-state-width.png` full-page screenshots via `page.screenshot` and attach to test.info, not toHaveScreenshot pixel comparisons. Wait for bounded font/layout settlement; test blocked-font fallback explicitly. Review captures locally before forwarding; never real-account screenshots.

- [x] **Step 1: Write failing Playwright acceptance specs.**
  - `desktop page/state matrix`: section 9 fixtures at every width, all sections settle, no exceptions/horizontal overflow/nested boxes/even-pace tick, equal boxes and centred wordmark assertions above; unknown session has Back with zero Retry/spinner, network/server error Retry succeeds, stale dot is #9b9690.
  - `states page covers every component state`: fixture catalogue names match Task 1 cases, all example roots settle with no overflow, chart/table numbers agree, run marks/pace no-budget/null-scale/overflow states remain honest; production GET /states.html is 404 and its assets never ship.
  - `pace popover stays at ring`: hover/focus then Escape, resize at three widths, pointer/ring alignment above, short label placement and danger/overAtPace/no-budget copy.
  - `computed text contrast and offline fallback`: block remote fonts, assert usable fallback and all actual composited text pairs meet thresholds. Retain per-element failing records locally.
- [x] **Step 2: Run RED.** `npm run test:e2e -- packages/host/src/usage/e2e/visual-acceptance.e2e.ts`; keep failing layout/state assertions, not a missing browser or opt-in skip. Run local installed Edge; CI runs installed Chrome using the same config/spec.
- [x] **Step 3: Implement the acceptance matrix/assertions and review captures.** Use Task 12 page.route fixtures and final states examples. Compare approved mock with spec overrides. Capture one batched initial matrix and at most one reviewer-directed confirmation round, no per-tweak screenshot loop. No new browser transport, pixel baselines or source-data access.
- [x] **Step 4: Run GREEN.** Repeat visual acceptance, all page interaction/smoke/profile/real-server Playwright specs and `npm run -s typecheck`; retain exact executed counts, channel, screenshot inventory and zero leftover fixture PIDs. CI artifacts upload on failure through Task 12 workflow. No skipped browser run counts as success.
- [x] **Step 5: Fresh reviewer gate.** Review saved screenshots and computed behavior/layout/contrast records independently. Controller owns visual signoff and releases the synthetic built UI/captures for copied-data checking and Task 20 finish.

### Task 19: Check real data only on a supplied backup copy (controller)

**Files:**
- No tracked changes. Create checker/report under the controller-supplied absolute scratch root, named `real-data-check.mjs` and `REAL-DATA-REPORT.md`.

**Interfaces:**
- Consumes an explicitly authorized, frozen ledger backup and optional separately supplied metadata-source snapshot, never live roots/registry/config/account/counter. Controller makes a second writable scratch copy for migration; frozen input remains untouched. Build loaded query/server code against that copy with private synthetic launch roots, no ingest participant or poller.
- Produces local-only aggregate evidence: schema/selection consistency, ownership coverage counts, reconciliation differences/tolerances, API status counts, index plans and sanitized failures. No ids/names/paths/account values/transcript content/screenshots of real rows in tracked artifacts, CI or worker briefs.

- [ ] **Step 1: Write a failing checker safety test in scratch.**
  - Reject absent/relative/outside-scratch input, live-root discovery and default registry/config/account access.
  - Synthetic v3 backup: frozen input hash unchanged, only the second copy migrates.
  - Aggregate checks fail on a deliberately duplicated synthetic report and mismatched flow totals.
  Assertions: `expect(frozenHashAfter).toBe(frozenHashBefore)`; `expect(liveAccessAttempts).toEqual([])`; `expect(duplicateMutantResult.ok).toBe(false)`.
- [ ] **Step 2: Run RED on that synthetic harness.** Expect explicit invariant failures for the mutants, not a successful report; preserve evidence before using any supplied real copy.
- [ ] **Step 3: Implement/run the bounded copied-data check.**
  - Verify quick_check, unchanged v3 -> v4 selection, metadata/status coverage and honest missing evidence.
  - Check recent Overview, oldest nonempty Session without inherited range, paged sessions and local-zone selection.
  - Check the largest real session by canonical call count: authenticated response 200 and UTF-8 envelope <=2 MiB; report exact bytes locally only.
  - Check flow/model/role agreement, tier/zero/null rates and counter gaps, pace fallback and authenticated typed 404.
  - Assert EXPLAIN index use, not wall-clock thresholds.
  - Real metadata backfill uses only a supplied source snapshot; if absent report metadata fallback/coverage as limited, not a completed backfill check.
  - Never read or write the live ledger or launch a production collector.
- [ ] **Step 4: Verify the result.**
  - Run the checker under sanitized env with scratch SQLITE_TMPDIR/TMPDIR and no network.
  - Expected: all implemented invariants pass, any unavailable evidence explicitly reported, untouched input hash, no live access and no surviving owned process.
  - Report aggregates locally only; public handoff is invariant pass/fail and limitations, no real figures.
- [ ] **Step 5: Fresh controller reviewer gate.** Review the safety harness and aggregate report without source rows or production credentials. Record backup/migration checks and limitations; leave all tracked files uncommitted.

### Task 20: Impeccable finish and final verification (controller)

**Files:**
- Create from the built UI: `packages/host/DESIGN.md`, `packages/host/.impeccable/design.json`.
- Modify: `.gitignore`, adding `.impeccable/review/` and `.impeccable/questions/` (matching these folders under packages too).
- Runtime evidence only: copy valid synthetic screenshots from Task 18 Playwright results into `packages/host/.impeccable/review/`; keep detector result, finish verdict and documenter report in supplied scratch/review roots. Only DESIGN.md and `.impeccable/design.json` are intended for eventual commit, not review/questions evidence. Material fixes modify only the owning UI files from Tasks 11, 13, 14 and 15 with exclusive handoff, never concurrent writers.

**Interfaces:**
- Consumes Product, the approved spec, direction contract, approved mock (path given in each task brief), fixture-built artifact, Task 18 Playwright desktop/state captures and actual detector findings. Produces a fresh finish disposition and token-bearing DESIGN.md plus schemaVersion 2 sidecar describing the final built system, not a pre-build imagined design.
- The controller loads the Impeccable new-work/document references and invokes the installed launcher, not npm/npx downloads. No new concept round: approved direction is binding. Detector runs exactly once after UI completion. Finish reviewer is fresh/read-only; documenter runs only after its disposition is acted on.

- [ ] **Step 1: Establish failing finish assertions.**
  - Before documentation exists, assert token-bearing DESIGN.md/sidecar absent or incomplete.
  - Require all reused palette/type/shape/spacing/components and matching sidecar narrative; reject speculative rules. Assert `git check-ignore` covers review screenshots and questions, not DESIGN.md or design.json; finish screenshot inventory must come from Task 18 Playwright output, never the retired capture scripts.
  - Reject absolute paths/private figures/em-dashes/contract text in served artifacts; keep checker scratch-only.
  Assertions: `expect(designFrontmatter.colors).toBeDefined()`; `expect(sidecar.schemaVersion).toBe(2)`; `expect(sidecar.narrative.dos).toEqual(documentedDos)`; `expect(forbiddenArtifactMatches).toEqual([])` after the documenter writes.
- [ ] **Step 2: Run RED and the one detector.**
  - Save the missing-document assertion failure; add ignores and copy the reviewed Task 18 screenshots into packages/host/.impeccable/review/ before finish review.
  - Run installed `impeccable detect --json` once over changed browser targets, recording exit code/findings, not relabelling a nonzero result clean.
  - Fix mechanical findings in one batch and pass unresolved findings, screenshots and approved reference to the fresh `impeccable-finish-reviewer` with explicit write prohibition.
  - Desktop-only is the approved scope.
- [ ] **Step 3: Act on the disposition, then document.**
  - `ship`: proceed.
  - `fix`: one listed-fix batch, rebuild, rerun affected Playwright matrix at the same viewports, replace ignored review copies, fresh verdict scoring those fixes.
  - `recapture`: replace invalid evidence and run a full fresh review.
  - `rebuild`: rederive named regions and run a fresh full review.
  - No second detector or self-directed polishing loop.
  - Report actual verdict scope/remaining issues, do not convert partial approval to a whole-surface pass.
  - After accepted disposition, invoke `impeccable-documenter` with Product, final artifact/captures, document reference and write boundary limited to DESIGN.md/sidecar.
  - Include actual tokens/frontmatter, canonical heading order, focus/motion/breakpoint/component sidecar extensions and synthetic examples.
  - No raster ships unless provenance is verified; inline SVG data charts require no invented raster.
- [ ] **Step 4: Run final GREEN gate once.**
  - Run scratch documentation checker, `npm run -s typecheck`, full `npm test` once, then `npm run build` (extension, dashboard, guard) and the split-artifact bundle guard.
  - Run full `npm run test:e2e` against the final artifact; for reviewer-directed UI changes, include affected Playwright screenshot/layout confirmation and replace the ignored finish copies. CI must run installed Chrome with results uploaded on failure, never download a browser.
  - Record exact Vitest/Playwright counts and real-data limitations. Missing installed browser is a failure/blocker, never a disclosed passing skip.
  - A failure remains a failure; rerun only affected failing files once for an identified timing flake, never claim the failed command was a pass.
- [ ] **Step 5: Back up before any approved deployment link (controller).**
  - Before linking the new build, create a consistent backup of the existing deployment ledger under the supplied private scratch root using the approved controller backup procedure.
  - Verify backup quick_check/hash and retain it unchanged for recovery; record success before the new build is linked, since its first open migrates v4 one-way.
  - If deployment is not approved, do not link; hand off this explicit backup-before-link prerequisite.
- [ ] **Step 6: Final fresh controller review/handoff.**
  - Verify review/documentation complete, no retired production import, no forbidden shipped metadata, no local artifacts staged, no owned fixture processes, and every task gate/report accounted for.
  - Leave all changes uncommitted.
  - Report the finish disposition at its real scope and any unresolved blocker/limitation.

## Parallelism map

Every row is a separate writer lane/worktree. Gate dependencies mean both worker GREEN and fresh reviewer approval. Page lanes use Task 1 fixture clients/page.route, not a live API. Tasks 2 and 3 start together after Task 1; Task 12 follows the build and actual shell so its smoke can pass independently.

| Task | Waits for | Files exclusively owned while active | Can run alongside |
| --- | --- | --- | --- |
| 1 Contract | None | v4 contract, contract fixture/test, initial legacy context hooks | None until interface release |
| 2 Split build/assets | 1 | dashboard/extension configs, boundary/middleware, HTML/states scaffold, assets loader, build/scripts/boot/security/doctor tests, package.json scripts, release shape audit | 3-9, 16 once their prerequisites hold |
| 3 Ledger v4 | 1 | schema-v4, schema version, migrate, ledger, ledger-v4 fixtures/tests | 2, 11 after 2 |
| 4 Metadata/backfill | 3 | metadata/backfill/projection/ingest/discovery, ledger handoff, runtime/protocol/worker/mount identity, new tests | 2, 5, 11 after 2 |
| 5 Shared query/time | 3 | query-redesign-shared, time-buckets, new tests | 2, 4, 11 after 2 |
| 6 Billing pace | 5 | billing-pace and test | 2, 8, 9, 11-15 after their gates |
| 7 Overview/Sessions API | 4, 5, 6 | query-overview-v4 and its tests | 2, 8, 9, 11-16 after their gates |
| 8 Session API | 4, 5 | query-session and test | 2, 6, 7, 9, 11-16 after their gates |
| 9 Calibration/Status API | 4, 5 | query-calibration, counter-intervals, source-error-diagnostics, ingestion-status and tests | 2, 6-8, 11-16 after their gates |
| 10 HTTP integration | 2, 7, 8, 9, 16 | server/api-routes/reader/launcher/boot/command, legacy transport hooks, new HTTP/security shape tests | 11-15 after their gates |
| 11 Shell/primitives | 1, 2 | app/views/navigation/theme/fonts/client/format/charts/tables/dom/representation/flow/model marker, states extension, shell/contrast tests | 3-10, 16 after their gates |
| 12 Playwright harness | 1, 2, 11 | root config and tsconfig include/Vitest coverage excludes, e2e/static/real-server fixture helpers, smoke/profile specs, CI, .gitignore, released test:e2e script | 3-10, 16 after their gates |
| 13 Overview web + e2e | 11, 12 | overview-v4, overview.css, pace, plain-DOM tests, overview.e2e.ts, Overview states registration | 6-10, 14-16 |
| 14 Session web + e2e | 11, 12 | session, session-route, session.css, plain-DOM/layout tests, session.e2e.ts, Session states registration | 6-10, 13, 15, 16 |
| 15 Calibration web + e2e | 11, 12 | calibration, calibration.css, plain-DOM test, calibration.e2e.ts, Calibration states registration | 6-10, 13, 14, 16 |
| 16 Budget/footer | 4, 5, 6 | config/control/UI schema/footer, released mount/protocol/worker snapshot, existing footer/config tests, configuration guide | 2, 7-9, 11-15 after their gates |
| 17 Removals/docs | 2, 10, 12, 13, 14, 15, 16 | retired scripts/declaration/modules/tests, released app/states registrations/shared cleanup, usage guide, bundle/cross-route/perf compatibility tests | None of the released-file writers |
| 18 Playwright visual acceptance | 12, 17 | visual-acceptance.e2e.ts, review screenshot/layout/contrast matrix | No UI writer during captures |
| 19 Copied data | 18 | controller scratch copy/checker/report only | No competing query/migration writer |
| 20 Finish | 19 | exclusive controller finish handoffs, .gitignore, DESIGN.md/sidecar, runtime review copies, final gate | No concurrent writer or measurement |

Dependency spine: `1 -> {2,3}`; `3 -> {4,5}`; `5 -> 6`; `{4,5,6} -> {7,16}`; `{4,5} -> {8,9}`; `{1,2} -> 11`; `{1,2,11} -> 12`; `{11,12} -> {13,14,15}`; `{2,7,8,9,16} -> 10`; `{2,10,12,13,14,15,16} -> 17 -> 18 -> 19 -> 20`, with `12 -> 18`.

Within released waves, start disjoint workers concurrently up to the machine's worker limit; do not create concurrent writers on shared ledger/protocol/app/reader/build/package.json/.gitignore files. Page lanes add separate states registration modules; only Task 17 edits the central states registry after their release. All reviews use fresh read-only contexts. The controller prepares worktrees/dependencies, supplies absolute scratch/reference paths in each brief, coordinates shared-file handoffs and integrations, and executes the two final controller-only stages. CI runs all Playwright specs; local visual evidence uses installed Edge, with no browser skips accepted as a gate.
