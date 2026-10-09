const DAY = 86400000;
const formatters = new Map<string, Intl.DateTimeFormat>();
export function dayKey(ts: number, tz: string): string {
  let format = formatters.get(tz);
  if (!format) { format = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); formatters.set(tz, format); }
  const parts = format.formatToParts(ts), part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}
export const ordinal = (date: string): number => Date.parse(`${date}T00:00:00Z`);
export const keyAt = (date: number): string => new Date(date).toISOString().slice(0, 10);
/** Find a local day's earliest instant, including 23/25-hour days and midnight offset changes. */
export function localDayStart(date: string, tz: string, offset = 0): number {
  const target = ordinal(date) + offset * DAY, key = keyAt(target);
  let low = Math.max(0, target - 36 * 3600000), high = Math.min(8640000000000000, target + 36 * 3600000);
  while (low < high) { const mid = low + Math.floor((high - low) / 2); if (dayKey(mid, tz) < key) low = mid + 1; else high = mid; }
  return low;
}
