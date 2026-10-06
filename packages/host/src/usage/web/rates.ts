import type { RatesData } from "../query-rates.js";
import type { CalibrationResult } from "../dashboard-contract.js";
import type { ViewContext, MountedView } from "./views.js";
import { element } from "./dom.js";
import { chartWithTable } from "./charts.js";
import { formatAicDisplay, formatTokens, tokenObservation } from "./format.js";
import { analysisEvidence, analysisNumber, analysisParams, analysisTable, mountAnalysis, counted, analysisProse } from "./analysis-shared.js";

const price = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 15 });
const windowLabel = (fit: CalibrationResult) => fit.windowStart === null || fit.windowEnd === null ? "Evidence window unavailable" : `${new Date(fit.windowStart).toISOString()} to ${new Date(fit.windowEnd).toISOString()} UTC`;
function factorLabel(fit: CalibrationResult): string {
  if (fit.factor === null) return "unavailable";
  return `x${analysisNumber(fit.factor)}${fit.status === "calibrated" ? "" : " diagnostic only (not applied)"}`;
}
function fitEvidence(fit: CalibrationResult): string {
  if (fit.status === "off") return "not calibrated (off)";
  return `${analysisNumber(fit.coveredHours)} h covered; computed ~${analysisNumber(fit.computedAic)} AIC; counter delta ${analysisNumber(fit.counterDelta)} AIC; ${counted(fit.unpricedCalls, "unpriced call")}; ${fit.method === "trailing-7d-ratio" ? "Trailing 7-day ratio" : "Not calibrated (off)"}`;
}
function renderRates(ctx: ViewContext, data: RatesData): { panels: HTMLElement[] } {
  const { document } = ctx, root = element(document, "div", undefined, "overview-evidence");
  root.append(element(document, "p", "Loaded metadata describes the published rate catalogue. Stored call amounts and rate versions are immutable and are not repriced when metadata changes. All AIC amounts are approximate.", "muted"));
  const display = formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, data.periodCalibration);
  root.append(analysisProse(ctx, `Selected-period calibration: ${data.periodCalibration.status === "off" ? "not calibrated (off). Published estimate." : display.legend}`, "calibration-evidence"),
    analysisProse(ctx, data.calibration.status === "off" ? "Current calibration: not calibrated (off)" : `Current calibration: ${data.calibration.status}; ${factorLabel(data.calibration)}; ${windowLabel(data.calibration)}; ${fitEvidence(data.calibration)}`, "calibration-evidence"));
  root.append(analysisTable(ctx, "Selected stored usage", ["Observation", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"], [
    ["Selected period", display.primary, display.secondary, tokenObservation(data.totals.tokens), analysisEvidence(data.totals)],
  ]));
  root.append(element(document, "p", `Stored rate versions: ${data.storedRateVersions.join(", ") || "none recorded"}${data.storedRateVersionsTruncated ? ". Stored version list truncated." : "."}`, "muted"));
  root.append(analysisTable(ctx, "Loaded rate versions", ["Version", "Effective from", "Source as of", "Confidence", "Source"], data.versions.map(version => [version.id, version.effectiveFrom, version.sourceAsOf, version.confidence, version.source])));
  root.append(element(document, "p", "Tier thresholds apply to prompt tokens (input + cache read + cache write). Rates below are USD per million tokens. Valid-until dates are exclusive; unavailable means no recorded end date.", "muted"));
  root.append(analysisTable(ctx, "Loaded rate tiers", ["Model", "Aliases", "Version", "Valid until (exclusive)", "Tier", "Above prompt tokens", "Input USD / million", "Cache read USD / million", "Cache write USD / million", "Output USD / million"], data.rates.rows.map(row => [
    row.model, row.aliases.join(", ") || "none", row.version, row.validUntil ?? "unavailable", row.tier, `${formatTokens(row.abovePromptTokens)} prompt tokens`,
    ...(["input", "cacheRead", "cacheWrite", "output"] as const).map(component => `$${price.format(row.usdPerMillion[component])}`),
  ])));
  root.append(analysisTable(ctx, "Unpriced evidence", ["Provider", "Model", "Reason", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"], data.unpricedModels.rows.map(row => {
    const aic = formatAicDisplay(row.measure.aicDisplay, row.measure.unpricedCalls, data.periodCalibration);
    return [row.provider ?? "Unknown", row.model === "unknown-model" ? "Unknown model" : row.model ?? "Unknown", row.reason === "unknown-model" ? "Unknown model" : row.reason === "no-rate-at-time" ? "No rate at call time" : row.reason, aic.primary, aic.secondary, tokenObservation(row.measure.tokens), analysisEvidence(row.measure)];
  })));
  if (!data.factorHistoryEnabled) root.append(element(document, "p", "Factor history disabled: calibration is off. Published amounts and rate metadata remain available.", "muted"));
  else {
    root.append(element(document, "p", "Daily trailing factors use each day's own anchor and evidence window. Unavailable and implausible factors are not plotted as zero or applied corrections. Calibration does not prove exact billing or completeness.", "muted"));
    root.append(analysisTable(ctx, "Daily calibration evidence", ["UTC day", "Status", "Factor", "UTC evidence window", "Evidence"], data.factorHistory.rows.map(point => [new Date(point.day).toISOString().slice(0, 10), point.calibration.status, factorLabel(point.calibration), windowLabel(point.calibration), fitEvidence(point.calibration)])));
    root.append(chartWithTable(document, { title: "Daily trailing calibration factor", unit: "ratio", points: data.factorHistory.rows.map(point => ({
      start: point.day, end: point.day + 86400000, label: new Date(point.day).toISOString().slice(0, 10), value: point.calibration.status === "calibrated" ? point.calibration.factor : null, tokens: null,
      note: `${point.calibration.status}; ${factorLabel(point.calibration)}; ${windowLabel(point.calibration)}; ${fitEvidence(point.calibration)}`,
    })) }));
  }
  return { panels: [root] };
}
export function mountRates(ctx: ViewContext): Promise<MountedView> {
  return mountAnalysis<RatesData>(ctx, { title: "Rates", path: "/api/rates", params: () => analysisParams(ctx), render: data => renderRates(ctx, data),
    pages: [{ title: "Rates, unpriced evidence and calibration", param: "cursor", next: data => data.nextCursor }] });
}
