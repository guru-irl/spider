import type { DashboardQueryContext, DashboardRoute } from "./dashboard-contract.js";
import type { FlowRole, ModelRow, OverviewDataV4, RangeQuery, SessionRow, SessionsData,
  SessionsQuery, SessionSort, Value } from "./dashboard-v4-contract.js";
import type { CounterSnapshot } from "./ledger.js";
import { billingPeriod, computePace } from "./billing-pace.js";
import { COUNTER_COLUMNS, counterSnapshot, latestValidCounter, type StoredCounter } from "./latest-valid-counter.js";
import { DAY_MS, invalidQuery, safeTimestamp, validateParams } from "./dashboard-selection.js";
import { flowFromCube, modelRows, readUsageCube, sessionRows, type UsageCube } from "./query-redesign-shared.js";
import { countedUsageSql, storedSelection } from "./schema.js";
import { resolveRange, timeBuckets } from "./time-buckets.js";

const RANGE_PARAMS = ["range", "from", "to", "tz", "unit", "buckets"];
const SESSION_PARAMS = [...RANGE_PARAMS, "sort", "offset", "limit"];
const bucketSize = (query: RangeQuery): "hour" | "day" => query.to - query.from <= 2 * DAY_MS ? "hour" : "day";

function paceSnapshots(ctx: DashboardQueryContext, now: number): readonly CounterSnapshot[] {
  const latest = latestValidCounter(ctx.db, now), period = billingPeriod(now, latest);
  // Keep invalid observations in the rate chain. Seven days before the period
  // also retains the possible bracketing anchor without scanning all history.
  const start = Math.max(0, period.start - 7 * DAY_MS);
  const rows = ctx.db.prepare(`SELECT ${COUNTER_COLUMNS} FROM counter_snapshots INDEXED BY counter_snapshots_ts
    WHERE ts>=? AND ts<=? ORDER BY ts,rowid`).all(start, now) as StoredCounter[];
  return [...(latest && latest.ts < start ? [latest] : []), ...rows.map(counterSnapshot)];
}

function parseRange(params: URLSearchParams, now: number, month: ReturnType<typeof billingPeriod>): RangeQuery {
  const raw = params.get("buckets");
  let requested: unknown = [];
  if (raw !== null) {
    try { requested = JSON.parse(raw); } catch { invalidQuery(); }
  }
  if (!Array.isArray(requested) || requested.some(key => !Number.isSafeInteger(key)) ||
    new Set(requested).size !== requested.length) invalidQuery();
  // Task 5's parser accepts legacy comma-separated keys. Resolve only its range
  // grammar here; v4 has a strict JSON selection grammar instead.
  const rangeParams = new URLSearchParams(params); rangeParams.delete("buckets");
  const range = resolveRange(rangeParams, now, month), size = bucketSize(range);
  for (const key of requested as number[]) {
    // Aligned keys can precede a clipped range, including the first local bucket
    // at the epoch. A rolling month can change from hours to days at 48h, so
    // validate either alignment, then intersect only the current bucket keys.
    const probe = Math.max(0, key);
    if (key < -DAY_MS || !safeTimestamp(probe) || !safeTimestamp(probe + 1)) invalidQuery();
    const instant = { start: probe, end: probe + 1 };
    if (timeBuckets(instant, range.tz, "hour")[0]?.key !== key &&
      timeBuckets(instant, range.tz, "day")[0]?.key !== key) invalidQuery();
  }
  const wanted = new Set(requested as number[]);
  return { ...range, buckets: timeBuckets({ start: range.from, end: range.to }, range.tz, size)
    .filter(bucket => wanted.has(bucket.key)).map(bucket => bucket.key) };
}
function rangeParams(query: RangeQuery): URLSearchParams {
  return new URLSearchParams({ range: query.range, from: String(query.from), to: String(query.to),
    tz: query.tz, unit: query.unit, buckets: JSON.stringify(query.buckets) });
}
function parsePaging(params: URLSearchParams): Pick<SessionsQuery, "sort" | "offset" | "limit"> {
  const sort = (params.get("sort") ?? "credits") as SessionSort;
  const integer = (name: string, fallback: number): number => {
    const raw = params.get(name);
    if (raw !== null && !/^\d+$/.test(raw)) invalidQuery();
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value)) invalidQuery();
    return value;
  };
  const offset = integer("offset", 0), limit = integer("limit", 10);
  if (!["credits", "last-active", "runs"].includes(sort) || offset < 0 || limit < 1 || limit > 200) invalidQuery();
  return { sort, offset, limit };
}
const compareId = (a: SessionRow, b: SessionRow): number => {
  // Unsupported stored ids are deliberately not drill-down ids. Their redacted
  // labels provide a deterministic fallback without putting private ids on wire.
  const left = a.id ?? a.name, right = b.id ?? b.name;
  return left < right ? -1 : left > right ? 1 : 0;
};
function pageSessions(cube: UsageCube, page: Pick<SessionsQuery, "sort" | "offset" | "limit">): SessionsData {
  const rows = [...sessionRows(cube)];
  const credits = (row: SessionRow) => row.value.credits ?? 0;
  const byCredits = [...rows].sort((a, b) => credits(b) - credits(a) || compareId(a, b));
  const totalCredits = rows.reduce((n, row) => n + credits(row), 0);
  const topCredits = byCredits.slice(0, 3).reduce((n, row) => n + credits(row), 0);
  const weight = page.sort === "credits" ? credits : page.sort === "last-active" ?
    (row: SessionRow) => row.lastActive : (row: SessionRow) => row.runs;
  rows.sort((a, b) => weight(b) - weight(a) || compareId(a, b));
  const next = page.offset + page.limit;
  // Count every displayed category, including Unattributed runs, so the chip,
  // Show all count and offsets describe the same list without dropping usage.
  return { rows: rows.slice(page.offset, next), total: rows.length, offset: page.offset, limit: page.limit,
    nextOffset: next < rows.length ? next : null,
    summary: { runs: rows.reduce((n, row) => n + row.runs, 0), top3Share: totalCredits > 0 ? topCredits / totalCredits : 0 } };
}
const SOURCE_LABELS: Record<FlowRole, string> = {
  own: "own calls", workers: "worker runs", reviewers: "reviewer runs", scouts: "scout runs",
  "other-runs": "other runs", compaction: "compaction calls", background: "background calls",
};
function modelsWithNotes(cube: UsageCube, query: RangeQuery): readonly ModelRow[] {
  const selected = new Set(query.buckets), rows = cube.rows.filter(row => !selected.size || selected.has(row.bucketKey));
  const weight = (value: Value) => query.unit === "tokens" ? value.tokens.total : value.credits ?? 0;
  return modelRows(cube).map(model => {
    const parts = rows.filter(row => row.model === model.id), denominator = weight(model.value);
    const sources = (Object.keys(SOURCE_LABELS) as FlowRole[]).map(role => ({ role,
      value: parts.filter(row => row.role === role).reduce((n, row) => n +
        (denominator > 0 ? weight(row.value) : row.value.calls), 0) }));
    // Stable role order breaks ties. With no priced weight, name the most common
    // actual source, but do not invent a percentage of unknown credits.
    sources.sort((a, b) => b.value - a.value);
    const main = sources[0]!;
    return { ...model, note: denominator > 0 ?
      `${Math.min(main.value < denominator ? 99 : 100, Math.round(100 * main.value / denominator))}% from ${SOURCE_LABELS[main.role]}` : `Mostly ${SOURCE_LABELS[main.role]}` };
  });
}
function unpricedReasons(ctx: DashboardQueryContext, cube: UsageCube, query: RangeQuery): OverviewDataV4["unpriced"] {
  if (cube.selectedTotal.unpricedCalls === 0) return [];
  const selected = new Set(query.buckets), pieces = cube.buckets.filter(bucket => !selected.size || selected.has(bucket.key))
    .map(({ start, end }) => ({ start, end }));
  const selection = countedUsageSql("c.ts>=? AND c.ts<?", "c.ts,c.price_status,c.unpriced_reason,c.run_id,c.is_report,c.source_file", "calls_period_read", storedSelection(ctx.db));
  return ctx.db.prepare(`WITH counted AS MATERIALIZED (${selection}),
    pieces AS (SELECT json_extract(value,'$.start') AS start,json_extract(value,'$.end') AS end FROM json_each(?))
    SELECT CASE WHEN c.unpriced_reason IN ('unknown-model','unsupported-provider','missing-attribution','no-rate-at-time','invalid-usage')
      THEN c.unpriced_reason ELSE 'unavailable' END AS reason,COUNT(*) AS calls
    FROM counted c JOIN pieces p ON c.ts>=p.start AND c.ts<p.end
    WHERE c.price_status='unpriced' GROUP BY reason ORDER BY calls DESC,reason`).all(query.from, query.to, JSON.stringify(pieces)) as OverviewDataV4["unpriced"];
}
function overview(ctx: DashboardQueryContext, query: RangeQuery, now: number, snapshots: readonly CounterSnapshot[]): OverviewDataV4 {
  const cube = readUsageCube(ctx, query), models = modelsWithNotes(cube, query);
  const billing = computePace({ now, snapshots, budget: undefined, correctedMonth: null, correctedWindow: null }).period;
  const month: RangeQuery = { range: "custom", from: billing.start, to: now, tz: "UTC", unit: "credits", buckets: [] };
  const monthCube = readUsageCube(ctx, month);
  const window = { ...month, from: Math.max(billing.start, now - 7 * DAY_MS) };
  const windowCube = window.from === month.from ? monthCube : readUsageCube(ctx, window);
  const pace = computePace({ now, snapshots, budget: ctx.monthlyBudget?.(),
    correctedMonth: monthCube.total.credits, correctedWindow: windowCube.total.credits });
  return { range: query, bucketSize: bucketSize(query), pace, total: cube.total, buckets: cube.buckets,
    selectedTotal: cube.selectedTotal, models, unpriced: unpricedReasons(ctx, cube, query),
    sessions: pageSessions(cube, { sort: "credits", offset: 0, limit: 10 }), flow: { ...flowFromCube(cube), models } };
}

export function queryOverviewV4(ctx: DashboardQueryContext, query: RangeQuery): OverviewDataV4 {
  const now = ctx.now(), snapshots = paceSnapshots(ctx, now);
  const month = computePace({ now, snapshots, budget: undefined, correctedMonth: null, correctedWindow: null }).period;
  return overview(ctx, parseRange(rangeParams(query), now, month), now, snapshots);
}
export function querySessions(ctx: DashboardQueryContext, query: SessionsQuery): SessionsData {
  const params = rangeParams(query);
  params.set("sort", query.sort); params.set("offset", String(query.offset)); params.set("limit", String(query.limit));
  return sessions(ctx, params);
}
function sessions(ctx: DashboardQueryContext, params: URLSearchParams): SessionsData {
  validateParams(params, SESSION_PARAMS);
  const now = ctx.now(), page = parsePaging(params);
  const month = billingPeriod(now, params.get("range") === "month" ? latestValidCounter(ctx.db, now) : undefined);
  return pageSessions(readUsageCube(ctx, parseRange(params, now, month)), page);
}

export const OVERVIEW_V4_ROUTES: readonly DashboardRoute[] = [
  { path: "/api/overview", handle(ctx, params) {
    validateParams(params, RANGE_PARAMS);
    const now = ctx.now(), snapshots = paceSnapshots(ctx, now);
    const month = computePace({ now, snapshots, budget: undefined, correctedMonth: null, correctedWindow: null }).period;
    return overview(ctx, parseRange(params, now, month), now, snapshots);
  }, responsePeriod(_ctx, _params, data) {
    const { from, to } = (data as OverviewDataV4).range;
    return { start: from, end: to };
  } },
  { path: "/api/sessions", handle: sessions, responsePeriod(ctx, params) {
    const now = ctx.now(), month = billingPeriod(now, params.get("range") === "month" ? latestValidCounter(ctx.db, now) : undefined);
    const { from, to } = parseRange(params, now, month);
    return { start: from, end: to };
  } },
];
