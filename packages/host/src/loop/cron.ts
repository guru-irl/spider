import { resolveLocalMinute, resolveTimeZone, zonedMinute } from "./zoned";
import type { LocalMinute } from "./zoned";

export interface CronSpec {
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: readonly number[];
  months: readonly number[];
  daysOfWeek: readonly number[];
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

function expand(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new Error(`Invalid cron field: ${field}`);
    const [, base, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${item}`);
    const range = base.split("-").map(Number);
    const start = base === "*" ? min : range[0];
    const end = base === "*" ? max : range.length === 2 ? range[1] : stepText === undefined ? start : max;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < min || end > max || end < start)
      throw new Error(`Cron field must be between ${min} and ${max}: ${field}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron requires exactly five numeric fields");
  const [minute, hour, day, month, weekday] = fields;
  const daysOfWeek = [...new Set(expand(weekday, 0, 7).map(value => value === 7 ? 0 : value))]
    .sort((a, b) => a - b);
  return {
    minutes: expand(minute, 0, 59), hours: expand(hour, 0, 23),
    daysOfMonth: expand(day, 1, 31), months: expand(month, 1, 12), daysOfWeek,
    dayOfMonthWildcard: day.startsWith("*"), dayOfWeekWildcard: weekday.startsWith("*"),
  };
}

function civilDate(local: LocalMinute): Date {
  const date = new Date(0);
  date.setUTCFullYear(local.year, local.month - 1, local.day);
  return date;
}

function horizonAfter(afterMs: number): number {
  const horizon = new Date(afterMs);
  const month = horizon.getUTCMonth();
  horizon.setUTCFullYear(horizon.getUTCFullYear() + 5);
  // UTC calendar-year addition clamps Feb 29 rather than Date's default March 1 rollover.
  if (horizon.getUTCMonth() !== month) horizon.setUTCDate(0);
  if (!Number.isFinite(horizon.getTime())) throw new Error("Cannot represent five-calendar-year cron search horizon");
  return horizon.getTime();
}

function matchesDay(spec: CronSpec, date: Date): boolean {
  const day = spec.daysOfMonth.includes(date.getUTCDate());
  const weekday = spec.daysOfWeek.includes(date.getUTCDay());
  return spec.dayOfMonthWildcard || spec.dayOfWeekWildcard ? day && weekday : day || weekday;
}

export function nextCronAt(expression: string, tz: string, afterMs: number): number {
  const spec = parseCron(expression);
  resolveTimeZone(tz);
  if (!Number.isFinite(afterMs) || !Number.isFinite(new Date(afterMs).getTime()))
    throw new Error("Cron search time must be a finite instant");
  const horizon = horizonAfter(afterMs);
  const date = civilDate(zonedMinute(afterMs, tz));
  const lastDate = civilDate(zonedMinute(horizon, tz)).getTime();
  for (; date.getTime() <= lastDate; date.setUTCDate(date.getUTCDate() + 1)) {
    // Calendar-day iteration never constructs February 30 or April 31. Reject whole dates
    // before any minute resolution, so impossible schedules do not scan millions of instants.
    if (!spec.months.includes(date.getUTCMonth() + 1) || !matchesDay(spec, date)) continue;
    let next = Infinity;
    // Include the entire current date, not just times after the current civil minute.
    // Missing minutes may resolve to a gap boundary; overlaps always use their first copy.
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const at = resolveLocalMinute({
          year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
          day: date.getUTCDate(), hour, minute,
        }, tz);
        // Taking the minimum and requiring strict advancement also deduplicates gap minutes.
        if (at > afterMs && at <= horizon) next = Math.min(next, at);
      }
    }
    if (Number.isFinite(next)) return next;
  }
  throw new Error(`Cron has no occurrence within five calendar years: ${expression}`);
}
