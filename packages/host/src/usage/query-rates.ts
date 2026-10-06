import type { CalibrationHistoryPoint, CalibrationResult, DashboardQueryContext, DashboardRoute, Page, Slice, UsageMeasure } from "./dashboard-contract.js";
import type { RateTier, RateVersion } from "./types.js";
import { countedUsageSql } from "./schema.js";
import { compileSlice, decodeCursor, encodeCursor, invalidQuery, measureColumns, parsePage, parseSlice, validatePage, validateParams, safeTimestamp, type MeasureRow } from "./dashboard-selection.js";
import { analysisFits, analysisMeasure, queryCache } from "./query-cache.js";
import { dashboardKey, dashboardLabel } from "./dashboard-identities.js";
import { queryReconciliation } from "./query-reconciliation.js";
export type RateRow = { modelKey: string; version: string; model: string; aliases: readonly string[]; validUntil: string | null;
  tier: string; abovePromptTokens: number; usdPerMillion: RateTier["usdPerMillion"] };
export type UnpricedModelRow = { modelKey: string | null; providerKey: string | null; provider: string | null; model: string | null; reason: string; measure: UsageMeasure };
export type RatesData = {
  calibration: CalibrationResult; periodCalibration: CalibrationResult; totals: UsageMeasure;
  versions: readonly Omit<RateVersion, "models">[]; rates: Page<RateRow>; storedRateVersions: readonly string[]; storedRateVersionsTruncated: boolean;
  unpricedModels: Page<UnpricedModelRow>; factorHistory: Page<CalibrationHistoryPoint>; factorHistoryEnabled: boolean; nextCursor: string | null;
};
export function queryRates(ctx: DashboardQueryContext, slice: Slice, page: { limit: number; cursor?: string }): RatesData {
  const compiled = compileSlice(slice, undefined, ctx); validatePage(page);
  const query = { slice, limit: page.limit, mode: ctx.calibrationMode };
  let rateIndex = 0, unpricedAfter = 0, unpricedDone = false, historyCursor: string | undefined, historyDone = false;
  if (page.cursor) {
    const key = decodeCursor(page.cursor, "rates", ctx.revision, query);
    if (key.length !== 5 || key.slice(0, 3).some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) ||
      (key[2] !== 0 && key[2] !== 1) || (key[3] !== null && typeof key[3] !== "string") || (key[4] !== 0 && key[4] !== 1)) invalidQuery();
    rateIndex = key[0] as number; unpricedAfter = key[1] as number; unpricedDone = key[2] === 1; historyCursor = key[3] as string | undefined ?? undefined; historyDone = key[4] === 1;
  }
  const metadata = ctx.rates.flatMap(version => version.models.flatMap(model => model.tiers.map(tier => ({ version, model, tier }))));
  if (rateIndex > metadata.length) invalidQuery();
  // Validate the nested history cursor before any SQL, even on completed/off pages.
  if (historyCursor) decodeCursor(historyCursor, "calibration-history", ctx.revision,
    { period: { start: slice.start, end: slice.end }, limit: Math.min(31, page.limit), mode: ctx.calibrationMode });
  const factorHistory = historyDone ? { rows: [], nextCursor: null } : ctx.calibration.history({ start: slice.start, end: slice.end },
    { limit: Math.min(31, page.limit), cursor: historyCursor }, ctx.calibrationMode);
  const fit = analysisFits(ctx, [slice.end])[0]!, calibration = ctx.calibration.current(ctx.calibrationMode);
  const rows = ctx.db.prepare(`WITH counted AS MATERIALIZED (${countedUsageSql(compiled.sql, "c.*,c.rowid AS callRow", "calls_period_read")}),
    unpriced AS MATERIALIZED (SELECT provider,model,unpriced_reason,MIN(callRow) AS firstRow,${measureColumns}
      FROM counted WHERE price_status='unpriced' AND ?=0 GROUP BY provider,model,unpriced_reason
      HAVING MIN(callRow)>? ORDER BY firstRow LIMIT ?)
    SELECT 'totals' AS branch,NULL AS provider,NULL AS model,NULL AS unpriced_reason,0 AS firstRow,${measureColumns} FROM counted
    UNION ALL SELECT 'unpriced',provider,model,unpriced_reason,firstRow,calls,pricedCalls,unpricedCalls,aggregateCalls,input,cacheRead,cacheWrite,output,cacheWrite1h,reasoning,
      aic,aicInput,aicCacheRead,aicCacheWrite,aicOutput,piCost,possibleOverlap,pendingData,possibleUndercount FROM unpriced`)
    .all(...compiled.params, Number(unpricedDone), unpricedAfter, page.limit + 1) as (MeasureRow & { branch: string; provider: string | null; model: string | null; unpriced_reason: string; firstRow: number })[];
  const totals = analysisMeasure(ctx, rows.find(row => row.branch === "totals")!, fit);
  const unpriced = rows.filter(row => row.branch === "unpriced"), selected = unpriced.slice(0, page.limit);
  const stored = ctx.db.prepare(`SELECT rate_version FROM (${countedUsageSql(compiled.sql, "c.rate_version,c.run_id,c.is_report,c.source_file,c.source_kind", "calls_period_read")})
    WHERE rate_version IS NOT NULL GROUP BY rate_version ORDER BY rate_version LIMIT 201`).all(...compiled.params) as { rate_version: string }[];
  const rates = metadata.slice(rateIndex, rateIndex + page.limit);
  const rateRows: RateRow[] = rates.map(({ version, model, tier }) => ({ modelKey: dashboardKey(ctx, "model", model.id)!,
    version: version.id, model: dashboardLabel("model", model.id)!, aliases: model.aliases.map(alias => dashboardLabel("model", alias)!), validUntil: model.validUntil ?? null,
    tier: dashboardLabel("model", tier.name)!, abovePromptTokens: tier.abovePromptTokens, usdPerMillion: { ...tier.usdPerMillion } }));
  const hasMoreRates = rateIndex + rates.length < metadata.length, hasMoreUnpriced = unpriced.length > page.limit;
  const nextCursor = hasMoreRates || hasMoreUnpriced || factorHistory.nextCursor ? encodeCursor("rates", ctx.revision, query,
    [rateIndex + rates.length, selected.at(-1)?.firstRow ?? unpricedAfter, Number(!hasMoreUnpriced), factorHistory.nextCursor, Number(!factorHistory.nextCursor)]) : null;
  const usedVersions = new Set(rates.map(row => row.version.id));
  return { calibration, periodCalibration: fit.calibration, totals, versions: ctx.rates.filter(version => usedVersions.has(version.id)).map(({ models: _models, ...version }) =>
    ({ ...version, id: version.id, source: [...version.source].slice(0, 4096).join("") })),
    rates: { rows: rateRows, nextCursor: hasMoreRates ? nextCursor : null },
    storedRateVersions: stored.slice(0, 200).map(row => dashboardLabel("model", row.rate_version)!), storedRateVersionsTruncated: stored.length > 200,
    unpricedModels: { rows: selected.map(row => ({ modelKey: dashboardKey(ctx, "model", row.model), providerKey: dashboardKey(ctx, "provider", row.provider),
      provider: dashboardLabel("provider", row.provider), model: dashboardLabel("model", row.model), reason: dashboardLabel("model", row.unpriced_reason)!, measure: analysisMeasure(ctx, row, fit) })), nextCursor: hasMoreUnpriced ? nextCursor : null },
    factorHistory: { rows: factorHistory.rows, nextCursor: factorHistory.nextCursor ? nextCursor : null }, factorHistoryEnabled: ctx.calibrationMode !== "off", nextCursor };
}

const sliceParams = (query: URLSearchParams) => { const base = new URLSearchParams(); for (const key of ["start", "end", "filters"]) if (query.has(key)) base.set(key, query.get(key)!); return base; };
export const ANALYSIS_ROUTES: readonly DashboardRoute[] = [
  { path: "/api/cache", handle(ctx, query) {
    validateParams(query, ["start", "end", "filters", "limit", "cursor", "dailyCursor"]);
    const slice = parseSlice(sliceParams(query), ctx.now()); const page = parsePage(query); let dailyStart: number | undefined;
    if (query.has("dailyCursor")) {
      const key = decodeCursor(query.get("dailyCursor")!, "cache-daily", ctx.revision, slice);
      if (key.length !== 1 || typeof key[0] !== "number" || !safeTimestamp(key[0])) invalidQuery(); dailyStart = key[0];
    }
    return queryCache(ctx, slice, page, dailyStart);
  } },
  { path: "/api/reconciliation", handle(ctx, query) {
    validateParams(query, ["start", "end", "bucket", "limit", "cursor"]);
    const { start, end } = parseSlice(sliceParams(query), ctx.now()), page = parsePage(query), bucket = query.get("bucket") ?? "day";
    if (bucket !== "day" && bucket !== "month" && bucket !== "snapshot") invalidQuery();
    return queryReconciliation(ctx, { start, end }, { ...page, bucket });
  } },
  { path: "/api/rates", handle(ctx, query) {
    validateParams(query, ["start", "end", "filters", "limit", "cursor"]);
    return queryRates(ctx, parseSlice(sliceParams(query), ctx.now()), parsePage(query));
  } },
];
