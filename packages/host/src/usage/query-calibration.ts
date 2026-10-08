import type { CalibrationResult, DashboardQueryContext, DashboardRoute, Period } from "./dashboard-contract.js";
import type { CalibrationData, RateRowV4 } from "./dashboard-v4-contract.js";
import type { CounterSnapshot } from "./ledger.js";
import type { RateVersion } from "./types.js";
import { unpricedReasonSql } from "./unpriced-reasons.js";
import { billingPeriod } from "./billing-pace.js";
import { readCounterIntervals } from "./counter-intervals.js";
import { queryStatusV4, readIngestionStatus } from "./ingestion-status.js";
import { readSourceErrorDiagnostics } from "./source-error-diagnostics.js";
import { DAY_MS, validateParams } from "./dashboard-selection.js";
import { dashboardLabel } from "./dashboard-identities.js";
import { countedUsageSql, storedSelection } from "./schema.js";

function evidencePeriod(ctx: DashboardQueryContext): Period {
  const latest = ctx.db.prepare(`SELECT ts,credits_used AS creditsUsed,reset_date AS resetDate FROM counter_snapshots INDEXED BY counter_snapshots_ts
    WHERE ts<=? AND ts BETWEEN 0 AND 8640000000000000 AND ts=CAST(ts AS INTEGER)
      AND credits_used BETWEEN 0 AND 1.7976931348623157e308
      AND (entitlement IS NULL OR entitlement BETWEEN 0 AND 1.7976931348623157e308)
      AND (remaining IS NULL OR remaining BETWEEN 0 AND 1.7976931348623157e308)
    ORDER BY ts DESC,rowid DESC LIMIT 1`).get(ctx.now()) as Omit<CounterSnapshot, "raw"> | undefined;
  const period = billingPeriod(ctx.now(), latest ? { ...latest, raw: {} } : undefined);
  return { start: period.start, end: Math.min(period.end, ctx.now()) };
}
function accepted(fit: CalibrationResult): boolean {
  return fit.status === "calibrated" && fit.factor !== null && Number.isFinite(fit.factor) && fit.factor >= 0;
}
/** Retain the last accepted factor during an outage, not a rejected engine fit.
 * Descending indexed pages and bounded endpoint batches avoid a history-sized list. */
function lastAccepted(ctx: DashboardQueryContext): CalibrationResult | null {
  let before = ctx.now() + 1;
  for (;;) {
    const rows = ctx.db.prepare(`SELECT DISTINCT ts FROM counter_snapshots INDEXED BY counter_snapshots_ts
      WHERE ts BETWEEN 0 AND 8640000000000000 AND ts=CAST(ts AS INTEGER) AND ts<? ORDER BY ts DESC LIMIT 200`).all(before) as { ts: number }[];
    if (!rows.length) return null;
    for (let i = 0; i < rows.length;) {
      let j = i + 1;
      while (j < rows.length && rows[i]!.ts - rows[j]!.ts <= 366 * DAY_MS) j++;
      const fits = ctx.calibration.atMany(rows.slice(i, j).map(row => row.ts), ctx.calibrationMode);
      const fit = fits.find(accepted);
      if (fit) return fit;
      i = j;
    }
    if (rows.length < 200) return null;
    before = rows.at(-1)!.ts;
  }
}
function correctionBasis(ctx: DashboardQueryContext): Pick<CalibrationData["correction"], "factor" | "status"> {
  const unavailable = ctx.status().counter.availability === "unavailable";
  if (ctx.calibrationMode === "off") return { factor: null, status: unavailable ? "counter-unavailable" : "published-only" };
  // The shared credit projector evaluates the half-open endpoint at now - 1.
  const point = Math.max(0, ctx.now() - 1);
  const fit = ctx.calibration.at(point, ctx.calibrationMode);
  if (accepted(fit)) return { factor: fit.factor, status: unavailable ? "counter-unavailable" : "calibrated" };
  const earliest = ctx.calibration.earliest(ctx.calibrationMode);
  const backApplied = accepted(earliest) && earliest.windowEnd !== null && point < earliest.windowEnd;
  if (unavailable) return { factor: (lastAccepted(ctx) ?? (accepted(earliest) ? earliest : null))?.factor ?? null, status: "counter-unavailable" };
  return backApplied ? { factor: earliest.factor, status: "back-applied" } : { factor: null, status: "published-only" };
}
const sumKnown = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  if (!known.length) return null;
  const total = known.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : null;
};
function publishedRates(ctx: DashboardQueryContext): readonly RateRowV4[] {
  const credits = (usd: number | null): number | null => typeof usd === "number" && usd >= 0 && Number.isFinite(usd * 100) ? usd * 100 : null;
  const now = ctx.now();
  let version: RateVersion | undefined, effectiveFrom = -Infinity;
  for (const candidate of ctx.rates) {
    const from = Date.parse(candidate.effectiveFrom);
    if (from <= now && from > effectiveFrom) { version = candidate; effectiveFrom = from; }
  }
  if (!version) return [];
  const sourceDate = version.sourceAsOf;
  return version.models.filter(model => !model.validUntil || now < Date.parse(model.validUntil)).flatMap(model => model.tiers.map(tier => ({
    model: dashboardLabel("model", model.id) ?? "Unknown model", tier: dashboardLabel("model", tier.name) ?? "Unknown tier",
    abovePromptTokens: tier.abovePromptTokens, input: credits(tier.usdPerMillion.input), cacheRead: credits(tier.usdPerMillion.cacheRead),
    cacheWrite: credits(tier.usdPerMillion.cacheWrite), output: credits(tier.usdPerMillion.output), sourceDate,
  })));
}
export function queryCalibration(ctx: DashboardQueryContext): CalibrationData {
  const period = evidencePeriod(ctx), intervals = readCounterIntervals(ctx, period);
  type Daily = { day: number; publishedEstimate: number | null; unpriced: number; compactionWithoutModel: number };
  const selection = countedUsageSql("c.ts>=? AND c.ts<?",
    "c.ts,c.aic,c.actor,c.model,c.price_status,c.unpriced_reason,c.run_id,c.is_report,c.source_file", "calls_period_read", storedSelection(ctx.db));
  const days = ctx.db.prepare(`WITH counted AS MATERIALIZED (${selection})
    SELECT CAST(ts/? AS INTEGER)*? AS day,SUM(aic) AS publishedEstimate,SUM(price_status='unpriced') AS unpriced,
      SUM(actor='compaction' AND model IS NULL) AS compactionWithoutModel FROM counted GROUP BY day ORDER BY day`)
    .all(period.start, period.end, DAY_MS, DAY_MS) as Daily[];
  const byDay = new Map(days.map(row => [row.day, row]));
  const evidenceByDay = new Map<number, typeof intervals[number][]>();
  for (const interval of intervals) {
    const day = Math.floor(interval.end / DAY_MS) * DAY_MS;
    const rows = evidenceByDay.get(day) ?? []; rows.push(interval); evidenceByDay.set(day, rows);
  }
  const daily: CalibrationData["daily"][number][] = [];
  for (let day = Math.floor(period.start / DAY_MS) * DAY_MS; day < period.end; day += DAY_MS) {
    const observed = evidenceByDay.get(day);
    daily.push({ day, publishedEstimate: observed ? sumKnown(observed.map(row => row.publishedEstimate)) : byDay.get(day)?.publishedEstimate ?? null,
      counterDelta: observed ? sumKnown(observed.map(row => row.counterDelta)) : null });
  }
  // An endpoint exactly at now's midnight belongs to that UTC date, not the
  // preceding date, even though its call span is half-open and already complete.
  const endpointDay = Math.floor(period.end / DAY_MS) * DAY_MS;
  if (endpointDay === period.end && evidenceByDay.has(endpointDay)) {
    const observed = evidenceByDay.get(endpointDay)!;
    daily.push({ day: endpointDay, publishedEstimate: sumKnown(observed.map(row => row.publishedEstimate)), counterDelta: sumKnown(observed.map(row => row.counterDelta)) });
  }
  const unpriced = ctx.db.prepare(`WITH counted AS MATERIALIZED (${selection})
    SELECT model,${unpricedReasonSql("unpriced_reason")} AS reason,COUNT(*) AS calls FROM counted WHERE price_status='unpriced'
    GROUP BY model,reason ORDER BY calls DESC,model,reason`).all(period.start, period.end) as
    { model: string | null; reason: string; calls: number }[];
  return {
    correction: { ...correctionBasis(ctx), publishedEstimate: sumKnown(intervals.map(row => row.publishedEstimate)),
      accountCounter: sumKnown(intervals.map(row => row.counterDelta)), coveredHours: intervals.reduce((sum, row) => sum + (row.end - row.start) / 3600000, 0) },
    daily, intervals, rates: publishedRates(ctx),
    unpricedModels: unpriced.map(row => ({ model: dashboardLabel("model", row.model), reason: row.reason, calls: row.calls })),
    ingestion: readIngestionStatus(ctx),
    errors: readSourceErrorDiagnostics(ctx.db, 200).rows.map(row => ({ pathLabel: row.sourceLabel, code: row.code, count: row.count, lastCheckedAt: row.lastCheckedAt })),
    gaps: { unpricedCalls: days.reduce((sum, row) => sum + row.unpriced, 0), compactionWithoutModel: days.reduce((sum, row) => sum + row.compactionWithoutModel, 0),
      daysWithoutCounter: daily.filter(row => row.counterDelta === null).map(row => row.day) },
  };
}
export const CALIBRATION_V4_ROUTES: readonly DashboardRoute[] = [
  { path: "/api/status", handle(ctx, query) { validateParams(query, []); return queryStatusV4(ctx); } },
  { path: "/api/calibration", handle(ctx, query) { validateParams(query, []); return queryCalibration(ctx); }, responsePeriod: evidencePeriod },
];
