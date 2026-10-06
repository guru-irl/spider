import { DIMENSION_COLUMNS } from "./dimension-values.js";
import { initializeIds, opaqueId, supportedDetailId } from "./dashboard-identities.js";
import { type AicDisplay, type CalibrationResult, type DashboardQueryContext, type Dimension, type Slice, type UsageMeasure, type Page, type DashboardRoute, type FilterValue } from "./dashboard-contract.js";
import { compileSlice, invalidQuery, measureColumns, measureFromRow, type MeasureRow, validatePage, decodeCursor, encodeCursor, parseSlice, parsePage, validateParams, cursorWindow } from "./dashboard-selection.js";
import { storedSelection, countedUsageSql, selectionCtes, selectedPredicate } from "./schema.js";

export type ExplorerQuery = { slice: Slice; groupBy: readonly Dimension[]; page: { limit: number; cursor?: string } };
/** Keys are dimension-scoped opaque ids; labels are presentation only, clamped to 160 code points. */
export type ExplorerRow = { key: readonly (string | null)[]; labels: readonly (string | null)[]; measure: UsageMeasure };
export type ExplorerData = { groupBy: readonly Dimension[]; calibration: CalibrationResult; totals: UsageMeasure;
  rows: readonly ExplorerRow[]; nextCursor: string | null };

// Identifiers and expressions are trusted, never interpolated from request values.
const dimensions: Readonly<Record<Dimension, string>> = {
  ...DIMENSION_COLUMNS, day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')",
};
const isDimension = (field: unknown): field is Dimension => typeof field === "string" && Object.hasOwn(dimensions, field);
function explorerSlice(ctx: DashboardQueryContext, slice: Slice, batchIds = false): ReturnType<typeof compileSlice> {
  if (!Array.isArray(slice.filters)) invalidQuery();
  for (const filter of slice.filters as Slice["filters"]) {
    if (!filter || (filter.kind !== "missing" && (filter.kind !== "id" ||
      typeof filter.value !== "string" ||
      !(filter.field === "session" || filter.field === "run" ? supportedDetailId(filter.value) : opaqueId(filter.value))))) invalidQuery();
  }
  return compileSlice(slice, undefined, ctx, batchIds);
}
function afterKey(keys: readonly string[], after: readonly (string | null)[]): { sql: string; params: (string | null)[] } {
  const params: (string | null)[] = [];
  const branches = keys.map((column, i) => {
    const equal = keys.slice(0, i).map((prior, j) => { params.push(after[j]!); return `${prior} IS ?`; });
    if (after[i] === null) return [...equal, `${column} IS NOT NULL`].join(" AND ");
    params.push(after[i]!);
    return [...equal, `${column} > ?`].join(" AND ");
  });
  return { sql: branches.map(branch => `(${branch})`).join(" OR "), params };
}
function cursorKey(cursor: string, endpoint: string, ctx: DashboardQueryContext, query: unknown, fields: readonly (Dimension | undefined)[]): readonly (string | null)[] {
  const key = decodeCursor(cursor, endpoint, ctx.revision, query);
  if (key.length !== fields.length || key.some((value, i) => value !== null && (typeof value !== "string" ||
    (fields[i] === undefined ? Buffer.byteLength(value) > 640 : fields[i] === "session" || fields[i] === "run"
      ? value !== "" && !supportedDetailId(value) : !opaqueId(value))))) invalidQuery();
  return key as (string | null)[];
}
/** Count JSON bytes without serializing the response while the reader snapshot is held. */
function jsonBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "string") {
    let bytes = Buffer.byteLength(value) + 2;
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (char === '"' || char === "\\") bytes++;
      else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
      else if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) bytes += 3;
    }
    return bytes;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + jsonBytes(item), 0);
  const entries = Object.entries(value as Record<string, unknown>);
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, item]) => sum + jsonBytes(key) + 1 + jsonBytes(item), 0);
}
/** Shorten by bytes, preserving a cursor after the last returned row, not the lookahead. */
function boundedPage<T, R>(base: T, selected: R[], more: boolean, kib: number, cursor: (row: R) => string): T & Page<R> {
  for (;;) {
    const result = { ...base, rows: selected, nextCursor: more && selected.length ? cursor(selected.at(-1)!) : null };
    if (jsonBytes(result) <= kib * 1024 - 512) return result;
    // Every row's labels and ids are bounded well below the smallest page budget.
    selected.pop(); more = true;
  }
}
function outputCursor(endpoint: string, ctx: DashboardQueryContext, query: unknown, key: readonly (string | null)[], slice: Slice): string {
  return encodeCursor(endpoint, ctx.revision, query, key, { start: slice.start, end: slice.end });
}
type ValueRecord = { value: string | null; label: string | null; sort_label: string | null; count: number | null };
const VALUE_CACHE_ROWS = 4096;
const VALUE_CACHE_BYTES = 2 * 1024 * 1024;
type ValueCacheEntry = { base: string; prefix: string; rows: ValueRecord[]; bytes: number };
const valueCaches = new WeakMap<DashboardQueryContext["db"], { revision: string; entries: ValueCacheEntry[]; bytes: number }>();
const asciiFold = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase());
const compareValue = (a: string | null, b: string | null): number => a === b ? 0 : a === null ? -1 : b === null ? 1 : Buffer.compare(Buffer.from(a), Buffer.from(b));
function valueCache(ctx: DashboardQueryContext) {
  let cache = valueCaches.get(ctx.db);
  if (!cache || cache.revision !== ctx.revision) {
    cache = { revision: ctx.revision, entries: [], bytes: 0 }; valueCaches.set(ctx.db, cache);
  }
  return cache;
}
type PivotRecord = MeasureRow & { branch: string; k0: string | null; k1: string | null; k2: string | null; l0: string | null; l1: string | null; l2: string | null };

/** Prefixes match presentation labels literally, ignoring ASCII case only (SQLite LIKE).
 * Non-ASCII case is preserved. Keys, filter values and cursor tuples are opaque ids.
 */
export function queryFilterValues(ctx: DashboardQueryContext, slice: Slice, field: Dimension, prefix: string, limit: number,
  cursor?: string): Page<FilterValue> {
  validatePage({ limit, cursor });
  if (!isDimension(field) || typeof prefix !== "string" || [...prefix].length > 160) invalidQuery();
  const query = { slice, field, prefix, limit };
  const position = cursor ? cursorKey(cursor, "filter-values", ctx, query, [undefined, field]) : undefined;
  const after = position ? afterKey(["sort_label", "value"], position) : { sql: "1", params: [] };
  const compiled = explorerSlice(ctx, slice, true);
  initializeIds(ctx);
  const pattern = prefix.replace(/[\\%_]/g, "\\$&") + "%";
  const column = field === "session" || field === "run" ? `explorer_detail_key(${dimensions[field]})` : dimensions[field];
  const key = field === "session" || field === "run" ? "raw_value" : `explorer_id('${field}', raw_value)`;
  const cache = valueCache(ctx);
  const base = JSON.stringify([compiled.sql, compiled.params, field]);
  const folded = asciiFold(prefix);
  const cached = cache.entries.find(entry => entry.base === base && folded.startsWith(entry.prefix));
  let rows: ValueRecord[];
  if (cached) {
    rows = cached.rows.filter(row => (!prefix || (row.label !== null && asciiFold(row.label).startsWith(folded))) &&
      (!position || compareValue(row.sort_label, position[0]!) > 0 ||
        (compareValue(row.sort_label, position[0]!) === 0 && compareValue(row.value, position[1]!) > 0))).slice(0, limit + 1);
  } else {
    // Unsupported detail ids collapse into one informational count, never a filter key.
    // The extra indexed probe runs only when that sentinel is present.
    const detail = field === "session" || field === "run";
    const count = detail ? `CASE WHEN raw_value = '' THEN (SELECT COUNT(*) FROM calls c INDEXED BY calls_period_read
      WHERE ${compiled.sql} AND ${selectedPredicate("c", storedSelection(ctx.db))} AND ${column} = '') END` : "NULL";
    rows = ctx.db.prepare(`WITH RECURSIVE ${selectionCtes},
    distinct_values AS MATERIALIZED (SELECT DISTINCT ${column} AS raw_value FROM calls c INDEXED BY calls_period_read
      WHERE ${compiled.sql} AND ${selectedPredicate("c", storedSelection(ctx.db))}),
    values_in_slice AS MATERIALIZED (SELECT ${key} AS value, explorer_label('${field}', raw_value) AS label, ${count} AS count FROM distinct_values),
    sorted AS (SELECT *, explorer_fold(label) AS sort_label FROM values_in_slice)
    SELECT value, label, sort_label, count FROM sorted WHERE ${prefix ? "label LIKE ? ESCAPE '\\'" : "1"} AND (${after.sql})
    ORDER BY sort_label, value LIMIT ?`).all(...compiled.params, ...(detail ? compiled.params : []), ...(prefix ? [pattern] : []), ...after.params,
      position ? limit + 1 : VALUE_CACHE_ROWS + 1) as ValueRecord[];
    // Only complete prefix sets can answer narrower keystrokes or later pages.
    if (!position && rows.length <= VALUE_CACHE_ROWS) {
      const bytes = Buffer.byteLength(JSON.stringify(rows));
      if (bytes <= VALUE_CACHE_BYTES) {
        while (cache.entries.length >= 32 || cache.bytes + bytes > VALUE_CACHE_BYTES) cache.bytes -= cache.entries.shift()!.bytes;
        cache.entries.push({ base, prefix: folded, rows, bytes }); cache.bytes += bytes;
      }
    }
  }
  const positions = new WeakMap<FilterValue, readonly (string | null)[]>();
  const selected = rows.slice(0, limit).map(row => {
    const result: FilterValue = { id: row.value === "" ? null : row.value, label: row.label,
      ...(row.value === "" ? { count: row.count! } : {}) };
    positions.set(result, [row.sort_label, row.value]); return result;
  });
  return boundedPage({}, selected, rows.length > limit, 64, row => outputCursor("filter-values", ctx, query, positions.get(row)!, slice));
}

export function queryExplorer(ctx: DashboardQueryContext, query: ExplorerQuery): ExplorerData {
  validatePage(query.page);
  if (!Array.isArray(query.groupBy) || query.groupBy.length < 1 || query.groupBy.length > 3 ||
    query.groupBy.some(field => !isDimension(field)) || new Set(query.groupBy).size !== query.groupBy.length) invalidQuery();
  const keys = query.groupBy.map((_, i) => `k${i}`);
  const identity = { slice: query.slice, groupBy: query.groupBy, limit: query.page.limit };
  const after = query.page.cursor ? afterKey(keys, cursorKey(query.page.cursor, "explorer", ctx, identity, query.groupBy))
    : { sql: "1", params: [] };
  const compiled = explorerSlice(ctx, query.slice);
  initializeIds(ctx);
  const raw = [0, 1, 2].map(i => {
    const field = query.groupBy[i];
    const column = field ? dimensions[field] : "NULL";
    return `${field === "session" || field === "run" ? `explorer_detail_key(${column})` : column} AS k${i}`;
  }).join(", ");
  const projection = [0, 1, 2].map(i => `${i < keys.length && query.groupBy[i] !== "session" && query.groupBy[i] !== "run"
    ? `explorer_id('${query.groupBy[i]}', k${i})` : `k${i}`} AS k${i}`).join(", ");
  const labels = [0, 1, 2].map(i => `${i < keys.length ? `explorer_label('${query.groupBy[i]}', k${i})` : "NULL"} AS l${i}`).join(", ");
  const measures = "calls, pricedCalls, unpricedCalls, aggregateCalls, input, cacheRead, cacheWrite, output, cacheWrite1h, reasoning, aic, aicInput, aicCacheRead, aicCacheWrite, aicOutput, piCost, possibleOverlap, pendingData, possibleUndercount";
  const needed = ["ts", "run_id", "source_file", "is_report", "price_status", "aggregate", "input", "cache_read", "cache_write", "output",
    "cache_write_1h", "reasoning", "aic", "aic_input", "aic_cache_read", "aic_cache_write", "aic_output", "pi_cost",
    ...query.groupBy.filter((field: Dimension) => field !== "day").map((field: Dimension) => dimensions[field])];
  const countedProjection = [...new Set(needed)].map(column => `c.${column}`).join(", ");
  const rows = ctx.db.prepare(`WITH counted AS MATERIALIZED (${countedUsageSql(compiled.sql, countedProjection, "calls_period_read", storedSelection(ctx.db))}),
    grouped AS MATERIALIZED (SELECT ${raw}, ${measureColumns} FROM counted GROUP BY ${keys.join(", ")}),
    identified AS MATERIALIZED (SELECT ${projection}, ${labels}, ${measures} FROM grouped),
    page AS (SELECT * FROM identified WHERE (${after.sql}) ORDER BY ${keys.join(", ")} LIMIT ?)
    SELECT 'totals' AS branch, NULL AS k0, NULL AS k1, NULL AS k2, NULL AS l0, NULL AS l1, NULL AS l2, ${measureColumns} FROM counted
    UNION ALL SELECT 'group', * FROM page ORDER BY branch DESC, k0, k1, k2`).all(...compiled.params, ...after.params, query.page.limit + 1) as PivotRecord[];
  const end = Math.max(0, Math.min(query.slice.end, ctx.now()) - 1);
  let calibration = ctx.calibration.at(end, ctx.calibrationMode);
  let basis: AicDisplay["basis"] = calibration.status === "calibrated" ? "calibrated" : "published";
  if (ctx.calibrationMode !== "off" && calibration.status !== "calibrated") {
    const earliest = ctx.calibration.earliest(ctx.calibrationMode);
    if (earliest.status === "calibrated" && earliest.windowEnd !== null && end < earliest.windowEnd) {
      calibration = earliest; basis = "back-applied";
    }
  }
  const measure = (row: MeasureRow): UsageMeasure => {
    const result = measureFromRow(ctx, row, calibration);
    if (result.aicDisplay.basis === "calibrated") result.aicDisplay.basis = basis;
    return result;
  };
  const positions = new WeakMap<ExplorerRow, readonly (string | null)[]>();
  const selected = rows.slice(1, query.page.limit + 1).map(row => {
    const key = [row.k0, row.k1, row.k2].slice(0, keys.length);
    const result = { key: key.map(value => value === "" ? null : value), labels: [row.l0, row.l1, row.l2].slice(0, keys.length), measure: measure(row) };
    positions.set(result, key); return result;
  });
  return boundedPage({ groupBy: [...query.groupBy], calibration, totals: measure(rows[0]!) }, selected,
    rows.length > query.page.limit + 1, 256, row => outputCursor("explorer", ctx, identity, positions.get(row)!, query.slice));
}

function routeSlice(query: URLSearchParams, now: number, endpoint: string): Slice {
  const base = new URLSearchParams();
  for (const key of ["start", "end", "filters"]) if (query.has(key)) base.set(key, query.get(key)!);
  if (!base.has("end")) {
    const window = query.has("cursor") ? cursorWindow(query.get("cursor")!, endpoint) : undefined;
    if (window) {
      if (base.has("start") && base.get("start") !== String(window.start)) invalidQuery();
      base.set("start", String(window.start)); base.set("end", String(window.end));
    } else if (base.has("start")) base.set("end", String(now));
  }
  return parseSlice(base, now);
}

export const EXPLORER_ROUTES: readonly DashboardRoute[] = [
  { path: "/api/explorer", resolvePeriod(query, now) {
    const { start, end } = routeSlice(query, now, "explorer"); return { start, end };
  }, handle(ctx, query) {
    validateParams(query, ["start", "end", "filters", "groupBy", "limit", "cursor"]);
    const groupBy = query.has("groupBy") ? query.get("groupBy")!.split(",") : ["model"];
    if (groupBy.some(field => !isDimension(field))) invalidQuery();
    return queryExplorer(ctx, { slice: routeSlice(query, ctx.now(), "explorer"), groupBy: groupBy as Dimension[], page: parsePage(query) });
  } },
  { path: "/api/filter-values", resolvePeriod(query, now) {
    const { start, end } = routeSlice(query, now, "filter-values"); return { start, end };
  }, handle(ctx, query) {
    validateParams(query, ["start", "end", "filters", "field", "prefix", "limit", "cursor"]);
    const field = query.get("field");
    if (!isDimension(field)) invalidQuery();
    const page = parsePage(query);
    return queryFilterValues(ctx, routeSlice(query, ctx.now(), "filter-values"), field, query.get("prefix") ?? "", page.limit, page.cursor);
  } },
];
