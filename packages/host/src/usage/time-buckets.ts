import type { Period } from "./dashboard-contract.js";
import type { RangeQuery, RangePreset, Unit } from "./dashboard-v4-contract.js";
import { DAY_MS, invalidQuery, safeTimestamp } from "./dashboard-selection.js";

export function normalizeTimeZone(value: string): string {
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return "UTC"; }
}

/** The offset is part of an hour's identity, so a repeated hour has two keys.
 * Search actual instants rather than constructing a potentially nonexistent midnight.
 * This also handles fractional-hour transitions and entirely skipped local dates. */
export function timeBuckets(period: Period, tz: string, size: "hour" | "day"): readonly (Period & { key: number })[] {
  if (!safeTimestamp(period.start) || !safeTimestamp(period.end) || period.end < period.start || !["hour", "day"].includes(size)) invalidQuery();
  if (period.start === period.end) return [];
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: normalizeTimeZone(tz),
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const identity = (at: number): string => {
    const p = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    if (size === "day") return date;
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return `${date}T${p.hour}/${wall - Math.floor(at / 1000) * 1000}`;
  };
  const step = size === "hour" ? 15 * 60_000 : 6 * 3_600_000;
  // Find the first instant with the new identity between two bracketing samples.
  const boundary = (lo: number, hi: number, old: string): number => {
    while (hi - lo > 1) { const mid = lo + Math.floor((hi - lo) / 2); if (identity(mid) === old) lo = mid; else hi = mid; }
    return hi;
  };
  let probe = period.start, current = identity(probe), before = Math.max(-8_640_000_000_000_000, probe - step);
  while (identity(before) === current) { probe = before; before -= step; }
  let key = boundary(before, probe, identity(before));
  const rows: (Period & { key: number })[] = [];
  let start = period.start;
  while (start < period.end) {
    current = identity(start); probe = start;
    let after = Math.min(period.end, probe + step);
    while (after < period.end && identity(after) === current) { probe = after; after = Math.min(period.end, after + step); }
    const end = identity(after) === current ? period.end : boundary(probe, after, current);
    rows.push({ key, start, end }); key = end; start = end;
  }
  return rows;
}

export function resolveRange(params: URLSearchParams, now: number, month?: Period): RangeQuery {
  if (!safeTimestamp(now)) invalidQuery();
  const range = (params.get("range") ?? "7d") as RangePreset;
  const unit = (params.get("unit") ?? "credits") as Unit;
  if (!["24h", "7d", "30d", "month", "custom"].includes(range) || !["credits", "tokens"].includes(unit)) invalidQuery();
  const tz = normalizeTimeZone(params.get("tz") ?? "UTC");
  let from: number, to = now;
  if (range === "custom") {
    const numeric = (s: string | null) => { if (s === null || !/^\d+$/.test(s)) invalidQuery(); return Number(s); };
    from = numeric(params.get("from")); to = numeric(params.get("to"));
  } else if (range === "month") {
    const date = new Date(now); from = month?.start ?? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  } else from = Math.max(0, now - ({ "24h": 1, "7d": 7, "30d": 30 }[range]) * DAY_MS);
  if (!safeTimestamp(from) || !safeTimestamp(to) || to < from || to - from > 93 * DAY_MS) invalidQuery();
  return { range, from, to, tz, unit, buckets: [] };
}
