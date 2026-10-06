import type { CalibrationResult, DashboardQueryContext, Page, Period, UsageMeasure } from "./dashboard-contract.js";
import { storedSelection, countedUsageSql } from "./schema.js";
import { compileSlice, DAY_MS, decodeCursor, encodeCursor, invalidQuery, measureSelectionProjection, measureColumns, validatePage, safeTimestamp, type MeasureRow } from "./dashboard-selection.js";
import { analysisFits, analysisMeasure } from "./query-cache.js";
import { emptyMeasureRow } from "./query-overview.js";

type PairStatus = "compared" | "missing-anchor" | "reset" | "account-change" | "clock" | "counter-decrease" | "invalid-counter";
export type ReconciliationRow = Period & {
  bucketStart: number; bucketEnd: number; coverage: number; coveredMs: number; resetAnchors: number;
  exclusions: Partial<Record<Exclude<PairStatus, "compared">, number>>;
  counterStart: number | null; counterEnd: number | null;
  status: PairStatus | "partial" | "no-snapshot";
  counterAic: number | null; computed: UsageMeasure | null; gap: number | null; ratio: number | null;
  calibratedAic: number | null; calibratedGap: number | null; calibratedRatio: number | null;
  ratioReason: "no-local-calls" | "ingest-pending" | null; calibration: CalibrationResult;
};
export type ReconciliationData = { periods: Page<ReconciliationRow>; counterGranularityAic: 1; billingLagCaveat: "billing-lag-minutes"; caveats: readonly string[] };
type Anchor = { id: number; ts: number; credits: number; account: string | null; reset: string | null; entitlement: number | null; remaining: number | null };
type Pair = { key: number; bucket: number; start: number; end: number; earlier: Anchor | null; later: Anchor; status: PairStatus; resetAnchor: boolean };
function pairStatus(earlier: Anchor | null, later: Anchor): PairStatus {
  if (!earlier) return "missing-anchor";
  if ([earlier, later].some(row => !safeTimestamp(row.ts) || !Number.isFinite(row.credits) || row.credits < 0 ||
    [row.entitlement, row.remaining].some(value => value !== null && (!Number.isFinite(value) || value < 0)))) return "invalid-counter";
  if (later.ts < earlier.ts || later.id <= earlier.id) return "clock";
  if (later.account !== earlier.account) return "account-change";
  if (!sameResetDate(earlier.reset, later.reset)) return "reset";
  if (later.credits < earlier.credits) return "counter-decrease";
  return "compared";
}
// GitHub stores the NEXT reset date. Normalize that calendar date to midnight UTC.
function resetInstant(value: string | null): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return NaN;
  const date = value.slice(0, 10), instant = Date.parse(`${date}T00:00:00Z`);
  return safeTimestamp(instant) && new Date(instant).toISOString().slice(0, 10) === date ? instant : NaN;
}
function sameResetDate(earlier: string | null, later: string | null): boolean {
  const a = resetInstant(earlier), b = resetInstant(later);
  return Number.isFinite(a) && Number.isFinite(b) ? a === b : earlier === later;
}
// Mirror calibration's highest-valid duplicate rule, retaining invalid-only gaps.
const validSnapshotSql = (alias: string) => `${alias}.ts BETWEEN 0 AND 8640000000000000 AND ${alias}.ts=CAST(${alias}.ts AS INTEGER)
  AND ${alias}.credits_used BETWEEN 0 AND 1.7976931348623157e308
  AND (${alias}.entitlement IS NULL OR ${alias}.entitlement BETWEEN 0 AND 1.7976931348623157e308)
  AND (${alias}.remaining IS NULL OR ${alias}.remaining BETWEEN 0 AND 1.7976931348623157e308)`;
const anchorProjection = "s.rowid AS id,s.ts,s.credits_used AS credits,s.account_login AS account,s.reset_date AS reset,s.entitlement,s.remaining";
const caveats = ["The counter is account-wide and includes other clients.", "The counter moves in whole AIC with a billing lag of minutes.",
  "Published and calibrated AIC are approximate. Gaps can reflect lag, quantization, unpriced calls, incomplete evidence and other clients.",
  "A counter rise with no local calls can indicate usage from other clients; its ratio is unavailable."];
export function queryReconciliation(ctx: DashboardQueryContext, period: Period, options: { bucket: "day" | "month" | "snapshot"; limit: number; cursor?: string }): ReconciliationData {
  compileSlice({ ...period, filters: [] }); validatePage(options);
  if (!["day", "month", "snapshot"].includes(options.bucket)) invalidQuery();
  const query = { period, bucket: options.bucket, limit: options.limit };
  let frozen: number | undefined, after = period.start;
  if (options.cursor) {
    const key = decodeCursor(options.cursor, "reconciliation", ctx.revision, query);
    if (key.length !== 3 || key.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) || !safeTimestamp(key[1] as number) ||
      (key[1] as number) < period.start || (key[1] as number) >= period.end) invalidQuery();
    [frozen, after] = key as [number, number, number];
  }
  frozen ??= (ctx.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM counter_snapshots").get() as { n: number }).n;
  const buckets: Period[] = [];
  if (options.bucket !== "snapshot") {
    for (let start = after; start < period.end && buckets.length < options.limit; ) {
      const date = new Date(start);
      const next = options.bucket === "day" ? (Math.floor(start / DAY_MS) + 1) * DAY_MS : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      const end = Math.min(next, period.end); buckets.push({ start, end }); start = end;
    }
  }
  // Each endpoint retrieves its bounded predecessor. Bucket intervals are (start,end],
  // so an exact-midnight endpoint finishes the preceding day; call spans are [start,end).
  const predecessor = `(SELECT json_object('id',p.rowid,'ts',p.ts,'credits',p.credits_used,'account',p.account_login,'reset',p.reset_date,'entitlement',p.entitlement,'remaining',p.remaining) FROM counter_snapshots p INDEXED BY counter_snapshots_ts
    WHERE p.ts>=MAX(0,s.ts-${366 * DAY_MS}) AND p.ts<s.ts AND p.rowid<=? ORDER BY p.ts DESC,CASE WHEN ${validSnapshotSql("p")} THEN 1 ELSE 0 END DESC,p.rowid DESC LIMIT 1)`;
  // Equal timestamps are duplicate writes, not backwards clocks. Canonicalize both
  // endpoints to the highest valid rowid within the frozen snapshot before pairing.
  const latestWrite = `s.rowid=(SELECT d.rowid FROM counter_snapshots d INDEXED BY counter_snapshots_ts WHERE d.ts=s.ts AND d.rowid<=? ORDER BY CASE WHEN ${validSnapshotSql("d")} THEN 1 ELSE 0 END DESC,d.rowid DESC LIMIT 1)`;
  type Observation = Anchor & { bucket: number; earlierJson: string | null };
  const observed = options.bucket === "snapshot" ? ctx.db.prepare(`SELECT ${anchorProjection},0 AS bucket,${predecessor} AS earlierJson
    FROM counter_snapshots s INDEXED BY counter_snapshots_ts
    WHERE s.ts>? AND s.ts<=? AND s.rowid<=? AND ${latestWrite} ORDER BY s.ts,s.rowid LIMIT ?`)
    .all(frozen, after, period.end, frozen, frozen, options.limit + 1) as Observation[] :
    ctx.db.prepare(`WITH buckets AS MATERIALIZED (SELECT CAST(j.key AS INTEGER) AS bucket,json_extract(j.value,'$.start') AS start,json_extract(j.value,'$.end') AS end FROM json_each(?) j)
      SELECT ${anchorProjection},b.bucket,${predecessor} AS earlierJson FROM buckets b CROSS JOIN counter_snapshots s INDEXED BY counter_snapshots_ts
      WHERE s.ts>b.start AND s.ts<=b.end AND s.rowid<=? AND ${latestWrite} ORDER BY b.bucket,s.ts,s.rowid`)
      .all(JSON.stringify(buckets), frozen, frozen, frozen) as Observation[];
  const page = options.bucket === "snapshot" ? observed.slice(0, options.limit) : observed;
  const pairs: Pair[] = page.map((later, key) => {
    let earlier = later.earlierJson ? JSON.parse(later.earlierJson) as Anchor : null;
    let status = pairStatus(earlier, later), resetAnchor = false;
    if (status === "reset" || status === "counter-decrease") {
      const resetAt = resetInstant(earlier!.reset), nextResetAt = resetInstant(later.reset);
      const date = new Date(resetAt);
      const targetLastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0)).getUTCDate();
      const oneCycleLater = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, Math.min(date.getUTCDate(), targetLastDay));
      // A changed date requires exactly one clamped cycle. An unchanged date with
      // a counter drop can observe that same reset when billing metadata lags.
      if (resetAt >= earlier!.ts && resetAt <= later.ts &&
        (status === "counter-decrease" || nextResetAt === oneCycleLater)) {
        earlier = { ...earlier!, ts: resetAt, credits: 0, reset: later.reset };
        status = "compared"; resetAnchor = true;
      }
    }
    return { key, bucket: options.bucket === "snapshot" ? key : later.bucket, start: earlier?.ts ?? later.ts, end: later.ts, earlier, later, status, resetAnchor };
  });
  const ranges = pairs.filter(pair => pair.status === "compared" && pair.end > pair.start).map(pair => [pair.key, pair.start, pair.end]);
  const measures = ranges.length ? ctx.db.prepare(`WITH interval_calls AS MATERIALIZED (
    SELECT json_extract(span.value,'$[0]') AS pair,r.rowid AS callId FROM json_each(?) span CROSS JOIN calls r INDEXED BY calls_period_read
    WHERE r.ts>=json_extract(span.value,'$[1]') AND r.ts<json_extract(span.value,'$[2]')),
    counted AS MATERIALIZED (${countedUsageSql("c.rowid IN (SELECT callId FROM interval_calls)", `${measureSelectionProjection},c.rowid AS callId`, undefined, storedSelection(ctx.db))})
    SELECT i.pair,${measureColumns} FROM interval_calls i JOIN counted c USING(callId) GROUP BY i.pair`)
    .all(JSON.stringify(ranges)) as (MeasureRow & { pair: number })[] : [];
  const pending = Boolean((ctx.db.prepare(`SELECT EXISTS (SELECT 1 FROM import_state WHERE offset<size)
    OR EXISTS (SELECT 1 FROM pending_reports) AS pending`).get() as { pending: number }).pending);
  const measureByPair = new Map(measures.map(row => [row.pair, row]));
  const groups = options.bucket === "snapshot" ? pairs.map(pair => ({ bounds: { start: pair.start, end: pair.end }, pairs: [pair] })) :
    buckets.map((bounds, bucket) => ({ bounds, pairs: pairs.filter(pair => pair.bucket === bucket) }));
  // One exact endpoint batch for pair fits and empty/excluded bucket row metadata.
  const ends = [...pairs.map(pair => pair.end), ...groups.map(group => group.pairs.at(-1)?.end ?? group.bounds.end)];
  const fits = analysisFits(ctx, ends);
  const output: ReconciliationRow[] = groups.map(({ bounds, pairs: evidence }, index) => {
    const accepted = evidence.filter(pair => pair.status === "compared");
    const exclusions: ReconciliationRow["exclusions"] = {};
    for (const pair of evidence) if (pair.status !== "compared") exclusions[pair.status] = (exclusions[pair.status] ?? 0) + 1;
    const coveredMs = accepted.reduce((sum, pair) => sum + Math.max(0, Math.min(pair.end, bounds.end) - Math.max(pair.start, bounds.start)), 0);
    const coverage = bounds.end > bounds.start ? Math.min(1, coveredMs / (bounds.end - bounds.start)) : 0;
    const fit = fits[pairs.length + index]!;
    const first = accepted[0], last = accepted.at(-1);
    const start = first?.start ?? (options.bucket === "snapshot" ? evidence[0]!.start : bounds.start);
    const end = last?.end ?? (options.bucket === "snapshot" ? evidence[0]!.end : bounds.end);
    let computed: UsageMeasure | null = null, calibratedAic: number | null = null;
    if (accepted.length) {
      const sum: MeasureRow = { ...emptyMeasureRow, pendingData: Number(pending), possibleUndercount: Number(pending) };
      let primary = 0, calibrated = 0, publishedPrimary = true, backApplied = false, allCalibrated = true;
      for (const pair of accepted) {
        const row = measureByPair.get(pair.key) ?? emptyMeasureRow, pairFit = fits[pair.key]!;
        for (const field of Object.keys(emptyMeasureRow) as (keyof MeasureRow)[]) {
          const value = row[field];
          if (field === "pendingData" || field === "possibleUndercount" || field === "possibleOverlap") sum[field] = Number(Boolean(sum[field] || value));
          else if (value != null) sum[field] = (sum[field] ?? 0) + value;
        }
        const display = analysisMeasure(ctx, row, pairFit).aicDisplay;
        primary += display.primaryAic ?? 0;
        publishedPrimary &&= display.basis === "published";
        backApplied ||= display.basis === "back-applied";
        allCalibrated &&= pairFit.calibration.status === "calibrated";
        calibrated += display.primaryAic ?? 0;
      }
      if (sum.calls === 0 && !pending) sum.aic = 0;
      computed = analysisMeasure(ctx, sum, fit);
      computed.aicDisplay.primaryAic = computed.aic === null ? null : primary;
      computed.aicDisplay.basis = publishedPrimary ? "published" : backApplied ? "back-applied" : "calibrated";
      calibratedAic = computed.calls === 0 ? pending ? null : 0 : allCalibrated && computed.aic !== null ? calibrated : null;
    }
    const counterAic = accepted.length ? accepted.reduce((sum, pair) => sum + pair.later.credits - pair.earlier!.credits, 0) : null;
    const status: ReconciliationRow["status"] = !evidence.length ? "no-snapshot" : accepted.length ?
      options.bucket === "snapshot" || (coverage === 1 && Object.keys(exclusions).length === 0) ? "compared" : "partial" : (evidence.find(pair => pair.status !== "reset") ?? evidence[0])!.status;
    return { start, end, bucketStart: bounds.start, bucketEnd: bounds.end, coveredMs, coverage, resetAnchors: accepted.filter(pair => pair.resetAnchor).length, exclusions,
      counterStart: first?.start ?? null, counterEnd: last?.end ?? null, status, counterAic, computed,
      gap: counterAic !== null && computed?.aic != null ? counterAic - computed.aic : null,
      ratio: counterAic !== null && counterAic > 0 && computed?.calls && computed.aic != null ? computed.aic / counterAic : null,
      ratioReason: computed?.calls === 0 ? pending ? "ingest-pending" : "no-local-calls" : null,
      calibratedAic, calibratedGap: counterAic !== null && calibratedAic !== null ? counterAic - calibratedAic : null,
      calibratedRatio: counterAic !== null && counterAic > 0 && computed?.calls && calibratedAic !== null ? calibratedAic / counterAic : null,
      calibration: fit.calibration };
  });
  const more = options.bucket === "snapshot" ? observed.length > options.limit : Boolean(buckets.length && buckets.at(-1)!.end < period.end);
  const cursorFor = (length: number) => {
    if (!length || (!more && length === output.length)) return null;
    const position = options.bucket === "snapshot" ? [page[length - 1]!.ts, page[length - 1]!.id] : [buckets[length - 1]!.end, 0];
    return encodeCursor("reconciliation", ctx.revision, query, [frozen, ...position]);
  };
  let length = output.length;
  for (;;) {
    const data: ReconciliationData = { periods: { rows: output.slice(0, length), nextCursor: cursorFor(length) }, counterGranularityAic: 1, billingLagCaveat: "billing-lag-minutes", caveats };
    // Reserve the same envelope space as Task 6. Each row is independently bounded.
    if (Buffer.byteLength(JSON.stringify(data)) <= 256 * 1024 - 512) return data;
    length--;
  }
}
