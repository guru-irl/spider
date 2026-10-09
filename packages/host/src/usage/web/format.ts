const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export function formatTokens(value: number): string { return Number.isFinite(value) ? integer.format(value) : "unavailable"; }

/** V4 display values deliberately omit correction basis and unit suffixes. */
export function formatValue(value: import("../dashboard-v4-contract.js").Value, unit: import("../dashboard-v4-contract.js").Unit): string {
  const number = unit === "credits" ? value.credits : value.tokens.total;
  if (number === null || !Number.isFinite(number)) return "unavailable";
  return new Intl.NumberFormat("en-US", { notation: number >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number).replace("K", "k");
}
const localFormatters = new Map<string, Intl.DateTimeFormat>();
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export function formatLocalTime(ts: number, tz: string, options: { offset?: boolean } = {}): string {
  if (!Number.isFinite(ts)) return "unavailable";
  const key = `${tz}:${!!options.offset}`;
  let formatter = localFormatters.get(key);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(options.offset ? { timeZoneName: "shortOffset" } as const : {}) }); } catch { return formatLocalTime(ts, "UTC", options); }
    localFormatters.set(key, formatter);
  }
  const parts = formatter.formatToParts(ts); const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${part("weekday")} ${Number(part("day"))} ${months[Number(part("month")) - 1]} ${part("hour")}:${part("minute")}${options.offset ? ` ${part("timeZoneName")}` : ""}`;
}
export function formatUtcTime(ts: number): string { return `${formatLocalTime(ts, "UTC")} UTC`; }
