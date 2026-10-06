import type { TokenTotals, AicDisplay, CalibrationResult } from "../dashboard-contract.js";
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export function formatTokens(value: number): string { return Number.isFinite(value) ? integer.format(value) : "unavailable"; }
export function formatEstimatedAic(value: number | null, unpricedCalls: number): string {
  if (value === null) return unpricedCalls > 0 ? "unpriced AIC" : "AIC unavailable";
  return `~${formatTokens(value)}${unpricedCalls > 0 ? "+" : ""} AIC published estimate`;
}
export function formatAicDisplay(display: AicDisplay, unpricedCalls: number, calibration: CalibrationResult): { primary: string; secondary: string; legend: string } {
  const calibrated = display.basis !== "published";
  const label = display.basis === "back-applied" ? "calibrated, back-applied" : "calibrated";
  const value = display.primaryAic;
  const primary = value === null ? (unpricedCalls > 0 ? "unpriced AIC" : "AIC unavailable")
    : `${calibrated ? "" : "~"}${formatTokens(value)}${unpricedCalls > 0 ? "+" : ""} AIC ${calibrated ? display.basis === "back-applied" ? label : "cal" : calibration.status === "off" ? "est" : "?"}`;
  const hasWindow = calibration.windowStart !== null && calibration.windowEnd !== null;
  const window = hasWindow ? `${new Date(calibration.windowStart!).toISOString()} to ${new Date(calibration.windowEnd!).toISOString()} UTC` : "UTC window unavailable";
  const days = hasWindow ? decimal.format((calibration.windowEnd! - calibration.windowStart!) / 86400000) : "unavailable";
  const summary = calibrated
    ? `${label} x${calibration.factor === null ? "unavailable" : decimal.format(calibration.factor)} over ${days} days`
    : calibration.status === "off" ? "Calibration off. Published estimate."
    : calibration.status === "calibrated" ? "Published estimate. Row is not calibrated."
    : `Calibration unavailable (${calibration.status}). Published estimate.${calibration.status === "implausible" ? ` Diagnostic x${calibration.factor === null ? "unavailable" : calibration.factor.toFixed(2)} (clamped, not applied)` : ""}`;
  const evidence = `${window} · ${decimal.format(calibration.coveredHours)} h covered · computed ~${formatTokens(calibration.computedAic)} AIC · counter delta ${formatTokens(calibration.counterDelta)} AIC · ${formatTokens(calibration.unpricedCalls)} unpriced calls · ${calibration.method}`;
  return { primary, secondary: formatEstimatedAic(display.publishedAic, unpricedCalls), legend: `${summary} · ${evidence}` };
}
export function tokenObservation(tokens: TokenTotals | null, subsets: "listed" | "recorded" = "listed"): string {
  if (!tokens) return "tokens unavailable";
  const observations = [`input ${formatTokens(tokens.input)}`, `cache read ${formatTokens(tokens.cacheRead)}`, `cache write ${formatTokens(tokens.cacheWrite)}`, `output ${formatTokens(tokens.output)}`, `prompt ${formatTokens(tokens.prompt)}`, `total ${formatTokens(tokens.total)}`];
  for (const [label, value] of [["cache write 1h", tokens.cacheWrite1h], ["reasoning", tokens.reasoning]] as const) {
    if (subsets === "listed" || value !== null) observations.push(`${label} ${value === null ? "unavailable" : formatTokens(value)}`);
  }
  return observations.join("; ");
}
