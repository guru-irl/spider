import type { TokenTotals, AicDisplay, CalibrationResult } from "../dashboard-contract.js";
import { element } from "./dom.js";
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const countPlural = new Intl.PluralRules("en-US", { maximumFractionDigits: 0 });
export function formatCount(value: number, singular: string): string {
  return `${formatTokens(value)} ${countPlural.select(value) === "one" ? singular : `${singular}s`}`;
}
const keyLabels: Readonly<Record<string, string>> = {
  "trailing-7d-ratio": "trailing 7-day ratio",
  auxPurpose: "auxiliary purpose", repo: "repository", api: "API",
  ENOENT: "file or directory not found", EACCES: "permission denied",
  EPERM: "operation not permitted", EIO: "input/output error",
};
export function readableKey(key: string): string {
  return Object.hasOwn(keyLabels, key) ? keyLabels[key]! : key.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ").replace(/:\s*/g, ": ").toLowerCase()
    .replace(/\bdb\b/g, "database").replace(/\bsqlite\b/g, "SQLite");
}
export function aicKey(document: Document): HTMLElement {
  return element(document, "p", "cal means calibrated; ? means calibration unavailable; est means published estimate with calibration off.", "muted aic-key");
}
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
  return { primary, secondary: formatEstimatedAic(display.publishedAic, unpricedCalls), legend: formatCalibration(calibration, display.basis) };
}
/** Factor wording is shared by daily columns and calibration summaries. */
export function formatCalibrationFactor(calibration: CalibrationResult): string {
  if (calibration.factor === null) return "unavailable";
  return calibration.status === "implausible" ? `Diagnostic x${calibration.factor.toFixed(2)} (clamped, not applied)` : `x${decimal.format(calibration.factor)}`;
}
/** Evidence only, without the separately displayed status, factor or window. */
export function formatCalibrationEvidence(calibration: CalibrationResult): string {
  return `${decimal.format(calibration.coveredHours)} h covered · computed ~${formatTokens(calibration.computedAic)} AIC · counter delta ${formatTokens(calibration.counterDelta)} AIC · ${formatCount(calibration.unpricedCalls, "unpriced call")} · ${readableKey(calibration.method)}`;
}
/** Shared calibration wording for legends, Rates summaries and daily evidence. */
export function formatCalibration(calibration: CalibrationResult, basis: AicDisplay["basis"] = calibration.status === "calibrated" ? "calibrated" : "published"): string {
  const calibrated = basis !== "published";
  const label = basis === "back-applied" ? "calibrated, back-applied" : "calibrated";
  const hasWindow = calibration.windowStart !== null && calibration.windowEnd !== null;
  const window = hasWindow ? `${new Date(calibration.windowStart!).toISOString()} to ${new Date(calibration.windowEnd!).toISOString()} UTC` : "UTC window unavailable";
  const days = hasWindow ? decimal.format((calibration.windowEnd! - calibration.windowStart!) / 86400000) : "unavailable";
  const summary = calibrated
    ? `${label} x${calibration.factor === null ? "unavailable" : decimal.format(calibration.factor)} over ${days} ${days === "1" ? "day" : "days"}`
    : calibration.status === "off" ? "Calibration off. Published estimate."
    : calibration.status === "calibrated" ? "Published estimate. Row is not calibrated."
    : `Calibration unavailable (${calibration.status}). Published estimate.${calibration.status === "implausible" ? ` ${formatCalibrationFactor(calibration)}` : ""}`;
  const evidence = `${window} · ${formatCalibrationEvidence(calibration)}`;
  return calibration.status === "off" ? summary : `${summary} · ${evidence}`;
}

function tokenEntries(tokens: TokenTotals, subsets: "listed" | "recorded"): readonly (readonly [string, number | null])[] {
  const entries: [string, number | null][] = [["input", tokens.input], ["cache read", tokens.cacheRead], ["cache write", tokens.cacheWrite], ["output", tokens.output], ["prompt", tokens.prompt], ["total", tokens.total]];
  for (const entry of [["cache write 1h", tokens.cacheWrite1h], ["reasoning", tokens.reasoning]] as const) {
    if (subsets === "listed" || entry[1] !== null) entries.push([...entry]);
  }
  return entries;
}
export function tokenObservation(tokens: TokenTotals | null, subsets: "listed" | "recorded" = "listed"): string {
  return tokens ? tokenEntries(tokens, subsets).map(([label, value]) => `${label} ${value === null ? "unavailable" : formatTokens(value)}`).join("; ") : "tokens unavailable";
}
export function tokenList(document: Document, tokens: TokenTotals | null, subsets: "listed" | "recorded" = "listed"): HTMLElement {
  if (!tokens) return element(document, "span", "tokens unavailable");
  const list = element(document, "dl", undefined, "token-list"), entries = tokenEntries(tokens, subsets);
  entries.forEach(([label, value], index) => {
    const term = element(document, "dt", `${label} `), description = element(document, "dd");
    description.append(element(document, "span", value === null ? "unavailable" : formatTokens(value), value === null ? undefined : "numeric"));
    if (index < entries.length - 1) {
      const separator = element(document, "span", "; ", "token-separator"); separator.setAttribute("aria-hidden", "true"); description.append(separator);
    }
    list.append(term, description);
  });
  return list;
}
/** Numeric values use the number face, never their units or explanatory copy. */
export function numericText(document: Document, text: string): HTMLElement {
  const root = element(document, "span"); let offset = 0;
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const start = match.index!, end = start + match[0].length;
    const before = text.slice(0, start), after = text.slice(end);
    // Do not split identifiers (synthetic-v1, model-5.1) or the method's 7-day label.
    if (/[A-Za-z0-9_.:-]$/.test(before) && !/(?:^|\s)[x-]$/.test(before) || /^[A-Za-z0-9_.:-]/.test(after)) continue;
    root.append(element(document, "span", text.slice(offset, start)), element(document, "span", match[0], "numeric")); offset = end;
  }
  root.append(element(document, "span", text.slice(offset))); return root;
}
/** One fragment policy for numeric legend/prose values and readable UTC windows. */
export function evidenceText(document: Document, text: string): HTMLElement {
  return datedText(document, text, fragment => numericText(document, fragment));
}
export function tokenSummary(document: Document, tokens: TokenTotals | null): HTMLElement {
  if (!tokens) return element(document, "span", "tokens unavailable");
  const summary = element(document, "span", undefined, "token-summary");
  summary.append(numericText(document, `prompt ${formatTokens(tokens.prompt)} · output ${formatTokens(tokens.output)} · total ${formatTokens(tokens.total)}`)); return summary;
}
const tableTokens = new WeakMap<HTMLElement, TokenTotals | null>();
/** Defer compact formatting until the receiving table knows its own columns. */
export function tokenCell(document: Document, tokens: TokenTotals | null, subsets: "listed" | "recorded" = "listed"): HTMLElement {
  const cell = tokenList(document, tokens, subsets); tableTokens.set(cell, tokens); return cell;
}
export function resolveTokenCell(document: Document, cell: HTMLElement, columnCount: number): HTMLElement {
  return columnCount > 6 && tableTokens.has(cell) ? tokenSummary(document, tableTokens.get(cell)!) : cell;
}

const utcDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const utcMinute = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const utcSecond = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const utcMillisecond = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23", timeZone: "UTC" });
export function formatUtcTimestamp(value: number, dateOnly = false, milliseconds = false): string {
  const date = new Date(value);
  if (dateOnly) return utcDate.format(date);
  const time = (milliseconds ? utcMillisecond : date.getUTCSeconds() ? utcSecond : utcMinute).format(date);
  return `${utcDate.format(date)}, ${time} UTC`;
}
export function utcTime(document: Document, value: number, dateOnly = false, milliseconds = false): HTMLElement {
  const time = element(document, "time", formatUtcTimestamp(value, dateOnly, milliseconds));
  time.setAttribute("datetime", new Date(value).toISOString()); return time;
}
export function periodTimes(document: Document, start: number, end: number): HTMLElement {
  const period = element(document, "span");
  const milliseconds = start !== end && formatUtcTimestamp(start) === formatUtcTimestamp(end);
  period.append(utcTime(document, start, !milliseconds && start % 86400000 === 0, milliseconds), element(document, "span", " to "), utcTime(document, end, false, milliseconds)); return period;
}
/** Convert embedded ISO evidence into readable, machine-readable time elements. */
export function datedText(document: Document, text: string, fragment: (value: string) => HTMLElement = (value: string) => element(document, "span", value)): HTMLElement {
  const root = element(document, "span");
  const pattern = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)(?: to (\d{4}-\d{2}-\d{2}T[\d:.]+Z))?(?: UTC)?/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = Date.parse(match[1]!), end = match[2] ? Date.parse(match[2]) : undefined;
    if (!Number.isFinite(start) || (end !== undefined && !Number.isFinite(end))) continue;
    root.append(fragment(text.slice(offset, match.index)), end !== undefined ? periodTimes(document, start, end) : utcTime(document, start));
    offset = match.index! + match[0].length;
  }
  root.append(fragment(text.slice(offset))); return root;
}
