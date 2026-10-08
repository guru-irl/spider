// Frozen pre-cube Overview reader, independent dynamic selection reference.
import type { DashboardQueryContext, Slice, TokenTotals, DashboardRoute, CalibrationResult, AicDisplay } from "../../dashboard-contract.js";
import type { OverviewData, OverviewDay, OverviewBreakdown, ContextData } from "./overview-v2-contract.js";
import { querySourceErrors } from "./source-errors-legacy.js";
import { readDashboardCounter } from "../../dashboard-reader.js";
import { countedUsageSql } from "./selection-v2-frozen.js";
import { compileSlice, overviewSelectionProjection, measureColumns, measureFromRow, type MeasureRow, DAY_MS, safeTimestamp, invalidQuery,
  parseSlice, validateParams, parsePage, decodeCursor, encodeCursor } from "../../dashboard-selection.js";

import { dashboardLabel } from "../../dashboard-identities.js";
const publicLabel = (value: string | null): string | null => dashboardLabel("role", value);

export const emptyMeasureRow: MeasureRow = {
  calls: 0, pricedCalls: 0, unpricedCalls: 0, aggregateCalls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
  cacheWrite1h: null, reasoning: null, aic: null, aicInput: null, aicCacheRead: null, aicCacheWrite: null,
  aicOutput: null, piCost: null, possibleOverlap: 0, possibleUndercount: 0, pendingData: 0,
};

export function queryOverview(ctx: DashboardQueryContext, slice: Slice, dailyStart: number = slice.start): OverviewData {
  const compiled = compileSlice(slice, undefined, ctx);
  if (!safeTimestamp(dailyStart) || dailyStart < slice.start || dailyStart > slice.end ||
    (dailyStart !== slice.start && dailyStart % DAY_MS !== 0)) invalidQuery();
  const firstDay = Math.floor(dailyStart / DAY_MS) * DAY_MS;
  const dailyEnd = Math.min(slice.end, firstDay + 31 * DAY_MS);
  const rows = ctx.db.prepare(`WITH counted AS MATERIALIZED (${countedUsageSql(compiled.sql, overviewSelectionProjection, "calls_period_read")}),
    role_ranks AS MATERIALIZED (SELECT role, ROW_NUMBER() OVER (ORDER BY SUM(aic) DESC, role IS NULL, role) AS rank FROM counted GROUP BY role),
    day_rows AS MATERIALIZED (SELECT * FROM counted WHERE ts >= ? AND ts < ?)
    SELECT 'totals' AS branch, NULL AS label, 0 AS rank, NULL AS day, ${measureColumns} FROM counted
    UNION ALL SELECT 'actor', actor, 0, NULL, ${measureColumns} FROM counted GROUP BY actor
    UNION ALL SELECT 'role', CASE WHEN r.rank <= 8 THEN c.role ELSE 'Other' END,
      CASE WHEN r.rank <= 8 THEN r.rank ELSE 9 END AS rank, NULL, ${measureColumns}
      FROM counted c JOIN role_ranks r ON r.role IS c.role GROUP BY CASE WHEN r.rank <= 8 THEN r.rank ELSE 9 END
    UNION ALL SELECT 'day', NULL, 0, (ts / ${DAY_MS}) * ${DAY_MS} AS day, ${measureColumns} FROM day_rows GROUP BY day
    UNION ALL SELECT 'day-actor', actor, 0, (ts / ${DAY_MS}) * ${DAY_MS} AS day, ${measureColumns} FROM day_rows GROUP BY day,actor
    UNION ALL SELECT 'day-role', CASE WHEN r.rank <= 8 THEN c.role ELSE 'Other' END,
      CASE WHEN r.rank <= 8 THEN r.rank ELSE 9 END AS rank, (ts / ${DAY_MS}) * ${DAY_MS} AS day, ${measureColumns}
      FROM day_rows c JOIN role_ranks r ON r.role IS c.role GROUP BY day,CASE WHEN r.rank <= 8 THEN r.rank ELSE 9 END
    ORDER BY branch, day, rank, label`).all(...compiled.params, dailyStart, dailyEnd) as
    (MeasureRow & { branch: string; label: string | null; rank: number; day: number | null })[];
  const now = ctx.now();
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const counterObservation = readDashboardCounter(ctx.db, now);
  /** Current month requests tolerate a client end timestamp up to 60 seconds behind now. */
  const current = slice.start === monthStart && slice.end >= now - 60000;
  const comparable = current && counterObservation.availability === "available" && counterObservation.ts! > monthStart;
  const endPoint = (end: number) => Math.max(0, Math.min(end, now) - 1);
  // Memoize exact endpoints (not day buckets): partial days and now must keep
  // their own valid fit. One batch per response, at most 31 days + slice end + comparison end.
  const ends = [...new Set([endPoint(slice.end), ...(comparable ? [endPoint(counterObservation.ts!)] : []), ...Array.from({ length: Math.ceil((dailyEnd - firstDay) / DAY_MS) },
    (_, i) => endPoint(Math.min(firstDay + (i + 1) * DAY_MS, dailyEnd)))])];
  const fits = ctx.calibration.atMany(ends, ctx.calibrationMode);
  let earliest: CalibrationResult | undefined;
  const fitByEnd = new Map(ends.map((end, i) => {
    let fit = fits[i]!, basis: AicDisplay["basis"] = fit.status === "calibrated" ? "calibrated" : "published";
    if (ctx.calibrationMode !== "off" && fit.status !== "calibrated") {
      earliest ??= ctx.calibration.earliest(ctx.calibrationMode);
      if (earliest.status === "calibrated" && earliest.windowEnd !== null && end < earliest.windowEnd) { fit = earliest; basis = "back-applied"; }
    }
    return [end, { fit, basis }] as const;
  }));
  const periodFit = fitByEnd.get(endPoint(slice.end))!;
  const calibration = periodFit.fit;
  const measure = (row: MeasureRow, selected = periodFit) => {
    const result = measureFromRow(ctx, row, selected.fit);
    if (result.aicDisplay.basis === "calibrated") result.aicDisplay.basis = selected.basis;
    return result;
  };
  const total = rows.find(row => row.branch === "totals")!;
  const empty = { ...emptyMeasureRow, pendingData: total.pendingData, possibleUndercount: total.pendingData ?? 0 };
  const actorLabels = ["parent", "subagent", "aux", "compaction", "warmer"];
  const actors = actorLabels.map(label => {
    const row = rows.find(row => row.branch === "actor" && row.label === label) ?? empty;
    return { label, isOther: false, measure: measure(row) };
  });
  const roles: OverviewBreakdown[] = rows.filter(row => row.branch === "role")
    .map(row => ({ label: publicLabel(row.label), isOther: row.rank === 9, measure: measure(row) }));
  const days: OverviewDay[] = [];
  for (let day = firstDay; day < dailyEnd; day += DAY_MS) {
    const dayFit = fitByEnd.get(endPoint(Math.min(day + DAY_MS, dailyEnd)))!;
    const row = rows.find(row => row.branch === "day" && row.day === day) ?? empty;
    days.push({ start: Math.max(day, dailyStart), end: Math.min(day + DAY_MS, dailyEnd), label: new Date(day).toISOString().slice(0, 10),
      measure: measure(row, dayFit),
      actors: actorLabels.map(label => ({ label, isOther: false, measure: measure(rows.find(row => row.branch === "day-actor" && row.day === day && row.label === label) ?? empty, dayFit) })),
      roles: rows.filter(row => row.branch === "role").map(role => ({ label: publicLabel(role.label), isOther: role.rank === 9,
        measure: measure(rows.find(row => row.branch === "day-role" && row.day === day && row.rank === role.rank) ?? empty, dayFit) })),
    });
  }
  const daily = { rows: days, nextCursor: dailyEnd < slice.end ? encodeCursor("overview-daily", ctx.revision, slice, [dailyEnd]) : null };
  const totals = measure(total);
  const comparisonFit = comparable ? fitByEnd.get(endPoint(counterObservation.ts!))! : periodFit;
  const comparisonSlice = comparable ? compileSlice({ start: monthStart, end: counterObservation.ts!, filters: [] }, undefined, ctx) : null;
  const comparisonRow = comparisonSlice ? ctx.db.prepare(`SELECT ${measureColumns} FROM (${countedUsageSql(comparisonSlice.sql, "c.*", "calls_period_read")})`)
    .get(...comparisonSlice.params) as MeasureRow : null;
  const computed = comparisonRow ? measureFromRow(ctx, comparisonRow, comparisonFit.fit) : null;
  if (computed?.aicDisplay.basis === "calibrated") computed.aicDisplay.basis = comparisonFit.basis;
  const counterAic = comparable ? counterObservation.creditsUsed : null;
  const elapsedFraction = current && now > monthStart ? (now - monthStart) / (monthEnd - monthStart) : null;
  const scale = (value: number | null, factor: number) => value === null ? null : value * factor;
  const projected = elapsedFraction === null ? null : {
    tokens: Object.fromEntries(Object.entries(totals.tokens).map(([key, value]) => [key, scale(value, 1 / elapsedFraction)])) as TokenTotals,
    aicDisplay: { ...totals.aicDisplay, primaryAic: scale(totals.aicDisplay.primaryAic, 1 / elapsedFraction),
      publishedAic: scale(totals.aicDisplay.publishedAic, 1 / elapsedFraction) },
    possibleOverlap: totals.possibleOverlap, possibleUndercount: totals.possibleUndercount, pendingData: totals.pendingData,
  };
  const counterFraction = comparable ? (counterObservation.ts! - monthStart) / (monthEnd - monthStart) : null;
  return { calibration, totals, actors, roles, daily, counterObservation,
    comparison: { start: current ? monthStart : slice.start, end: comparable ? counterObservation.ts! : slice.end, counterAic, computed,
      gap: computed?.aic !== null && computed?.aic !== undefined && counterAic !== null ? counterAic - computed.aic : null,
      ratio: computed?.aic !== null && computed?.aic !== undefined && counterAic !== null && counterAic > 0 ? computed.aic / counterAic : null },
    pace: { projected, elapsedFraction, counterAic: counterFraction && counterAic !== null ? counterAic / counterFraction : null } };
}

export const OVERVIEW_ROUTES: readonly DashboardRoute[] = [
  { path: "/api/status", handle(ctx, query) { validateParams(query, []); return ctx.status(); } },
  { path: "/api/overview", handle(ctx, query) {
    validateParams(query, ["start", "end", "filters", "cursor"]);
    const base = new URLSearchParams(query); base.delete("cursor");
    const slice = parseSlice(base, ctx.now());
    let dailyStart: number | undefined;
    if (query.has("cursor")) {
      const key = decodeCursor(query.get("cursor")!, "overview-daily", ctx.revision, slice);
      if (key.length !== 1 || typeof key[0] !== "number") invalidQuery();
      dailyStart = key[0];
    }
    return queryOverview(ctx, slice, dailyStart);
  } },
  { path: "/api/context", handle(ctx, query): ContextData {
    const slice = parseSlice(query, ctx.now());
    const availability = { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" } as const;
    return { contextFillPercent: null,
      contextFillMessage: "Context fill unavailable: historical window not recorded",
      composition: availability, carry: availability, itemReuse: availability };
  } },
  { path: "/api/source-errors", handle(ctx, query) {
    validateParams(query, ["limit", "cursor"]);
    return querySourceErrors(ctx, parsePage(query));
  } },
];
