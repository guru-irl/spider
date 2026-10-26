import { readlinkSync } from "node:fs";

export interface LocalMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}
export interface ZonedMinute extends LocalMinute { weekday: number }

/** @internal Machine-zone inputs, kept separate from explicit-zone calculations. */
export const zoneSource: {
  environment(): string | undefined;
  readLink(): string;
  defaultZone(): string;
} = {
  environment: () => process.env.TZ,
  readLink: () => readlinkSync("/etc/localtime"),
  defaultZone: () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let result = formatters.get(tz);
  if (!result) {
    // Intl also accepts numeric offset strings on newer runtimes. These are not IANA names.
    if (!/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(tz))
      throw new Error(`Invalid IANA time zone: ${tz}`);
    try {
      result = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
        era: "short", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      throw new Error(`Invalid IANA time zone: ${tz}`);
    }
    formatters.set(tz, result);
  }
  return result;
}

function canonicalZone(tz: string): string | undefined {
  try { return formatter(tz).resolvedOptions().timeZone; }
  catch { return undefined; }
}

export function resolveTimeZone(tz?: string): string {
  if (tz !== undefined) {
    formatter(tz);
    return tz;
  }
  const environment = zoneSource.environment();
  if (environment && canonicalZone(environment)) return environment;
  const fallback = zoneSource.defaultZone();
  try {
    const link = zoneSource.readLink();
    const marker = "zoneinfo/";
    const index = link.lastIndexOf(marker);
    const candidate = index < 0 ? "" : link.slice(index + marker.length);
    if (candidate && canonicalZone(candidate) === canonicalZone(fallback)
      && canonicalZone(candidate) !== undefined) return candidate;
  } catch { /* Missing, unreadable, or non-symlink localtime: use Intl. */ }
  formatter(fallback);
  return fallback;
}

// setUTCFullYear avoids Date.UTC's special interpretation of years 00 through 99.
function civilUtc(local: LocalMinute, second = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(local.year, local.month - 1, local.day);
  date.setUTCHours(local.hour, local.minute, second, 0);
  return date.getTime();
}

function validateLocal(local: LocalMinute): number {
  const { year, month, day, hour, minute } = local;
  if (![year, month, day, hour, minute].every(Number.isInteger)
    || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59)
    throw new Error("Invalid civil date or time");
  const at = civilUtc(local);
  const date = new Date(at);
  if (!Number.isFinite(at) || date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day)
    throw new Error("Invalid civil date or time");
  return at;
}

function fields(atMs: number, tz: string): LocalMinute & { second: number } {
  const parts = formatter(tz).formatToParts(atMs);
  const numbers: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal" && part.type !== "era") numbers[part.type] = Number(part.value);
  }
  return {
    year: parts.some(part => part.type === "era" && part.value === "BC") ? 1 - numbers.year : numbers.year,
    month: numbers.month, day: numbers.day, hour: numbers.hour, minute: numbers.minute,
    second: numbers.second,
  };
}

export function zonedMinute(atMs: number, tz: string): ZonedMinute {
  const { second: _second, ...local } = fields(atMs, tz);
  return { ...local, weekday: new Date(civilUtc(local)).getUTCDay() };
}

export function offsetMinutes(atMs: number, tz: string): number {
  const local = fields(atMs, tz);
  return (civilUtc(local, local.second) - Math.floor(atMs / 1000) * 1000) / MINUTE;
}

interface Transition { at: number; before: number; after: number }
interface DateOffsets { offsets: number[]; transitions: Transition[] }
const dateOffsets = new Map<string, DateOffsets>();

function offsetsForDate(local: LocalMinute, tz: string): DateOffsets {
  const key = `${tz}/${local.year}/${local.month}/${local.day}`;
  const cached = dateOffsets.get(key);
  if (cached) return cached;
  const midnight = civilUtc({ ...local, hour: 0, minute: 0 });
  const offsets = new Set<number>();
  const transitions: Transition[] = [];
  // Three days on either side cover all IANA offsets, including a skipped civil day.
  // Six-hour samples discover the offsets; only changed spans need a minute-level search.
  let previousAt = midnight - 3 * DAY;
  let previousOffset = offsetMinutes(previousAt, tz);
  offsets.add(previousOffset);
  for (let at = previousAt + DAY / 4; at <= midnight + 3 * DAY; at += DAY / 4) {
    const offset = offsetMinutes(at, tz);
    offsets.add(offset);
    if (offset !== previousOffset) {
      let low = previousAt / MINUTE;
      let high = at / MINUTE;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (offsetMinutes(mid * MINUTE, tz) === previousOffset) low = mid;
        else high = mid;
      }
      transitions.push({ at: high * MINUTE, before: previousOffset, after: offset });
    }
    previousAt = at;
    previousOffset = offset;
  }
  const result = { offsets: [...offsets], transitions };
  // Bound the cache across long-lived sessions and unsuccessful multi-year cron searches.
  if (dateOffsets.size >= 512) dateOffsets.delete(dateOffsets.keys().next().value!);
  dateOffsets.set(key, result);
  return result;
}

export function resolveLocalMinute(local: LocalMinute, tz: string): number {
  const naive = validateLocal(local);
  const { offsets, transitions } = offsetsForDate(local, tz);
  let earliest = Infinity;
  for (const offset of offsets) {
    const candidate = naive - offset * MINUTE;
    const roundTrip = zonedMinute(candidate, tz);
    if (roundTrip.year === local.year && roundTrip.month === local.month
      && roundTrip.day === local.day && roundTrip.hour === local.hour
      && roundTrip.minute === local.minute) earliest = Math.min(earliest, candidate);
  }
  if (Number.isFinite(earliest)) return earliest;
  for (const { at, before, after } of transitions) {
    if (after > before && naive >= at + before * MINUTE && naive < at + after * MINUTE)
      return at;
  }
  throw new Error(`Unable to resolve civil minute in ${tz}`);
}

export function formatInZone(atMs: number, tz: string): string {
  const local = fields(atMs, tz);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)} ${tz}`;
}

export function parseAt(value: string, nowMs: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  // Unlike $, this length check also rejects a trailing newline.
  if (!match || match[0].length !== value.length) throw new Error("Invalid absolute time; use an ISO date with an explicit offset");
  const [, year, month, day, hour, minute, second, fraction, zone, sign, offsetHour, offsetMinute] = match;
  const naive = validateLocal({ year: +year, month: +month, day: +day, hour: +hour, minute: +minute });
  if (+(second ?? 0) > 59 || +(offsetHour ?? 0) > 14 || +(offsetMinute ?? 0) > 59)
    throw new Error("Invalid absolute time seconds or offset");
  const offset = zone === "Z" ? 0 : (+offsetHour * 60 + +offsetMinute) * (sign === "+" ? 1 : -1);
  const at = naive + +(second ?? 0) * 1000 + Number((fraction ?? "").padEnd(3, "0")) - offset * MINUTE;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs) || at <= nowMs)
    throw new Error("Absolute time must be a finite instant strictly in the future");
  return at;
}
