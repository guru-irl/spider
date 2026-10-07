import type { RatesData } from "../query-rates.js";
import type { CalibrationResult } from "../dashboard-contract.js";
import type { ViewContext, MountedView } from "./views.js";
import { element } from "./dom.js";
import { chartWithTable } from "./charts.js";
import { dateField, periodTimes, calibrationText, formatAicDisplay, formatTokens, tokenList, tokenCell, formatCalibration, formatCalibrationFactor, formatCalibrationEvidence } from "./format.js";
import { analysisEvidence, analysisParams, analysisTable, mountAnalysis, analysisProse } from "./analysis-shared.js";

const price = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 15 });
const windowLabel = (document: Document, fit: CalibrationResult) => fit.windowStart === null || fit.windowEnd === null ? "Evidence window unavailable" : periodTimes(document, fit.windowStart, fit.windowEnd);
function renderRates(ctx: ViewContext, data: RatesData): { panels: HTMLElement[] } {
  const { document } = ctx, root = element(document, "div", undefined, "overview-evidence");
  root.append(element(document, "p", "Loaded metadata describes the published rate catalogue. Stored call amounts and rate versions are immutable and are not repriced when metadata changes. All AIC amounts are approximate.", "muted"));
  const display = formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, data.periodCalibration);
  root.append(analysisProse(ctx, calibrationText(document, data.periodCalibration, data.totals.aicDisplay.basis, "Selected-period calibration: "), "calibration-evidence"),
    analysisProse(ctx, calibrationText(document, data.calibration, undefined, "Current calibration: "), "calibration-evidence"));
  root.append(analysisTable(ctx, "Selected stored usage", ["Observation", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"], [
    ["Selected period", display.primary, display.secondary, tokenList(document, data.totals.tokens), analysisEvidence(data.totals)],
  ]));
  root.append(element(document, "p", `Stored rate versions: ${data.storedRateVersions.join(", ") || "none recorded"}${data.storedRateVersionsTruncated ? ". Stored version list truncated." : "."}`, "muted"));
  root.append(analysisTable(ctx, "Loaded rate versions", ["Version", "Effective from", "Source as of", "Confidence", "Source"], data.versions.map(version => [version.id, dateField(document, version.effectiveFrom), dateField(document, version.sourceAsOf), version.confidence, version.source])));
  root.append(element(document, "p", "Tier thresholds apply to prompt tokens (input + cache read + cache write). Rates below are USD per million tokens. Valid-until dates are exclusive; unavailable means no recorded end date.", "muted"));
  root.append(analysisTable(ctx, "Loaded rate tiers", ["Model", "Aliases", "Version", "Valid until (exclusive)", "Tier", "Above prompt tokens", "Input USD / million", "Cache read USD / million", "Cache write USD / million", "Output USD / million"], data.rates.rows.map(row => [
    row.model, row.aliases.join(", ") || "none", row.version, row.validUntil === null ? "unavailable" : dateField(document, row.validUntil), row.tier, `${formatTokens(row.abovePromptTokens)} prompt tokens`,
    ...(["input", "cacheRead", "cacheWrite", "output"] as const).map(component => `$${price.format(row.usdPerMillion[component])}`),
  ])));
  root.append(analysisTable(ctx, "Unpriced evidence", ["Provider", "Model", "Reason", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"], data.unpricedModels.rows.map(row => {
    const aic = formatAicDisplay(row.measure.aicDisplay, row.measure.unpricedCalls, data.periodCalibration);
    return [row.provider ?? "Unknown", row.model === "unknown-model" ? "Unknown model" : row.model ?? "Unknown", row.reason === "unknown-model" ? "Unknown model" : row.reason === "no-rate-at-time" ? "No rate at call time" : row.reason, aic.primary, aic.secondary, tokenCell(document, row.measure.tokens), analysisEvidence(row.measure)];
  })));
  if (!data.factorHistoryEnabled) root.append(element(document, "p", "Factor history disabled: calibration is off. Published amounts and rate metadata remain available.", "muted"));
  else {
    root.append(element(document, "p", "Daily trailing factors use each day's own anchor and evidence window. Unavailable and implausible factors are not plotted as zero or applied corrections. Calibration does not prove exact billing or completeness.", "muted"));
    root.append(analysisTable(ctx, "Daily calibration evidence", ["UTC day", "Status", "Factor", "UTC evidence window", "Evidence"], data.factorHistory.rows.map(point => [dateField(document, new Date(point.day).toISOString().slice(0, 10)), point.calibration.status, formatCalibrationFactor(point.calibration), windowLabel(document, point.calibration), formatCalibrationEvidence(point.calibration)])));
    root.append(chartWithTable(document, { view: "rates", section: "daily-factor", title: "Daily trailing calibration factor", unit: "ratio", points: data.factorHistory.rows.map(point => ({
      start: point.day, end: point.day + 86400000, label: new Date(point.day).toISOString().slice(0, 10), labelDate: "day", value: point.calibration.status === "calibrated" ? point.calibration.factor : null, tokens: null,
      note: calibrationText(document, point.calibration),
    })) }));
  }
  return { panels: [root] };
}
export function mountRates(ctx: ViewContext): Promise<MountedView> {
  return mountAnalysis<RatesData>(ctx, { title: "Rates", path: "/api/rates", params: () => analysisParams(ctx), render: data => renderRates(ctx, data),
    pages: [{ title: "Rates, unpriced evidence and calibration", param: "cursor", next: data => data.nextCursor }] });
}
