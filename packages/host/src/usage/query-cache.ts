import type { InternalCalibrationService } from "./calibration.js";
import { dashboardKey, dashboardLabel } from "./dashboard-identities.js";
import type { AicDisplay, CalibrationResult, CalibrationService, DashboardQueryContext, Page, Slice, UsageMeasure } from "./dashboard-contract.js";
import { toAicDisplay } from "./aic-display.js";
import { storedSelection, countedUsageSql } from "./schema.js";
import { compileSlice, DAY_MS, decodeCursor, encodeCursor, invalidQuery, measureSelectionProjection, measureColumns, measureFromRow, safeTimestamp, validatePage, type MeasureRow } from "./dashboard-selection.js";
import { emptyMeasureRow } from "./query-overview.js";

export type AnalysisFit = { calibration: CalibrationResult; basis: AicDisplay["basis"] };
/** Exact endpoint batch; only endpoints before the earliest fit can be back-applied. */
export function analysisFits(ctx: DashboardQueryContext, ends: readonly number[]): AnalysisFit[] {
  const points = ends.map(end => Math.max(0, Math.min(end, ctx.now()) - 1));
  const unique = [...new Set(points)];
  let fits: readonly CalibrationResult[];
  if (unique.length <= 200) fits = ctx.calibration.atMany(unique, ctx.calibrationMode);
  else fits = historyFits(ctx, unique);
  let earliest: CalibrationResult | undefined;
  const byEnd = new Map(unique.map((end, i) => {
    let calibration = fits[i]!, basis: AicDisplay["basis"] = calibration.status === "calibrated" ? "calibrated" : "published";
    if (ctx.calibrationMode !== "off" && calibration.status !== "calibrated") {
      earliest ??= ctx.calibration.earliest(ctx.calibrationMode);
      if (earliest.status === "calibrated" && earliest.windowEnd !== null && end < earliest.windowEnd) { calibration = earliest; basis = "back-applied"; }
    }
    return [end, { calibration, basis }] as const;
  }));
  return points.map(point => byEnd.get(point)!);
}
function hasHistory(service: CalibrationService): service is InternalCalibrationService {
  return "windows" in service && typeof service.windows === "function";
}
/** Internal endpoint lookup. History fits can be shared; callers must treat them as read-only. */
export function historyFits(ctx: DashboardQueryContext, unique: readonly number[]): readonly CalibrationResult[] {
  if (!unique.length) return [];
  if (!hasHistory(ctx.calibration)) {
    const fits: CalibrationResult[] = [];
    for (let i = 0; i < unique.length; i += 200) fits.push(...ctx.calibration.atMany(unique.slice(i, i + 200), ctx.calibrationMode));
    return fits;
  }
  const sorted = [...unique].sort((a, b) => a - b);
  const windows = ctx.calibration.windows({ start: sorted[0]!, end: sorted.at(-1)! }, ctx.calibrationMode);
  const byPoint = new Map<number, CalibrationResult>();
  let cursor = 0;
  for (const point of sorted) {
    while (cursor + 1 < windows.length && windows[cursor + 1]!.from <= point) cursor++;
    byPoint.set(point, windows[cursor]!.calibration);
  }
  const fits = unique.map(point => byPoint.get(point)!);
  return fits;
}
export function analysisMeasure(ctx: DashboardQueryContext, row: MeasureRow, fit: AnalysisFit): UsageMeasure {
  const measure = measureFromRow(ctx, row, fit.calibration);
  measure.aicDisplay.basis = fit.basis;
  return measure;
}
const ratio = (value: number, total: number) => total > 0 ? value / total : null;
export type CacheComponent = { tokenType: "input" | "cacheRead" | "cacheWrite" | "output"; tokens: number; aicDisplay: AicDisplay };
function cacheComponents(measure: UsageMeasure, fit: AnalysisFit): CacheComponent[] {
  return (["input", "cacheRead", "cacheWrite", "output"] as const).map(tokenType => ({ tokenType, tokens: measure.tokens[tokenType],
    aicDisplay: { ...toAicDisplay(measure.aicComponents[tokenType], measure.unpricedCalls, fit.calibration), basis: fit.basis } }));
}
export type CacheWriteSplit = { cacheWrite5m: number; cacheWrite1h: number; knownTokens: number; knownCalls: number; unknownTokens: number; unknownCalls: number };
type CacheMeasureRow = MeasureRow & { cacheWrite5m?: number; knownTokens?: number; knownCalls?: number; unknownTokens?: number; unknownCalls?: number };
const cacheMeasureColumns = `${measureColumns},
  COALESCE(SUM(CASE WHEN cache_write_1h IS NOT NULL THEN cache_write-cache_write_1h ELSE 0 END),0) AS cacheWrite5m,
  COALESCE(SUM(CASE WHEN cache_write_1h IS NOT NULL THEN cache_write ELSE 0 END),0) AS knownTokens,
  COALESCE(SUM(cache_write_1h IS NOT NULL),0) AS knownCalls,
  COALESCE(SUM(CASE WHEN cache_write_1h IS NULL THEN cache_write ELSE 0 END),0) AS unknownTokens,
  COALESCE(SUM(cache_write_1h IS NULL),0) AS unknownCalls`;
const writeSplit = (row: CacheMeasureRow): CacheWriteSplit => ({ cacheWrite5m: row.cacheWrite5m ?? 0, cacheWrite1h: row.cacheWrite1h ?? 0,
  knownTokens: row.knownTokens ?? 0, knownCalls: row.knownCalls ?? 0, unknownTokens: row.unknownTokens ?? 0, unknownCalls: row.unknownCalls ?? 0 });
export type CacheDay = { start: number; end: number; label: string; hitRate: number | null; measure: UsageMeasure; warmer: UsageMeasure;
  components: readonly CacheComponent[]; warmerComponents: readonly CacheComponent[]; writeSplit: CacheWriteSplit; warmerWriteSplit: CacheWriteSplit };
export type CacheSession = { sessionId: string | null; sessionLabel: string; projectKey: string | null; projectLabel: string | null; measure: UsageMeasure };
export type CacheData = {
  ingestPending: boolean; writeSplit: CacheWriteSplit; warmerWriteSplit: CacheWriteSplit;
  calibration: CalibrationResult; totals: UsageMeasure; warmer: UsageMeasure; hitRate: number | null;
  components: readonly CacheComponent[]; warmerComponents: readonly CacheComponent[];
  warmerShare: { prompt: number | null; calls: number | null; publishedAic: number | null };
  daily: Page<CacheDay>; sessionsWithWritesNoReads: Page<CacheSession>;
  observation: "Sessions with writes and no recorded reads";
  itemReuse: ReturnType<DashboardQueryContext["composition"]["availability"]>;
};
export function queryCache(ctx: DashboardQueryContext, slice: Slice, page: { limit: number; cursor?: string }, dailyStart: number = slice.start): CacheData {
  const compiled = compileSlice(slice, undefined, ctx); validatePage(page);
  if (!safeTimestamp(dailyStart) || dailyStart < slice.start || dailyStart > slice.end || (dailyStart !== slice.start && dailyStart % DAY_MS !== 0)) invalidQuery();
  // Validate every cursor before any evidence or call query.
  let after = 0;
  if (page.cursor) {
    const key = decodeCursor(page.cursor, "cache-sessions", ctx.revision, { slice, limit: page.limit });
    if (key.length !== 1 || typeof key[0] !== "number" || !Number.isSafeInteger(key[0]) || key[0] < 1) invalidQuery();
    after = key[0];
  }
  const firstDay = Math.floor(dailyStart / DAY_MS) * DAY_MS, dailyEnd = Math.min(slice.end, firstDay + 31 * DAY_MS);
  const rows = ctx.db.prepare(`WITH counted AS MATERIALIZED (${countedUsageSql(compiled.sql, `${measureSelectionProjection},c.ts,c.actor`, "calls_period_read", storedSelection(ctx.db))})
    SELECT 'totals' AS branch,NULL AS day,${cacheMeasureColumns} FROM counted
    UNION ALL SELECT 'warmer',NULL,${cacheMeasureColumns} FROM counted WHERE actor='warmer'
    UNION ALL SELECT 'day',(ts/${DAY_MS})*${DAY_MS} AS day,${cacheMeasureColumns} FROM counted WHERE ts>=? AND ts<? GROUP BY day
    UNION ALL SELECT 'day-warmer',(ts/${DAY_MS})*${DAY_MS} AS day,${cacheMeasureColumns} FROM counted WHERE ts>=? AND ts<? AND actor='warmer' GROUP BY day`)
    .all(...compiled.params, dailyStart, dailyEnd, dailyStart, dailyEnd) as (CacheMeasureRow & { branch: string; day: number | null })[];
  const days: number[] = []; for (let day = firstDay; day < dailyEnd; day += DAY_MS) days.push(day);
  const fits = analysisFits(ctx, [slice.end, ...days.map(day => Math.min(day + DAY_MS, dailyEnd))]);
  const fit = fits[0]!, totalRow = rows.find(row => row.branch === "totals")!;
  const empty = { ...emptyMeasureRow, pendingData: totalRow.pendingData, possibleUndercount: totalRow.pendingData ?? 0 };
  const totals = analysisMeasure(ctx, totalRow, fit), warmer = analysisMeasure(ctx, rows.find(row => row.branch === "warmer")!, fit);
  const candidates = ctx.db.prepare(`WITH counted AS MATERIALIZED (${countedUsageSql(compiled.sql, `${measureSelectionProjection},c.session_id,c.project,c.rowid AS callRow`, "calls_period_read", storedSelection(ctx.db))}),
    candidates AS MATERIALIZED (SELECT session_id,MIN(project) AS project,MIN(callRow) AS firstRow,${cacheMeasureColumns}
      FROM counted WHERE session_id IS NOT NULL GROUP BY session_id
      HAVING SUM(cache_write)>0 AND SUM(cache_read)=0 AND MIN(callRow)>? ORDER BY firstRow LIMIT ?)
    SELECT candidate.*,NOT EXISTS (SELECT 1 FROM (${countedUsageSql("c.session_id=candidate.session_id AND c.cache_read>0 AND c.copied=0", "c.run_id,c.is_report,c.source_file", "calls_session_read", storedSelection(ctx.db))})) AS noReads
    FROM candidates candidate ORDER BY firstRow`).all(...compiled.params, after, page.limit + 1) as
      (MeasureRow & { session_id: string; project: string | null; firstRow: number; noReads: number })[];
  const selected = candidates.slice(0, page.limit);
  const sessionsWithWritesNoReads: Page<CacheSession> = {
    rows: selected.filter(row => row.noReads).map(row => ({ sessionId: dashboardKey(ctx, "session", row.session_id),
      sessionLabel: dashboardLabel("session", row.session_id)!, projectKey: dashboardKey(ctx, "project", row.project), projectLabel: dashboardLabel("project", row.project),
      measure: analysisMeasure(ctx, row, fit) })),
    nextCursor: candidates.length > page.limit ? encodeCursor("cache-sessions", ctx.revision, { slice, limit: page.limit }, [selected.at(-1)!.firstRow]) : null,
  };
  return { ingestPending: Boolean(totalRow.pendingData), writeSplit: writeSplit(totalRow), warmerWriteSplit: writeSplit(rows.find(row => row.branch === "warmer")!), calibration: fit.calibration, totals, warmer, components: cacheComponents(totals, fit), warmerComponents: cacheComponents(warmer, fit), hitRate: ratio(totals.tokens.cacheRead, totals.tokens.prompt),
    warmerShare: { prompt: ratio(warmer.tokens.prompt, totals.tokens.prompt), calls: ratio(warmer.calls, totals.calls),
      publishedAic: totals.aic !== null && warmer.aic !== null && totals.aic > 0 ? warmer.aic / totals.aic : null },
    daily: { rows: days.map((day, i) => {
      const dayRow = rows.find(row => row.branch === "day" && row.day === day) ?? empty;
      const warmerRow = rows.find(row => row.branch === "day-warmer" && row.day === day) ?? empty;
      const measure = analysisMeasure(ctx, dayRow, fits[i + 1]!);
      const dayWarmer = analysisMeasure(ctx, warmerRow, fits[i + 1]!);
      return { start: Math.max(day, dailyStart), end: Math.min(day + DAY_MS, dailyEnd), label: new Date(day).toISOString().slice(0, 10),
        hitRate: ratio(measure.tokens.cacheRead, measure.tokens.prompt), measure, writeSplit: writeSplit(dayRow), warmerWriteSplit: writeSplit(warmerRow),
        warmer: dayWarmer, components: cacheComponents(measure, fits[i + 1]!), warmerComponents: cacheComponents(dayWarmer, fits[i + 1]!) };
    }), nextCursor: dailyEnd < slice.end ? encodeCursor("cache-daily", ctx.revision, slice, [dailyEnd]) : null },
    sessionsWithWritesNoReads, observation: "Sessions with writes and no recorded reads", itemReuse: ctx.composition.availability(slice) };
}
