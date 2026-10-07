import type { ReconciliationData, ReconciliationRow } from "../query-reconciliation.js";
import type { ViewContext, MountedView } from "./views.js";
import { element } from "./dom.js";
import { periodTimes, formatPeriod, formatAicDisplay, formatEstimatedAic, formatAicAmount, formatRatio, tokenCell } from "./format.js";
import { analysisEvidence, analysisNumber, analysisParams, analysisPercent, analysisTable, mountAnalysis, counted, analysisProse, signedGap, gapChart } from "./analysis-shared.js";

const statuses: Record<ReconciliationRow["status"], string> = {
  compared: "Compared", partial: "Partial coverage", "no-snapshot": "No snapshot pair", reset: "Unobserved reset", clock: "Clock ordering anomaly",
  "account-change": "Account change", "missing-anchor": "Missing anchor", "counter-decrease": "Counter decreased", "invalid-counter": "Invalid counter",
};
const span = (document: Document, start: number | null, end: number | null, dayBucket = false) => start === null || end === null ? "unavailable" : periodTimes(document, start, end, dayBucket);
const gap = signedGap;
const ratioReasons = { "ingest-pending": "Ingest still catching up", "no-local-calls": "No local calls in this span; the counter may include other clients" };
const ratio = (value: number | null, reason: ReconciliationRow["ratioReason"]) => `${value === null ? "unavailable" : formatRatio(value)}${reason ? ` · ${ratioReasons[reason]}` : ""}`;

function renderReconciliation(ctx: ViewContext, data: ReconciliationData, bucket: "day" | "month" | "snapshot"): { panels: HTMLElement[] } {
  const { document } = ctx, root = element(document, "div", undefined, "overview-evidence");
  root.append(element(document, "p", "Account-wide comparison. Selected filters do not apply. Published gap = counter minus computed; ratio = computed divided by counter.", "muted"),
    element(document, "p", "Amounts use compatible snapshot-pair spans assigned to the bucket containing their end observation. Pairs are not prorated across calendar buckets. Coverage reports only the pair time inside each bucket, not completeness.", "muted"),
    analysisProse(ctx, `The counter moves in whole AIC (${analysisNumber(data.counterGranularityAic)} AIC). Billing lag is typically 3 to 5 minutes; short gaps can reflect lag and integer quantization, not a pricing error.`, "muted"));
  for (const caveat of data.caveats) root.append(element(document, "p", caveat, "muted"));
  const rows = data.periods.rows;
  root.append(analysisTable(ctx, "Published comparison", ["UTC bucket", "Matched endpoints UTC", "Status", "Account counter", "Published estimate", "Signed published gap", "Published ratio", "Tokens (subsets not additive)"], rows.map(row => [
    span(document, row.bucketStart, row.bucketEnd, bucket !== "snapshot"), span(document, row.counterStart, row.counterEnd), statuses[row.status],
    row.counterAic === null ? "unavailable" : `${analysisNumber(row.counterAic)} AIC counter`,
    row.computed === null ? "AIC unavailable" : formatEstimatedAic(row.computed.aicDisplay.publishedAic, row.computed.unpricedCalls), gap(row.gap), ratio(row.ratio, row.ratioReason), tokenCell(document, row.computed?.tokens ?? null),
  ])));
  root.append(analysisTable(ctx, "Calibrated comparison", ["UTC bucket", "Matched endpoints UTC", "Calibrated AIC (pair fits)", "Signed calibrated gap", "Calibrated ratio", "Calibration evidence", "Tokens (subsets not additive)"], rows.map(row => {
    const display = row.computed ? formatAicDisplay(row.computed.aicDisplay, row.computed.unpricedCalls, row.calibration) : null;
    return [span(document, row.bucketStart, row.bucketEnd, bucket !== "snapshot"), span(document, row.counterStart, row.counterEnd), row.calibratedAic === null ? "unavailable" : formatAicAmount(row.calibratedAic, row.computed?.unpricedCalls ?? 0, row.computed?.aicDisplay.basis === "back-applied" ? "back-applied" : "calibrated", row.calibration.status), gap(row.calibratedGap), ratio(row.calibratedRatio, row.ratioReason),
      `Period-end calibration: ${row.calibration.status}. ${display?.legend ?? "No computed comparison."} Bucket calibrated amounts sum each pair's fit, not a single bucket factor.`, tokenCell(document, row.computed?.tokens ?? null)];
  })));
  root.append(analysisTable(ctx, "Snapshot coverage", ["UTC bucket", "Status", "Coverage", "Covered time", "Reset evidence", "Excluded pairs", "Usage evidence"], rows.map(row => [
    span(document, row.bucketStart, row.bucketEnd, bucket !== "snapshot"), statuses[row.status], analysisPercent(row.coverage), `${analysisNumber(row.coveredMs / 3600000)} h covered`, `${counted(row.resetAnchors, "observed reset anchor")}`,
    Object.entries(row.exclusions).map(([status, count]) => `${statuses[status as ReconciliationRow["status"]]}: ${analysisNumber(count!)}`).join("; ") || "None",
    row.computed ? analysisEvidence(row.computed) : "No compatible computed evidence",
  ])));
  const charts = element(document, "div", undefined, "small-multiples");
  for (const basis of ["published", "calibrated", "back-applied"] as const) {
    const isCalibrated = basis !== "published";
    const points = isCalibrated ? rows.filter(row => row.computed?.aicDisplay.basis === basis) : rows;
    if (isCalibrated && !points.length) continue;
    const title = basis === "published" ? "Published gap" : basis === "calibrated" ? "Calibrated gap" : "Calibrated gap · calibrated, back-applied";
    charts.append(gapChart(ctx, title, points.map(row => ({
      start: bucket === "snapshot" ? row.counterStart ?? row.bucketStart : row.bucketStart, end: bucket === "snapshot" ? row.counterEnd ?? row.bucketEnd : row.bucketEnd, label: bucket === "snapshot" ? new Date(row.counterEnd ?? row.end).toISOString() : new Date(row.bucketStart).toISOString().slice(0, bucket === "month" ? 7 : 10), labelDate: bucket === "snapshot" ? "timestamp" : bucket, value: isCalibrated ? row.calibratedGap : row.gap, tokens: row.computed?.tokens ?? null,
      note: `${statuses[row.status]} · coverage ${analysisPercent(row.coverage)} · matched ${row.counterStart === null || row.counterEnd === null ? "unavailable" : formatPeriod(row.counterStart, row.counterEnd)} · signed gap ${gap(isCalibrated ? row.calibratedGap : row.gap)} · ${ratio(isCalibrated ? row.calibratedRatio : row.ratio, row.ratioReason)} · ${row.computed ? analysisEvidence(row.computed) : "No compatible evidence"}`,
    })), basis));
  }
  root.append(charts);
  return { panels: [root] };
}
export function mountReconciliation(ctx: ViewContext): Promise<MountedView> {
  let bucket: "day" | "month" | "snapshot" = "day";
  return mountAnalysis<ReconciliationData>(ctx, { title: "Reconciliation", path: "/api/reconciliation", params: () => { const params = analysisParams(ctx, false); params.set("bucket", bucket); return params; }, render: data => renderReconciliation(ctx, data, bucket),
    pages: [{ title: "Comparisons and snapshot coverage", param: "cursor", next: data => data.periods.nextCursor }],
    choices: [{ label: "Daily buckets", select() { bucket = "day"; } }, { label: "Monthly buckets", select() { bucket = "month"; } }, { label: "Snapshot pairs", select() { bucket = "snapshot"; } }] });
}
