import type { DashboardQueryContext, Period } from "./dashboard-contract.js";
import type { CounterInterval } from "./dashboard-v4-contract.js";
import { DAY_MS, invalidQuery, safeTimestamp } from "./dashboard-selection.js";
import { countedUsageSql, storedSelection } from "./schema.js";

type Anchor = { id: number; ts: number; credits: number; account: string | null; reset: string | null; entitlement: number | null; remaining: number | null };
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
function valid(row: Anchor): boolean {
  return safeTimestamp(row.ts) && nonnegative(row.credits) && (row.entitlement === null || nonnegative(row.entitlement)) &&
    (row.remaining === null || nonnegative(row.remaining));
}
const validSql = (alias: string) => `${alias}.ts BETWEEN 0 AND 8640000000000000 AND ${alias}.ts=CAST(${alias}.ts AS INTEGER)
  AND ${alias}.credits_used BETWEEN 0 AND 1.7976931348623157e308
  AND (${alias}.entitlement IS NULL OR ${alias}.entitlement BETWEEN 0 AND 1.7976931348623157e308)
  AND (${alias}.remaining IS NULL OR ${alias}.remaining BETWEEN 0 AND 1.7976931348623157e308)`;

/** Whole observed spans only. Never interpolate or split a billing delta at a
 * midnight, reset or period boundary. Pair acceptance follows the engine,
 * including invalid-only gaps and highest-valid duplicate precedence. */
export function readCounterIntervals(ctx: DashboardQueryContext, period: Period): readonly CounterInterval[] {
  if (!safeTimestamp(period.start) || !safeTimestamp(period.end) || period.end < period.start || period.end - period.start > 366 * DAY_MS) invalidQuery();
  const end = Math.min(period.end, ctx.now());
  const anchors = ctx.db.prepare(`SELECT s.rowid AS id,s.ts,s.credits_used AS credits,s.account_login AS account,
      s.reset_date AS reset,s.entitlement,s.remaining
    FROM counter_snapshots s INDEXED BY counter_snapshots_ts WHERE s.ts>=? AND s.ts<=?
      AND s.rowid=(SELECT d.rowid FROM counter_snapshots d INDEXED BY counter_snapshots_ts WHERE d.ts=s.ts
        ORDER BY CASE WHEN ${validSql("d")} THEN 1 ELSE 0 END DESC,d.rowid DESC LIMIT 1)
    ORDER BY s.ts,s.rowid`).all(period.start, end) as Anchor[];
  const intervals: CounterInterval[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!, b = anchors[i]!;
    if (!valid(a) || !valid(b) || a.account !== b.account || a.reset !== b.reset || b.credits < a.credits ||
      b.ts <= a.ts || b.id <= a.id || b.ts - a.ts > 7 * DAY_MS) continue;
    intervals.push({ start: a.ts, end: b.ts, counterDelta: b.credits - a.credits, publishedEstimate: null, ratio: null });
  }
  // Bound both the JSON input and SQL aggregate output, not one query per pair.
  for (let i = 0; i < intervals.length; i += 200) {
    const spans = intervals.slice(i, i + 200).map((row, key) => [key, row.start, row.end]);
    const rows = ctx.db.prepare(`WITH interval_calls AS MATERIALIZED (
      SELECT json_extract(span.value,'$[0]') AS pair,r.rowid AS callId FROM json_each(?) span
      CROSS JOIN calls r INDEXED BY calls_period_read
      WHERE r.ts>=json_extract(span.value,'$[1]') AND r.ts<json_extract(span.value,'$[2]')),
      counted AS MATERIALIZED (${countedUsageSql("c.rowid IN (SELECT callId FROM interval_calls)",
        "c.rowid AS callId,c.aic,c.price_status,c.run_id,c.is_report,c.source_file", undefined, storedSelection(ctx.db))})
      SELECT i.pair,COUNT(*) AS calls,SUM(c.aic) AS publishedEstimate FROM interval_calls i JOIN counted c USING(callId) GROUP BY i.pair`)
      .all(JSON.stringify(spans)) as { pair: number; calls: number; publishedEstimate: number | null }[];
    const measures = new Map(rows.map(row => [row.pair, row]));
    spans.forEach((_, key) => {
      const interval = intervals[i + key]!, measure = measures.get(key);
      // No local calls is a known zero. All-unpriced calls is unavailable, not zero.
      interval.publishedEstimate = measure ? measure.publishedEstimate : 0;
      const ratio = interval.publishedEstimate !== null && interval.publishedEstimate > 0 ? interval.counterDelta / interval.publishedEstimate : null;
      interval.ratio = ratio !== null && Number.isFinite(ratio) ? ratio : null;
    });
  }
  return intervals.reverse();
}
