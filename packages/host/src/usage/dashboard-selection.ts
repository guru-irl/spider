import { DIMENSION_COLUMNS } from "./dimension-values.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DashboardQueryError, type Slice, type DashboardQueryContext, type UsageMeasure, type CalibrationResult, type AicDisplay } from "./dashboard-contract.js";

import { primeFilterIds, resolveFilterId } from "./dashboard-identities.js";
import { storedSelection, countedUsageSql } from "./schema.js";
import { toAicDisplay } from "./aic-display.js";

export const DAY_MS = 86_400_000;
const columns = DIMENSION_COLUMNS;
export function invalidQuery(): never { throw new DashboardQueryError("invalid-query"); }
export function validateParams(params: URLSearchParams, allowed: readonly string[]): void {
  if (Buffer.byteLength(params.toString()) > 8192) invalidQuery();
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key) || seen.has(key)) invalidQuery();
    seen.add(key);
  }
}
export function safeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}
function utcDay(value: string): number {
  const ts = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !safeTimestamp(ts) || new Date(ts).toISOString().slice(0, 10) !== value) invalidQuery();
  return ts;
}
export function validateSlice(slice: Slice): void {
  if (!safeTimestamp(slice.start) || !safeTimestamp(slice.end) || slice.end < slice.start || slice.end - slice.start > 366 * DAY_MS) invalidQuery();
  if (!Array.isArray(slice.filters) || slice.filters.length > 16) invalidQuery();
  for (const filter of slice.filters) {
    if (!filter || typeof filter !== "object" || Object.keys(filter).some(key => !["field", "value", "kind"].includes(key)) ||
      !Object.hasOwn(filter, "field") || !Object.hasOwn(columns, filter.field)) invalidQuery();
    if (filter.kind === "missing") {
      if (Object.hasOwn(filter, "value")) invalidQuery();
      continue;
    }
    if ((filter.kind !== undefined && filter.kind !== "raw" && filter.kind !== "id") ||
      !Object.hasOwn(filter, "value") || typeof filter.value !== "string" || Buffer.byteLength(filter.value) > 1024) invalidQuery();
    if (filter.field === "day" && filter.kind !== "id") utcDay(filter.value);
  }
}
export function parseSlice(params: URLSearchParams, now: number): Slice {
  validateParams(params, ["start", "end", "filters"]);
  if (params.has("start") !== params.has("end") || !safeTimestamp(now)) invalidQuery();
  const numeric = (value: string | null) => {
    if (value === null || !/^\d+$/.test(value)) invalidQuery();
    return Number(value);
  };
  const date = new Date(now);
  let filters: Slice["filters"] = [];
  if (params.has("filters")) {
    try { filters = JSON.parse(params.get("filters")!); } catch { invalidQuery(); }
  }
  const slice = { start: params.has("start") ? numeric(params.get("start")) : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: params.has("end") ? numeric(params.get("end")) : now, filters };
  validateSlice(slice);
  return slice;
}
export function compileSlice(slice: Slice, scope?: { sessionId?: string; runId?: string }, ctx?: DashboardQueryContext, batchIds = false): { sql: string; params: readonly (string | number | null)[] } {
  validateSlice(slice);
  if (batchIds && ctx) primeFilterIds(ctx, slice.filters, slice);
  const clauses = ["c.ts >= ?", "c.ts < ?"];
  const params: (string | number | null)[] = [slice.start, slice.end];
  for (const filter of slice.filters) {
    if (filter.kind === "missing") {
      clauses.push(`c.${columns[filter.field]} IS NULL`);
      continue;
    }
    let value = filter.value;
    if (filter.kind === "id" && value !== null) {
      if (!ctx) invalidQuery();
      value = resolveFilterId(ctx, filter.field, value, slice);
    }
    if (filter.field === "day" && value !== null) {
      const day = utcDay(value);
      clauses.push("c.ts >= ? AND c.ts < ?"); params.push(day, day + DAY_MS);
    } else {
      clauses.push(`c.${columns[filter.field]} IS ?`); params.push(value);
    }
  }
  for (const [key, column] of [["sessionId", "session_id"], ["runId", "run_id"]] as const) {
    const value = scope?.[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024) invalidQuery();
    clauses.push(`c.${column} = ?`); params.push(value);
  }
  return { sql: clauses.join(" AND "), params };
}

/** Only Overview's grouping, measure and selection-flag inputs. Avoid spilling
 * raw provenance and labels into its repeatedly read materialized window. */
export const overviewSelectionProjection: string = ["ts", "actor", "role", "price_status", "aggregate", "input", "cache_read",
  "cache_write", "output", "cache_write_1h", "reasoning", "aic", "aic_input", "aic_cache_read", "aic_cache_write",
  "aic_output", "pi_cost", "run_id", "is_report", "source_file", "source_kind"].map(column => `c.${column}`).join(",");

/** Task 8's measure inputs plus the run/provenance columns required by
 * countedUsageSql's overlap and v2 undercount decisions. Each reader appends
 * only its own grouping, label or rowid columns. */
export const measureSelectionProjection: string = ["price_status", "aggregate", "input", "cache_read", "cache_write",
  "output", "cache_write_1h", "reasoning", "aic", "aic_input", "aic_cache_read", "aic_cache_write", "aic_output",
  "pi_cost", "run_id", "is_report", "source_file"].map(column => `c.${column}`).join(",");

/** Aggregation is shared by all bounded dashboard counted-call passes. */
export const measureColumns = `COUNT(*) AS calls,
  COALESCE(SUM(price_status='priced'),0) AS pricedCalls, COALESCE(SUM(price_status='unpriced'),0) AS unpricedCalls,
  COALESCE(SUM(aggregate),0) AS aggregateCalls,
  COALESCE(SUM(input),0) AS input, COALESCE(SUM(cache_read),0) AS cacheRead,
  COALESCE(SUM(cache_write),0) AS cacheWrite, COALESCE(SUM(output),0) AS output,
  SUM(cache_write_1h) AS cacheWrite1h, SUM(reasoning) AS reasoning,
  SUM(aic) AS aic, SUM(aic_input) AS aicInput, SUM(aic_cache_read) AS aicCacheRead,
  SUM(aic_cache_write) AS aicCacheWrite, SUM(aic_output) AS aicOutput, SUM(pi_cost) AS piCost,
  COALESCE(MAX(possible_overlap),0) AS possibleOverlap,
  (EXISTS (SELECT 1 FROM import_state WHERE offset < size) OR EXISTS (SELECT 1 FROM pending_reports)) AS pendingData,
  (COALESCE(MAX(possible_undercount),0) OR EXISTS (SELECT 1 FROM import_state WHERE offset < size)
    OR EXISTS (SELECT 1 FROM pending_reports)) AS possibleUndercount`;
export type MeasureRow = {
  calls: number; pricedCalls: number; unpricedCalls: number; aggregateCalls: number;
  input: number; cacheRead: number; cacheWrite: number; output: number; cacheWrite1h: number | null; reasoning: number | null;
  aic: number | null; aicInput: number | null; aicCacheRead: number | null; aicCacheWrite: number | null; aicOutput: number | null;
  piCost: number | null; possibleOverlap: number; possibleUndercount: number; pendingData?: number;
};
export function measureFromRow(ctx: DashboardQueryContext, row: MeasureRow, calibration: CalibrationResult): UsageMeasure {
  const prompt = row.input + row.cacheRead + row.cacheWrite;
  const aic = row.aic;
  return {
    calls: row.calls, pricedCalls: row.pricedCalls, unpricedCalls: row.unpricedCalls, aggregateCalls: row.aggregateCalls,
    tokens: { input: row.input, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output,
      cacheWrite1h: row.cacheWrite1h, reasoning: row.reasoning, prompt, total: prompt + row.output },
    aic, aicComponents: { input: row.aicInput, cacheRead: row.aicCacheRead, cacheWrite: row.aicCacheWrite, output: row.aicOutput },
    aicDisplay: toAicDisplay(aic, row.unpricedCalls, calibration),
    piCost: row.piCost, possibleOverlap: Boolean(row.possibleOverlap), possibleUndercount: Boolean(row.possibleUndercount),
    pendingData: Boolean(row.pendingData), estimated: Boolean(row.possibleOverlap || row.possibleUndercount),
  };
}
/** Resolve one period-end fit and reuse its projector across totals, buckets and rows. */
export function resolveMeasure(ctx: DashboardQueryContext, slice: Slice, calibration?: CalibrationResult): {
  calibration: CalibrationResult; measure: (row: MeasureRow) => UsageMeasure;
} {
  let basis: AicDisplay["basis"] | undefined;
  if (!calibration) {
    const end = Math.max(0, Math.min(slice.end, ctx.now()) - 1);
    calibration = ctx.calibration.at(end, ctx.calibrationMode);
    if (ctx.calibrationMode !== "off" && calibration.status !== "calibrated") {
      const earliest = ctx.calibration.earliest(ctx.calibrationMode);
      if (earliest.status === "calibrated" && earliest.windowEnd !== null && end < earliest.windowEnd) { calibration = earliest; basis = "back-applied"; }
    }
  }
  const fit = calibration;
  return { calibration: fit, measure: row => {
    const result = measureFromRow(ctx, row, fit);
    if (basis) result.aicDisplay.basis = basis;
    return result;
  } };
}
export function readMeasure(ctx: DashboardQueryContext, slice: Slice, scope?: { sessionId?: string; runId?: string },
  calibration?: CalibrationResult): UsageMeasure {
  const resolved = resolveMeasure(ctx, slice, calibration);
  const compiled = compileSlice(slice, scope, ctx);
  const row = ctx.db.prepare(`SELECT ${measureColumns} FROM (${countedUsageSql(compiled.sql, "c.*", scope?.sessionId ? "calls_session_read" : "calls_period_read", storedSelection(ctx.db))})`)
    .get(...compiled.params) as MeasureRow;
  return resolved.measure(row);
}

export function validatePage(page: { limit: number; cursor?: string }, maximum = 200): void {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > maximum ||
    (page.cursor !== undefined && (typeof page.cursor !== "string" || !page.cursor || Buffer.byteLength(page.cursor) > 2048))) invalidQuery();
}
export function parsePage(params: URLSearchParams): { limit: number; cursor?: string } {
  const raw = params.get("limit");
  if (raw !== null && !/^\d+$/.test(raw)) invalidQuery();
  const page = { limit: raw === null ? 50 : Number(raw), ...(params.has("cursor") ? { cursor: params.get("cursor")! } : {}) };
  validatePage(page);
  return page;
}
// Filter conjunctions have no order. Normalize object shape as well as the filter list.
function canonicalQuery(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalQuery);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => {
    const normalized = canonicalQuery(item);
    return [key, key === "filters" && Array.isArray(normalized)
      ? [...new Map(normalized.map(filter => [JSON.stringify(filter), filter])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, filter]) => filter)
      : normalized];
  }));
}
const queryHash = (query: unknown) => createHash("sha256").update(JSON.stringify(canonicalQuery(query))).digest("hex");
// Instance namespaces are generated by the launcher. The independent signing secret
// never leaves this server process, is shared by all endpoints and rotates on restart.
const cursorSecrets = new Map<string, Buffer>();
function cursorSecret(revision: string): Buffer {
  const instance = revision.split(":")[0]!;
  let secret = cursorSecrets.get(instance);
  if (!secret) { secret = randomBytes(32); cursorSecrets.set(instance, secret); }
  return secret;
}
type CursorPayload = { version: 2; endpoint: string; revision: string; queryHash: string;
  key: readonly (string | number | null)[]; window?: { start: number; end: number } };
export function encodeCursor(endpoint: string, revision: string, query: unknown, key: readonly (string | number | null)[],
  window?: { start: number; end: number }): string {
  const payload: CursorPayload = { version: 2, endpoint, revision, queryHash: queryHash(query), key, ...(window ? { window } : {}) };
  const mac = createHmac("sha256", cursorSecret(revision)).update(JSON.stringify(payload)).digest("base64url");
  const cursor = Buffer.from(JSON.stringify({ ...payload, mac })).toString("base64url");
  if (Buffer.byteLength(cursor) > 2048) invalidQuery();
  return cursor;
}
function authenticatedCursor(cursor: string, endpoint: string): CursorPayload {
  if (!cursor || Buffer.byteLength(cursor) > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidQuery();
  let value: CursorPayload & { mac: string };
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { invalidQuery(); }
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["version", "endpoint", "revision", "queryHash", "key", "window", "mac"].includes(key)) ||
    value.version !== 2 || value.endpoint !== endpoint || typeof value.revision !== "string" || typeof value.queryHash !== "string" ||
    typeof value.mac !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.mac) ||
    !Array.isArray(value.key) || value.key.length > 32 || value.key.some(item => item !== null && typeof item !== "string" && typeof item !== "number")) invalidQuery();
  if (value.window && (!safeTimestamp(value.window.start) || !safeTimestamp(value.window.end) ||
    Object.keys(value.window).length !== 2 || value.window.end < value.window.start)) invalidQuery();
  const { mac, ...payload } = value;
  const secret = cursorSecrets.get(value.revision.split(":")[0]!);
  if (!secret) throw new DashboardQueryError("ledger-changed");
  const expected = createHmac("sha256", secret).update(JSON.stringify(payload)).digest();
  if (!timingSafeEqual(expected, Buffer.from(mac, "base64url"))) invalidQuery();
  return payload;
}
/** Read only an authenticated resolved window. Query and revision binding are still checked by decodeCursor. */
export function cursorWindow(cursor: string, endpoint: string): { start: number; end: number } | undefined {
  return authenticatedCursor(cursor, endpoint).window;
}
export function decodeCursor(cursor: string, endpoint: string, revision: string, query: unknown): readonly (string | number | null)[] {
  const value = authenticatedCursor(cursor, endpoint);
  if (value.queryHash !== queryHash(query)) invalidQuery();
  if (value.revision !== revision) throw new DashboardQueryError("ledger-changed");
  return value.key;
}
