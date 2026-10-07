import type { Db } from "@spider/db-core";
import type { CalibrationResult } from "../../dashboard-contract.js";
import { countedUsageSql, storedSelection } from "../../schema.js";
import { DAY_MS as DAY, safeTimestamp } from "../../dashboard-selection.js";
const stableThreshold = (value: number) => Number(value.toPrecision(12));
function calibrationFallback(mode: "auto" | "off" = "auto"): CalibrationResult {
  return { status: mode === "off" ? "off" : "uncalibrated", factor: null, windowStart: null, windowEnd: null,
    coveredHours: 0, computedAic: 0, counterDelta: 0, unpricedCalls: 0, method: "trailing-7d-ratio" };
}
type Snapshot = { id: number; ts: number; credits: number; account: string | null; reset: string | null } &
  ({ entitlement: number | null; remaining: number | null; valid?: never } | { valid: boolean; entitlement?: never; remaining?: never });
type Evidence = { span: number; aic: number; delta: number; unpriced: number };
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
function validSnapshot(row: Snapshot): boolean {
  if (row.valid !== undefined) return row.valid;
  return safeTimestamp(row.ts) && nonnegative(row.credits) && (row.entitlement === null || nonnegative(row.entitlement))
    && (row.remaining === null || nonnegative(row.remaining));
}
function acceptedPair(earlier: Snapshot, later: Snapshot): boolean {
  return validSnapshot(earlier) && validSnapshot(later) && earlier.account === later.account
    && earlier.reset === later.reset && later.credits >= earlier.credits && later.ts > earlier.ts && later.id > earlier.id;
}
function resultFor(anchor: number, evidence: Evidence): CalibrationResult {
  const result: CalibrationResult = { status: "uncalibrated", factor: null, windowStart: Math.max(0, anchor - 7 * DAY), windowEnd: anchor,
    coveredHours: evidence.span / 3600000, computedAic: evidence.aic, counterDelta: evidence.delta, unpricedCalls: evidence.unpriced, method: "trailing-7d-ratio" };
  const evidenceValid = [result.coveredHours, result.computedAic, result.counterDelta, result.unpricedCalls].every(nonnegative);
  if (!evidenceValid) {
    for (const field of ["coveredHours", "computedAic", "counterDelta", "unpricedCalls"] as const) {
      if (!nonnegative(result[field])) result[field] = 0;
    }
  }
  if (evidenceValid && result.coveredHours >= 24 && stableThreshold(result.computedAic) >= 500) {
    const ratio = result.counterDelta / result.computedAic;
    const stableRatio = stableThreshold(ratio);
    result.status = stableRatio < 0.05 || stableRatio > 2 ? "implausible" : "calibrated";
    result.factor = Math.max(0.05, Math.min(2, ratio));
  }
  return result;
}

/** Frozen pre-round-3 earliest scan for seeded differential comparisons. */
export function legacyEarliest(db: Db): CalibrationResult {
  const highwater = (db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM counter_snapshots").get() as { n: number }).n;
  let earliestFit: CalibrationResult | undefined;
        const rows = db.prepare(`SELECT rowid AS id,ts,credits_used AS credits,account_login AS account,
          reset_date AS reset,entitlement,remaining FROM counter_snapshots INDEXED BY counter_snapshots_ts
          WHERE rowid<=? ORDER BY ts,rowid`).all(highwater) as Snapshot[];
        const byTime = new Map<number, Snapshot>();
        for (const row of rows) {
          const prior = byTime.get(row.ts);
          if (!prior || validSnapshot(row) || !validSnapshot(prior)) byTime.set(row.ts, row);
        }
        const snapshots = [...byTime.values()];
        const intervals: Evidence[] = [];
        const ranges: [number, number, number][] = [];
        for (let i = 1; i < snapshots.length; i++) {
          const earlier = snapshots[i - 1]!, later = snapshots[i]!;
          // A pair longer than seven days cannot be wholly inside any window.
          const accepted = acceptedPair(earlier, later) && later.ts - earlier.ts <= 7 * DAY;
          intervals.push({ span: accepted ? later.ts - earlier.ts : 0, delta: accepted ? later.credits - earlier.credits : 0,
            aic: 0, unpriced: 0 });
          if (accepted) ranges.push([i - 1, earlier.ts, later.ts]);
        }
        if (ranges.length) {
          // Disjoint accepted pairs enumerate indexed calls once. Preserve global
          // counted-selection precedence, then group by pair, not timestamp.
          const calls = db.prepare(`WITH interval_calls AS MATERIALIZED (
            SELECT json_extract(span.value,'$[0]') AS pair,r.rowid AS callId
            FROM json_each(?) span CROSS JOIN calls r INDEXED BY calls_period_read
            WHERE r.ts>=json_extract(span.value,'$[1]') AND r.ts<json_extract(span.value,'$[2]')),
            counted AS MATERIALIZED (${countedUsageSql("c.rowid IN (SELECT callId FROM interval_calls)",
              "c.rowid AS callId,c.aic,c.price_status,c.run_id,c.is_report,c.source_file,c.source_kind", undefined, storedSelection(db))})
            SELECT i.pair,COALESCE(SUM(c.aic),0) AS aic,SUM(c.price_status='unpriced') AS unpriced
            FROM interval_calls i JOIN counted c USING(callId) GROUP BY i.pair ORDER BY i.pair`).all(JSON.stringify(ranges)) as
            { pair: number; aic: number; unpriced: number }[];
          for (const call of calls) { intervals[call.pair]!.aic = call.aic; intervals[call.pair]!.unpriced = call.unpriced; }
        }
        // Every valid observation is a candidate, including partial days. Each
        // pair enters and leaves the seven-day sum once, even with no fit in a year.
        const sums: Evidence = { span: 0, aic: 0, delta: 0, unpriced: 0 };
        let first = 0;
        for (let i = 0; i < snapshots.length; i++) {
          const anchor = snapshots[i]!;
          if (i > 0) {
            const added = intervals[i - 1]!;
            sums.span += added.span; sums.aic += added.aic; sums.delta += added.delta; sums.unpriced += added.unpriced;
          }
          while (first < i && snapshots[first]!.ts < anchor.ts - 7 * DAY) {
            const removed = intervals[first++]!;
            sums.span -= removed.span; sums.aic -= removed.aic; sums.delta -= removed.delta; sums.unpriced -= removed.unpriced;
          }
          if (!validSnapshot(anchor)) continue;
          const fit = resultFor(anchor.ts, sums);
          if (fit.status === "calibrated") { earliestFit = fit; break; }
        }

return earliestFit ?? calibrationFallback();
}
