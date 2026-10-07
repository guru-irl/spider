import type { Db } from "@spider/db-core";
import type { CalibrationResult, CalibrationService, Period } from "./dashboard-contract.js";
import { storedSelection, countedUsageSql, selectionCtes, selectedPredicate } from "./schema.js";
import { DAY_MS as DAY, safeTimestamp, invalidQuery, validatePage, encodeCursor, decodeCursor } from "./dashboard-selection.js";

const MAX_TS = 8_640_000_000_000_000;
/** Internal fan-out only. Public callers retain the 200-endpoint cap. Shared history fits are read-only. */
export interface InternalCalibrationService extends CalibrationService {
  windows(period: Period, mode: "auto" | "off"): readonly { from: number; calibration: CalibrationResult }[];
}
// SQL interval SUM is shared by at/atMany/windows; each window then adds those
// sums in timestamp order from zero. This changes fractional last bits versus
// the old per-timestamp sums, but not whole-AIC results. Acceptance thresholds
// use 12 significant digits to avoid floating noise at 500 AIC or ratios 0.05/2.
const stableThreshold = (value: number) => Number(value.toPrecision(12));
export function calibrationFallback(mode: "auto" | "off" = "auto"): CalibrationResult {
  return { status: mode === "off" ? "off" : "uncalibrated", factor: null, windowStart: null, windowEnd: null,
    coveredHours: 0, computedAic: 0, counterDelta: 0, unpricedCalls: 0, method: "trailing-7d-ratio" };
}
type Snapshot = { id: number; ts: number; credits: number; account: string | null; reset: string | null } &
  ({ entitlement: number | null; remaining: number | null; valid?: never } | { valid: boolean; entitlement?: never; remaining?: never });
type SnapshotTuple = [id: number, ts: number, credits: number, account: string | null, reset: string | null, valid: number, highwater: number];
type CallTotal = [pair: number, aic: number, unpriced: number];
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
function sumEvidence(spans: Float64Array, aics: Float64Array, deltas: Float64Array, unpriced: Float64Array, first: number, last: number, out: Evidence): Evidence {
  let span = 0, aic = 0, delta = 0, count = 0;
  for (let i = first + 1; i <= last; i++) {
    span += spans[i]!; aic += aics[i]!; delta += deltas[i]!; count += unpriced[i]!;
  }
  out.span = span; out.aic = aic; out.delta = delta; out.unpriced = count;
  return out;
}
function lowerBound(values: readonly number[] | Float64Array, value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid]! < value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Fixed-rate/build instance. Append-only counter keys and call content, not coordination, invalidate fits. */
export function createCalibrationService(db: Db, options: { revision: () => string }): InternalCalibrationService {
  let generation = "";
  const cache = new Map<number, CalibrationResult>();
  let earliestFit: CalibrationResult | undefined;
  let earliestRevision = "", earliestHighwater = 0;
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
    return resolve(ends, rows);
  }
  function resolve(inputEnds: readonly number[], rows: Iterable<(Snapshot & { highwater: number }) | SnapshotTuple>, copyResults = true, historyStart?: number):
    { results: CalibrationResult[]; highwater: number; points: readonly number[] } {
    // Dense observations live in compact columns, not one retained native/JS
    // object per row. Grow geometrically; strings share one intern table.
    // A dense year at ten-minute cadence fits in 64K slots, avoiding transient
    // growth buffers. This is an initial allocation, not a snapshot-count cap.
    let capacity = historyStart === undefined ? 1024 : 65536, length = 0, highwater = 0;
    let times = new Float64Array(capacity), ids = new Float64Array(capacity), credits = new Float64Array(capacity), valid = new Uint8Array(capacity);
    const accounts: (string | null)[] = [], resets: (string | null)[] = [], strings = new Map<string, string>();
    const intern = (value: string | null) => {
      if (value === null) return null;
      const prior = strings.get(value);
      if (prior !== undefined) return prior;
      strings.set(value, value); return value;
    };
    for (const row of rows) {
      const tuple = Array.isArray(row);
      highwater = tuple ? row[6] : row.highwater;
      const id = tuple ? row[0] : row.id, ts = tuple ? row[1] : row.ts, credit = tuple ? row[2] : row.credits;
      const account = tuple ? row[3] : row.account, reset = tuple ? row[4] : row.reset;
      if (id === null) continue;
      const accepted = tuple ? row[5] === 1 : validSnapshot(row);
      let index = length;
      if (length && times[length - 1] === ts) {
        if (!accepted && valid[length - 1]) continue;
        index = length - 1;
      } else {
        if (length === capacity) {
          capacity *= 2;
          const grow = (old: Float64Array) => { const next = new Float64Array(capacity); next.set(old); return next; };
          times = grow(times); ids = grow(ids); credits = grow(credits);
          const next = new Uint8Array(capacity); next.set(valid); valid = next;
        }
        length++;
      }
      times[index] = ts; ids[index] = id; credits[index] = credit; valid[index] = Number(accepted);
      accounts[index] = intern(account); resets[index] = intern(reset);
    }
    times = times.subarray(0, length);
    const nextGeneration = `${options.revision()}:${highwater}`;
    if (nextGeneration !== generation) { generation = nextGeneration; cache.clear(); }
    const ends = historyStart === undefined ? inputEnds : [historyStart];
    if (historyStart !== undefined) for (let i = 0; i < length; i++) if (valid[i] && times[i]! > historyStart) (ends as number[]).push(times[i]!);
    const anchors = ends.map(end => {
      let i = lowerBound(times, end + 1) - 1;
      while (i >= 0 && !valid[i]) i--;
      return i;
    });
    // Copy all hits into request-local storage before any cache promotion/eviction.
    const requested: (CalibrationResult | undefined)[] = new Array(length), missing: number[] = [];
    for (const anchor of anchors) {
      if (anchor < 0 || requested[anchor]) continue;
      const cached = cache.get(ids[anchor]!);
      if (cached) requested[anchor] = cached;
      else if (lowerBound(times, times[anchor]! - 7 * DAY) >= anchor) {
        requested[anchor] = { ...calibrationFallback(), windowStart: Math.max(0, times[anchor]! - 7 * DAY), windowEnd: times[anchor]! };
      } else missing.push(anchor);
    }
    if (missing.length) {
      const ranges: [number, number][] = [];
      for (const anchor of [...missing].sort((a, b) => a - b)) {
        const last = ranges.at(-1), start = times[lowerBound(times, times[anchor]! - 7 * DAY)]!;
        if (last && start <= last[1]) last[1] = Math.max(last[1], times[anchor]!);
        else ranges.push([start, times[anchor]!]);
      }
      // This projection shares global selection precedence but needs no overlap
      // metadata. SQL sums each disjoint interval once; only 512 interval totals
      // (never per-call rows) are materialized per bind.
      const statement = db.prepare(`WITH RECURSIVE ${selectionCtes},
        calibration_intervals AS MATERIALIZED (SELECT json_extract(span.value,'$[0]') AS pair,
          (SELECT json_array(COALESCE(SUM(c.aic),0),COALESCE(SUM(c.price_status='unpriced'),0))
            FROM calls c INDEXED BY calls_period_read
            WHERE c.ts>=json_extract(span.value,'$[1]') AND c.ts<json_extract(span.value,'$[2]')
              AND ${selectedPredicate("c", storedSelection(db))}) AS calibration_totals
        FROM json_each(?) span)
        SELECT pair,json_extract(calibration_totals,'$[0]'),json_extract(calibration_totals,'$[1]')
        FROM calibration_intervals`).raw();
      const aics = new Float64Array(length), unpriced = new Float64Array(length);
      const spans = new Float64Array(length), deltas = new Float64Array(length);
      for (let i = 1; i < length; i++) {
        if (valid[i - 1] && valid[i] && accounts[i - 1] === accounts[i] && resets[i - 1] === resets[i]
          && credits[i]! >= credits[i - 1]! && times[i]! > times[i - 1]! && ids[i]! > ids[i - 1]!) {
          spans[i] = times[i]! - times[i - 1]!; deltas[i] = credits[i]! - credits[i - 1]!;
        }
      }
      // Bound JSON scratch using disjoint evidence intervals, not endpoint
      // chunks. Global selection remains outside their timestamp bounds.
      let intervals: [number, number, number][] = [], range = 0;
      const consume = () => {
        const calls = statement.iterate(JSON.stringify(intervals)) as IterableIterator<CallTotal>;
        try { for (const [pair, aic, count] of calls) { aics[pair] = aic; unpriced[pair] = count; } }
        finally { calls.return?.(); }
        intervals = [];
      };
      for (let i = 1; i < length; i++) {
        while (range < ranges.length && ranges[range]![1] <= times[i - 1]!) range++;
        if (range < ranges.length && times[i - 1]! >= ranges[range]![0] && times[i]! <= ranges[range]![1] && spans[i]! > 0) {
          intervals.push([i, times[i - 1]!, times[i]!]);
          if (intervals.length === 512) consume();
        }
      }
      if (intervals.length) consume();
      const sums: Evidence = { span: 0, aic: 0, delta: 0, unpriced: 0 };
      for (const anchor of missing) {
        const first = lowerBound(times, times[anchor]! - 7 * DAY), last = anchor;
        // All paths add the same SQL interval sums from zero, in the same order.
        requested[anchor] = resultFor(times[anchor]!, sumEvidence(spans, aics, deltas, unpriced, first, last, sums));
      }
    }
    // MRU promotion in caller endpoint order. Request-local hits remain safe
    // even if an old miss would otherwise evict them before their promotion.
    let retained = anchors;
    if (anchors.length > 512) {
      const seen = new Set<number>(), tail: number[] = [];
      for (let i = anchors.length - 1; i >= 0 && tail.length < 512; i--) {
        const anchor = anchors[i]!;
        if (anchor >= 0 && !seen.has(anchor)) { seen.add(anchor); tail.push(anchor); }
      }
      retained = tail.reverse();
    }
    for (const anchor of retained) {
      if (anchor < 0) continue;
      const anchorKey = ids[anchor]!;
      cache.delete(anchorKey); cache.set(anchorKey, requested[anchor]!);
      if (cache.size > 512) cache.delete(cache.keys().next().value!);
    }
    // History owns its fits; clone only the bounded retained cache, not all fits.
    if (!copyResults) for (const [key, fit] of cache) cache.set(key, { ...fit });
    return { results: anchors.map(anchor => {
      if (anchor < 0) return calibrationFallback();
      const result = requested[anchor];
      if (!result) throw new Error("Missing calibration result for requested anchor");
      return copyResults ? { ...result } : result;
    }), highwater, points: ends };
  }
  return {
    current: mode => batch([MAX_TS], mode).results[0]!,
    at: (end, mode) => batch([end], mode).results[0]!,
    earliest(mode) {
      if (mode === "off") return calibrationFallback(mode);
      const highwater = (db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM counter_snapshots").get() as { n: number }).n;
      const revision = options.revision(), nextGeneration = `${revision}:${highwater}`;
      if (nextGeneration !== generation) { generation = nextGeneration; cache.clear(); }
      if (revision !== earliestRevision || highwater < earliestHighwater) earliestFit = undefined;
      else if (highwater !== earliestHighwater && earliestFit) {
        // D11 uses only consecutive pairs ending at/before the anchor, with
        // global call selection guarded by revision. Append-only rows strictly
        // after a fitted endpoint cannot change it or introduce an earlier fit.
        // Duplicate/backdated rows CAN change it; inspect only the new rowids.
        const changesEarlierWindow = earliestFit.status !== "calibrated" || db.prepare(
          "SELECT 1 FROM counter_snapshots WHERE rowid>? AND rowid<=? AND ts<=? LIMIT 1")
          .get(earliestHighwater, highwater, earliestFit.windowEnd);
        if (changesEarlierWindow) earliestFit = undefined;
      }
      earliestRevision = revision; earliestHighwater = highwater;
      if (!earliestFit) {
        const projection = `rowid AS id,ts,credits_used AS credits,account_login AS account,
          reset_date AS reset,entitlement,remaining`;
        const firstPage = db.prepare(`SELECT ${projection} FROM counter_snapshots INDEXED BY counter_snapshots_ts
          WHERE rowid<=? ORDER BY ts,rowid LIMIT 512`);
        const nextPage = db.prepare(`SELECT ${projection} FROM counter_snapshots INDEXED BY counter_snapshots_ts
          WHERE (ts,rowid)>(?,?) AND rowid<=? ORDER BY ts,rowid LIMIT 512`);
        // Same interval sums and rolling addition/subtraction order as the old
        // whole-history scan. Only a page plus trailing-seven-day evidence lives
        // in JS, and no calls after the first fitting page are aggregated.
        let calls: ReturnType<Db["prepare"]> | undefined;
        const window: { snapshot: Snapshot; evidence: Evidence }[] = [];
        const sums: Evidence = { span: 0, aic: 0, delta: 0, unpriced: 0 };
        let pending: Snapshot | undefined, cursor: Snapshot | undefined;
        const consume = (snapshots: Snapshot[]) => {
          const intervals: Evidence[] = [], ranges: [number, number, number][] = [];
          let previous = window.at(-1)?.snapshot;
          for (const [i, later] of snapshots.entries()) {
            const accepted = previous && acceptedPair(previous, later) && later.ts - previous.ts <= 7 * DAY;
            intervals.push({ span: accepted ? later.ts - previous!.ts : 0,
              delta: accepted ? later.credits - previous!.credits : 0, aic: 0, unpriced: 0 });
            if (accepted) ranges.push([i, previous!.ts, later.ts]);
            previous = later;
          }
          if (ranges.length) {
            calls ??= db.prepare(`WITH interval_calls AS MATERIALIZED (
              SELECT json_extract(span.value,'$[0]') AS pair,r.rowid AS callId
              FROM json_each(?) span CROSS JOIN calls r INDEXED BY calls_period_read
              WHERE r.ts>=json_extract(span.value,'$[1]') AND r.ts<json_extract(span.value,'$[2]')),
              counted AS MATERIALIZED (${countedUsageSql("c.rowid IN (SELECT callId FROM interval_calls)",
                "c.rowid AS callId,c.aic,c.price_status,c.run_id,c.is_report,c.source_file,c.source_kind", undefined, storedSelection(db))})
              SELECT i.pair,COALESCE(SUM(c.aic),0) AS aic,SUM(c.price_status='unpriced') AS unpriced
              FROM interval_calls i JOIN counted c USING(callId) GROUP BY i.pair ORDER BY i.pair`);
            for (const row of calls.all(JSON.stringify(ranges)) as { pair: number; aic: number; unpriced: number }[]) {
              intervals[row.pair]!.aic = row.aic; intervals[row.pair]!.unpriced = row.unpriced;
            }
          }
          let first = 0;
          for (const [i, anchor] of snapshots.entries()) {
            const added = intervals[i]!;
            window.push({ snapshot: anchor, evidence: added });
            sums.span += added.span; sums.aic += added.aic; sums.delta += added.delta; sums.unpriced += added.unpriced;
            while (first < window.length - 1 && window[first]!.snapshot.ts < anchor.ts - 7 * DAY) {
              const removed = window[++first]!.evidence;
              sums.span -= removed.span; sums.aic -= removed.aic; sums.delta -= removed.delta; sums.unpriced -= removed.unpriced;
            }
            if (!validSnapshot(anchor)) continue;
            const fit = resultFor(anchor.ts, sums);
            if (fit.status === "calibrated") { earliestFit = fit; break; }
          }
          if (first) window.splice(0, first);
        };
        while (!earliestFit) {
          const rows = (cursor ? nextPage.all(cursor.ts, cursor.id, highwater) : firstPage.all(highwater)) as Snapshot[];
          const snapshots: Snapshot[] = [];
          for (const row of rows) {
            if (pending && pending.ts !== row.ts) { snapshots.push(pending); pending = undefined; }
            // Keep timestamp groups intact across pages, including duplicate
            // validity precedence. Never bridge an invalid observation.
            if (!pending || validSnapshot(row) || !validSnapshot(pending)) pending = row;
          }
          if (rows.length < 512 && pending) { snapshots.push(pending); pending = undefined; }
          consume(snapshots);
          if (rows.length < 512) break;
          cursor = rows.at(-1)!;
        }
        earliestFit ??= calibrationFallback();
      }
      return { ...earliestFit };
    },
    atMany: (ends, mode) => batch(ends, mode).results,
    windows(period, mode) {
      if (!safeTimestamp(period.start) || !safeTimestamp(period.end) || period.end < period.start || period.end - period.start > 366 * DAY) invalidQuery();
      if (mode === "off") return [{ from: period.start, calibration: calibrationFallback(mode) }];
      // Read the period plus its trailing evidence, and the initial anchor's
      // evidence separately if stale. Never scan the gap to a years-old anchor.
      const projection = `s.rowid AS id,s.ts,s.credits_used AS credits,s.account_login AS account,s.reset_date AS reset,
        CASE WHEN s.ts BETWEEN 0 AND 8640000000000000 AND s.ts=CAST(s.ts AS INTEGER)
          AND s.credits_used BETWEEN 0 AND 1.7976931348623157e308
          AND (s.entitlement IS NULL OR s.entitlement BETWEEN 0 AND 1.7976931348623157e308)
          AND (s.remaining IS NULL OR s.remaining BETWEEN 0 AND 1.7976931348623157e308) THEN 1 ELSE 0 END AS valid,cap.highwater`;
      // Two disjoint ordered index ranges merge without a year-sized DISTINCT
      // or sort buffer. The anchor arm never scans the gap to a stale anchor.
      const statement = db.prepare(`WITH cap AS MATERIALIZED (SELECT COALESCE(MAX(rowid),0) AS highwater FROM counter_snapshots),
        anchor AS MATERIALIZED (SELECT ts FROM counter_snapshots INDEXED BY counter_snapshots_ts CROSS JOIN cap
          WHERE ts<=?1 AND rowid<=cap.highwater AND ts BETWEEN 0 AND 8640000000000000 AND ts=CAST(ts AS INTEGER)
            AND credits_used BETWEEN 0 AND 1.7976931348623157e308
            AND (entitlement IS NULL OR entitlement BETWEEN 0 AND 1.7976931348623157e308)
            AND (remaining IS NULL OR remaining BETWEEN 0 AND 1.7976931348623157e308)
          ORDER BY ts DESC,rowid DESC LIMIT 1)
        SELECT ${projection} FROM counter_snapshots s INDEXED BY counter_snapshots_ts CROSS JOIN cap
          WHERE s.ts>=MAX(0,(SELECT ts FROM anchor)-?2) AND s.ts<MAX(0,?1-?2)
            AND s.ts<=(SELECT ts FROM anchor) AND s.rowid<=cap.highwater
        UNION ALL SELECT ${projection} FROM counter_snapshots s INDEXED BY counter_snapshots_ts CROSS JOIN cap
          WHERE s.ts>=MAX(0,?1-?2) AND s.ts<=?3 AND s.rowid<=cap.highwater
        ORDER BY ts,id`);
      // Native named-row objects have large per-row overhead. Stream tuples into
      // static-shape objects: memory is bounded by observations, not call count.
      const tuples = statement.raw().iterate({ 1: period.start, 2: 7 * DAY, 3: period.end }) as
        IterableIterator<[number, number, number, string | null, string | null, number, number]>;
      const { results, points } = resolve([], tuples, false, period.start);
      return points.map((from, i) => ({ from, calibration: results[i]! }));
    },
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
