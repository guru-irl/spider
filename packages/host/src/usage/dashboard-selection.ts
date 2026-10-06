import { createHash } from "node:crypto";
import { DashboardQueryError, type Dimension, type Slice, type DashboardQueryContext, type UsageMeasure, type CalibrationResult, type AicDisplay } from "./dashboard-contract.js";

import { countedUsageSql } from "./schema.js";
import { toAicDisplay } from "./aic-display.js";

export const DAY_MS = 86_400_000;
const columns: Record<Dimension, string> = {
  project: "project", repo: "repo", session: "session_id", actor: "actor", role: "role", agent: "agent",
  provider: "provider", model: "model", requestedModel: "requested_model", thinking: "thinking",
  run: "run_id", runName: "run_name", phase: "phase", parentRun: "parent_run_id",
  auxPurpose: "aux_purpose", api: "api", day: "ts",
};
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
function validateSlice(slice: Slice): void {
  if (!safeTimestamp(slice.start) || !safeTimestamp(slice.end) || slice.end < slice.start || slice.end - slice.start > 366 * DAY_MS) invalidQuery();
  if (!Array.isArray(slice.filters) || slice.filters.length > 16) invalidQuery();
  for (const filter of slice.filters) {
    if (!filter || typeof filter !== "object" || Object.keys(filter).length !== 2 ||
      !Object.hasOwn(filter, "field") || !Object.hasOwn(filter, "value") || !Object.hasOwn(columns, filter.field) ||
      (filter.value !== null && (typeof filter.value !== "string" || Buffer.byteLength(filter.value) > 1024))) invalidQuery();
    if (filter.field === "day" && filter.value !== null) utcDay(filter.value);
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
export function compileSlice(slice: Slice, scope?: { sessionId?: string; runId?: string }): { sql: string; params: readonly (string | number | null)[] } {
  validateSlice(slice);
  const clauses = ["c.ts >= ?", "c.ts < ?"];
  const params: (string | number | null)[] = [slice.start, slice.end];
  for (const filter of slice.filters) {
    if (filter.field === "day" && filter.value !== null) {
      const day = utcDay(filter.value);
      clauses.push("c.ts >= ? AND c.ts < ?"); params.push(day, day + DAY_MS);
    } else {
      clauses.push(`c.${columns[filter.field]} IS ?`); params.push(filter.value);
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
export function readMeasure(ctx: DashboardQueryContext, slice: Slice, scope?: { sessionId?: string; runId?: string },
  calibration?: CalibrationResult): UsageMeasure {
  let basis: AicDisplay["basis"] | undefined;
  if (!calibration) {
    const end = Math.max(0, Math.min(slice.end, ctx.now()) - 1);
    calibration = ctx.calibration.at(end, ctx.calibrationMode);
    if (ctx.calibrationMode !== "off" && calibration.status !== "calibrated") {
      const earliest = ctx.calibration.earliest(ctx.calibrationMode);
      if (earliest.status === "calibrated" && earliest.windowEnd !== null && end < earliest.windowEnd) { calibration = earliest; basis = "back-applied"; }
    }
  }
  const compiled = compileSlice(slice, scope);
  const row = ctx.db.prepare(`SELECT ${measureColumns} FROM (${countedUsageSql(compiled.sql, "c.*", scope?.sessionId ? "calls_session_read" : "calls_period_read")})`)
    .get(...compiled.params) as MeasureRow;
  const result = measureFromRow(ctx, row, calibration);
  if (basis) result.aicDisplay.basis = basis;
  return result;
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
const queryHash = (query: unknown) => createHash("sha256").update(JSON.stringify(query)).digest("hex");
export function encodeCursor(endpoint: string, revision: string, query: unknown, key: readonly (string | number | null)[]): string {
  const cursor = Buffer.from(JSON.stringify({ version: 1, endpoint, revision, queryHash: queryHash(query), key })).toString("base64url");
  if (Buffer.byteLength(cursor) > 2048) invalidQuery();
  return cursor;
}
export function decodeCursor(cursor: string, endpoint: string, revision: string, query: unknown): readonly (string | number | null)[] {
  if (!cursor || Buffer.byteLength(cursor) > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidQuery();
  let value: { version?: unknown; endpoint?: unknown; revision?: unknown; queryHash?: unknown; key?: unknown };
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { invalidQuery(); }
  if (!value || typeof value !== "object" || Object.keys(value).length !== 5 || value.version !== 1 ||
    value.endpoint !== endpoint || typeof value.revision !== "string" || value.queryHash !== queryHash(query) ||
    !Array.isArray(value.key) || value.key.length > 32 || value.key.some(item => item !== null && typeof item !== "string" && typeof item !== "number")) invalidQuery();
  if (value.revision !== revision) throw new DashboardQueryError("ledger-changed");
  return value.key as (string | number | null)[];
}
