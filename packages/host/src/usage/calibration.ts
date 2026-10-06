import type { Db } from "@spider/db-core";
import type { CalibrationResult, CalibrationService, Period } from "./dashboard-contract.js";
import { storedSelection, countedUsageSql } from "./schema.js";
import { DAY_MS as DAY, safeTimestamp, invalidQuery, validatePage, encodeCursor, decodeCursor } from "./dashboard-selection.js";

const MAX_TS = 8_640_000_000_000_000;
export function calibrationFallback(mode: "auto" | "off" = "auto"): CalibrationResult {
  return { status: mode === "off" ? "off" : "uncalibrated", factor: null, windowStart: null, windowEnd: null,
    coveredHours: 0, computedAic: 0, counterDelta: 0, unpricedCalls: 0, method: "trailing-7d-ratio" };
}
type Snapshot = { id: number; ts: number; credits: number; account: string | null; reset: string | null; entitlement: number | null; remaining: number | null };
type CallTotal = { ts: number; aic: number; unpriced: number };
type Evidence = { span: number; aic: number; delta: number; unpriced: number };
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
function validSnapshot(row: Snapshot): boolean {
  return safeTimestamp(row.ts) && nonnegative(row.credits) && (row.entitlement === null || nonnegative(row.entitlement))
    && (row.remaining === null || nonnegative(row.remaining));
}
function acceptedPair(earlier: Snapshot, later: Snapshot): boolean {
  return validSnapshot(earlier) && validSnapshot(later) && earlier.account === later.account
    && earlier.reset === later.reset && later.credits >= earlier.credits && later.ts > earlier.ts && later.id > earlier.id;
}
function resultFor(anchor: Snapshot, evidence: Evidence): CalibrationResult {
  const result: CalibrationResult = { ...calibrationFallback(), windowStart: Math.max(0, anchor.ts - 7 * DAY), windowEnd: anchor.ts,
    coveredHours: evidence.span / 3600000, computedAic: evidence.aic, counterDelta: evidence.delta, unpricedCalls: evidence.unpriced };
  const evidenceValid = [result.coveredHours, result.computedAic, result.counterDelta, result.unpricedCalls].every(nonnegative);
  if (!evidenceValid) {
    for (const field of ["coveredHours", "computedAic", "counterDelta", "unpricedCalls"] as const) {
      if (!nonnegative(result[field])) result[field] = 0;
    }
  }
  if (evidenceValid && result.coveredHours >= 24 && result.computedAic >= 500) {
    const ratio = result.counterDelta / result.computedAic;
    result.status = ratio < 0.05 || ratio > 2 ? "implausible" : "calibrated";
    result.factor = Math.max(0.05, Math.min(2, ratio));
  }
  return result;
}
function lowerBound(values: readonly number[], value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid]! < value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Fixed-rate/build instance. Append-only counter keys and call content, not coordination, invalidate fits. */
export function createCalibrationService(db: Db, options: { revision: () => string }): CalibrationService {
  let generation = "";
  const cache = new Map<string, CalibrationResult>();
  let earliestFit: CalibrationResult | undefined;
  function batch(ends: readonly number[], mode: "auto" | "off", frozen?: number): { results: CalibrationResult[]; highwater: number } {
    if (ends.length > 200 || ends.some(end => !safeTimestamp(end)) || (ends.length > 1 && Math.max(...ends) - Math.min(...ends) > 366 * DAY)) invalidQuery();
    if (mode === "off" || !ends.length) return { results: ends.map(() => calibrationFallback(mode)), highwater: 0 };
    // Indexed anchor probes plus one bounded snapshot range. No raw payload is read.
    const rows = db.prepare(`WITH cap AS MATERIALIZED (SELECT COALESCE(?,MAX(rowid),0) AS highwater FROM counter_snapshots),
      anchors AS MATERIALIZED (SELECT (SELECT ts FROM counter_snapshots INDEXED BY counter_snapshots_ts
        WHERE ts<=j.value AND rowid<=cap.highwater AND ts BETWEEN 0 AND 8640000000000000 AND ts=CAST(ts AS INTEGER)
          AND credits_used BETWEEN 0 AND 1.7976931348623157e308
          AND (entitlement IS NULL OR entitlement BETWEEN 0 AND 1.7976931348623157e308)
          AND (remaining IS NULL OR remaining BETWEEN 0 AND 1.7976931348623157e308)
        ORDER BY ts DESC,rowid DESC LIMIT 1) AS ts FROM json_each(?) j CROSS JOIN cap),
      evidence AS MATERIALIZED (SELECT DISTINCT s.rowid AS id,s.ts,s.credits_used AS credits,s.account_login AS account,
        s.reset_date AS reset,s.entitlement,s.remaining FROM (SELECT DISTINCT ts FROM anchors) a
        CROSS JOIN counter_snapshots s INDEXED BY counter_snapshots_ts CROSS JOIN cap
        WHERE s.ts>=a.ts-? AND s.ts<=a.ts AND s.rowid<=cap.highwater)
      SELECT s.*,cap.highwater FROM cap LEFT JOIN evidence s ON 1 ORDER BY s.ts,s.id`).all(frozen ?? null, JSON.stringify(ends), 7 * DAY) as (Snapshot & { highwater: number })[];
    const highwater = rows[0]?.highwater ?? 0;
    const nextGeneration = `${options.revision()}:${highwater}`;
    if (nextGeneration !== generation) { generation = nextGeneration; cache.clear(); earliestFit = undefined; }
    const byTime = new Map<number, Snapshot>();
    for (const row of rows) {
      if (row.id === null) continue;
      const prior = byTime.get(row.ts);
      // Highest valid stable key wins a duplicate timestamp. If none is valid,
      // retain the invalid timestamp as a gap rather than bridging across it.
      if (!prior || validSnapshot(row) || !validSnapshot(prior)) byTime.set(row.ts, row);
    }
    const snapshots = [...byTime.values()];
    const times = snapshots.map(row => row.ts);
    const anchors = ends.map(end => {
      let i = lowerBound(times, end + 1) - 1;
      while (i >= 0 && !validSnapshot(snapshots[i]!)) i--;
      return i < 0 ? undefined : snapshots[i];
    });
    // Call revision catches selection/pricing edits; snapshot high-water also catches
    // out-of-order appends. Anchor ts + stable rowid distinguishes duplicate timestamps.
    const key = (anchor: Snapshot) => `${anchor.ts}:${anchor.id}`;
    // Keep every hit and computed result request-local before any eviction.
    // Even a cache miss later in this batch must not invalidate an earlier hit.
    const requested = new Map<string, CalibrationResult>();
    const missing: Snapshot[] = [];
    for (const anchor of anchors) {
      if (!anchor || requested.has(key(anchor))) continue;
      const cached = cache.get(key(anchor));
      if (cached) requested.set(key(anchor), cached);
      else if (lowerBound(times, anchor.ts - 7 * DAY) >= lowerBound(times, anchor.ts + 1) - 1) {
        requested.set(key(anchor), { ...calibrationFallback(), windowStart: Math.max(0, anchor.ts - 7 * DAY), windowEnd: anchor.ts });
      } else missing.push(anchor);
    }
    if (missing.length) {
      const ranges: [number, number][] = [];
      for (const anchor of [...missing].sort((a, b) => a.ts - b.ts)) {
        const last = ranges.at(-1), start = snapshots[lowerBound(times, anchor.ts - 7 * DAY)]!.ts;
        if (last && start <= last[1]) last[1] = Math.max(last[1], anchor.ts);
        else ranges.push([start, anchor.ts]);
      }
      const contiguous = ranges.length === 1;
      // Sparse anchors may be years apart. Enumerate only their indexed ranges,
      // then select those rowids once with global provenance/coverage precedence.
      const predicate = contiguous ? "c.ts >= ? AND c.ts < ?" : `c.rowid IN (
        SELECT r.rowid FROM json_each(?) span CROSS JOIN calls r INDEXED BY calls_period_read
        WHERE r.ts>=json_extract(span.value,'$[0]') AND r.ts<json_extract(span.value,'$[1]'))`;
      const calls = db.prepare(`SELECT ts,COALESCE(SUM(aic),0) AS aic,SUM(price_status='unpriced') AS unpriced
        FROM (${countedUsageSql(predicate, "c.ts,c.aic,c.price_status,c.run_id,c.is_report,c.source_file,c.source_kind", contiguous ? "calls_period_read" : undefined, storedSelection(db))})
        GROUP BY ts ORDER BY ts`).all(...(contiguous ? ranges[0]! : [JSON.stringify(ranges)])) as CallTotal[];
      const prefix: Evidence[] = [{ span: 0, aic: 0, delta: 0, unpriced: 0 }];
      let cursor = 0;
      for (let i = 1; i < snapshots.length; i++) {
        const earlier = snapshots[i - 1]!, later = snapshots[i]!;
        const evidence = { ...prefix[i - 1]! };
        const accepted = acceptedPair(earlier, later);
        if (accepted) { evidence.span += later.ts - earlier.ts; evidence.delta += later.credits - earlier.credits; }
        while (cursor < calls.length && calls[cursor]!.ts < later.ts) {
          const call = calls[cursor++]!;
          if (accepted && call.ts >= earlier.ts) { evidence.aic += call.aic; evidence.unpriced += call.unpriced; }
        }
        prefix.push(evidence);
      }
      for (const anchor of missing) {
        const first = lowerBound(times, anchor.ts - 7 * DAY), last = lowerBound(times, anchor.ts + 1) - 1;
        const from = prefix[first]!, to = prefix[last]!;
        const result = resultFor(anchor, { span: to.span - from.span, aic: to.aic - from.aic,
          delta: to.delta - from.delta, unpriced: to.unpriced - from.unpriced });
        requested.set(key(anchor), result);
      }
    }
    // A request has at most 200 anchors, below the cache bound. Protect its
    // entries, including single-snapshot fallbacks, while trimming older keys.
    for (const [key, result] of requested) cache.set(key, result);
    for (const key of cache.keys()) {
      if (cache.size <= 512) break;
      if (!requested.has(key)) cache.delete(key);
    }
    return { results: anchors.map(anchor => {
      if (!anchor) return calibrationFallback();
      const result = requested.get(key(anchor));
      if (!result) throw new Error("Missing calibration result for requested anchor");
      return { ...result };
    }), highwater };
  }
  return {
    current: mode => batch([MAX_TS], mode).results[0]!,
    at: (end, mode) => batch([end], mode).results[0]!,
    earliest(mode) {
      if (mode === "off") return calibrationFallback(mode);
      const highwater = (db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM counter_snapshots").get() as { n: number }).n;
      const nextGeneration = `${options.revision()}:${highwater}`;
      if (nextGeneration !== generation) { generation = nextGeneration; cache.clear(); earliestFit = undefined; }
      if (!earliestFit) {
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
          const fit = resultFor(anchor, sums);
          if (fit.status === "calibrated") { earliestFit = fit; break; }
        }
        earliestFit ??= calibrationFallback();
      }
      return { ...earliestFit };
    },
    atMany: (ends, mode) => batch(ends, mode).results,
    history(period: Period, page, mode) {
      validatePage(page, 31);
      if (!safeTimestamp(period.start) || !safeTimestamp(period.end) || period.end < period.start || period.end - period.start > 366 * DAY) invalidQuery();
      const revision = options.revision();
      const query = { period, limit: page.limit, mode };
      let day = Math.floor(period.start / DAY) * DAY, frozen: number | undefined;
      if (page.cursor) {
        const key = decodeCursor(page.cursor, "calibration-history", revision, query);
        if (key.length !== 2 || typeof key[0] !== "number" || typeof key[1] !== "number" || !safeTimestamp(key[0]) || !Number.isSafeInteger(key[1]) || key[1] < 0 || key[0] % DAY !== 0 || key[0] < day || key[0] >= period.end) invalidQuery();
        day = key[0]; frozen = key[1];
      }
      if (mode === "off") return { rows: [], nextCursor: null };
      const days: number[] = [];
      for (; day < period.end && days.length < page.limit; day += DAY) days.push(day);
      const { results, highwater } = batch(days.map(day => Math.min(day + DAY, period.end) - 1), mode, frozen);
      return { rows: days.map((day, i) => ({ day, calibration: results[i]! })), nextCursor: day < period.end
        ? encodeCursor("calibration-history", revision, query, [day, highwater]) : null };
    },
  };
}
