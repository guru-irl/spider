import { describe, expect, it } from "vitest";
import { nextCronAt, parseCron } from "../cron";

const ms = Date.parse;

describe("cron grammar", () => {
  it("expands stars ranges lists and steps", () => {
    const parsed = parseCron("*/15 8-9 * * 5-7");
    expect(parsed.minutes).toEqual([0, 15, 30, 45]);
    expect(parsed.hours).toEqual([8, 9]);
    expect(parsed.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(parseCron("5/10 * * * *").minutes).toEqual([5, 15, 25, 35, 45, 55]);
    expect(parseCron("9,1-6/2,3,0 0 1,31 1,12 0").minutes).toEqual([0, 1, 3, 5, 9]);
    expect(parseCron("0 23 1,31 12,1 0").daysOfMonth).toEqual([1, 31]);
    expect(parseCron("0 23 1,31 12,1 0").months).toEqual([1, 12]);
    expect(parseCron("  0\t8  * * 1\n").hours).toEqual([8]);
  });

  it("normalizes Sunday after step expansion", () => {
    expect(parseCron("0 8 * * 5-7").daysOfWeek).toEqual([0, 5, 6]);
    expect(parseCron("0 8 * * 5-7/2").daysOfWeek).toEqual([0, 5]);
    expect(parseCron("0 8 * * 1-7/2").daysOfWeek).toEqual([0, 1, 3, 5]);
    expect(parseCron("0 8 * * 0,7,7/2").daysOfWeek).toEqual([0]);
    expect(parseCron("0 8 * * */2").daysOfWeek).toEqual([0, 2, 4, 6]);
  });

  it("keeps Vixie wildcard flags", () => {
    expect(parseCron("0 8 */2 * 1").dayOfMonthWildcard).toBe(true);
    expect(parseCron("0 8 1-31 * 1").dayOfMonthWildcard).toBe(false);
    expect(parseCron("0 8 1 * */2").dayOfWeekWildcard).toBe(true);
    expect(parseCron("0 8 1 * 0-7").dayOfWeekWildcard).toBe(false);
    expect(parseCron("0 8 *,1 * 1").dayOfMonthWildcard).toBe(true);
    expect(parseCron("0 8 1,* * 1").dayOfMonthWildcard).toBe(false);
  });

  it("rejects unsupported syntax", () => {
    for (const expression of [
      "", "@daily", "0 0 * * * *", "0 0 * *", "60 * * * *", "-1 * * * *",
      "0 24 * * *", "0 0 0 * *", "0 0 32 * *", "0 0 * 0 *", "0 0 * 13 *", "0 0 * * 8",
      "*/0 * * * *", "1/0 * * * *", "1-5/0 * * * *", "*/-1 * * * *",
      "5-1 * * * *", "0 0 * * 7-5", "0,,1 * * * *", ",1 * * * *", "1, * * * *",
      "1.5 * * * *", "*/1.5 * * * *", "1/2/3 * * * *", "1-2-3 * * * *",
      "0 0 * JAN *", "0 0 * * MON", "0 0 ? * *", "0 0 L * *", "0 0 1W * *", "0 0 * * 1#2",
      "999999999999999999999 * * * *", "*/999999999999999999999 * * * *",
    ]) expect(() => parseCron(expression), expression).toThrow();
  });

  it("checks syntax without rejecting impossible dates at restore", () => {
    expect(parseCron("0 0 30 2 *").daysOfMonth).toEqual([30]);
    expect(parseCron("0 0 31 4 *").months).toEqual([4]);
  });
});

describe("zoned cron occurrences", () => {
  it.each([
    ["0 8 * * *", "Asia/Kolkata", "2026-10-26T02:29:59Z", "2026-10-26T02:30:00Z"],
    ["0 8 * * *", "Asia/Kolkata", "2026-10-26T02:30:00Z", "2026-10-27T02:30:00Z"],
    ["30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-08T07:00:00Z"],
    ["30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z"],
    ["30 1 * * *", "America/New_York", "2026-11-01T05:45:00Z", "2026-11-02T06:30:00Z"],
    ["15 2 * * *", "Australia/Lord_Howe", "2026-10-03T14:00:00Z", "2026-10-03T15:30:00Z"],
    ["45 1 * * *", "Australia/Lord_Howe", "2026-04-04T14:50:00Z", "2026-04-05T15:15:00Z"],
    ["0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z", "2028-02-29T00:00:00Z"],
    ["0 0 * * *", "America/New_York", "2026-12-31T23:59:00Z", "2027-01-01T05:00:00Z"],
    ["0 0 1 1 *", "Asia/Kolkata", "2026-12-31T18:29:59Z", "2026-12-31T18:30:00Z"],
    ["0 0 1 1 *", "Asia/Kolkata", "2026-12-31T18:30:00Z", "2027-12-31T18:30:00Z"],
  ])("finds %s in %s after %s", (expression, zone, after, expected) => {
    expect(nextCronAt(expression, zone, ms(after))).toBe(ms(expected));
  });

  it("uses restricted day OR matching", () => {
    expect(nextCronAt("0 8 15 * 1", "UTC", ms("2026-10-14T08:00Z")))
      .toBe(ms("2026-10-15T08:00Z"));
    expect(nextCronAt("0 8 15 * 1", "UTC", ms("2026-10-15T08:00Z")))
      .toBe(ms("2026-10-19T08:00Z"));
    expect(nextCronAt("0 8 1-31 * 1", "UTC", ms("2026-10-26T08:00Z")))
      .toBe(ms("2026-10-27T08:00Z"));
  });

  it("requires both day sets when either starts with a star", () => {
    expect(nextCronAt("0 8 * * 1", "UTC", ms("2026-10-27T00:00Z")))
      .toBe(ms("2026-11-02T08:00Z"));
    expect(nextCronAt("0 8 */2 * 1", "UTC", ms("2026-10-25T00:00Z")))
      .toBe(ms("2026-11-09T08:00Z"));
    expect(nextCronAt("0 8 15 * *", "UTC", ms("2026-10-16T00:00Z")))
      .toBe(ms("2026-11-15T08:00Z"));
    expect(nextCronAt("0 8 * * 7", "UTC", ms("2026-10-26T00:00Z")))
      .toBe(ms("2026-11-01T08:00Z"));
  });

  it.each(["0 0 30 2 *", "0 0 31 4 *", "0 0 31 6 *"])("rejects no-occurrence cron %s", expression => {
    expect(() => nextCronAt(expression, "UTC", ms("2026-01-01T00:00Z")))
      .toThrow(/no occurrence.*five calendar years/i);
  });

  it("deduplicates matching gap minutes", () => {
    expect(nextCronAt("* 2 * * *", "America/New_York", ms("2026-03-08T06:59:59Z")))
      .toBe(ms("2026-03-08T07:00Z"));
    expect(nextCronAt("* 2 * * *", "America/New_York", ms("2026-03-08T07:00Z")))
      .toBe(ms("2026-03-09T06:00Z"));
    expect(nextCronAt("0,15,29 2 * * *", "Australia/Lord_Howe", ms("2026-10-03T15:30Z")))
      .toBe(ms("2026-10-04T15:00Z"));
  });

  it("includes missing civil minutes when searching inside a forward transition", () => {
    expect(nextCronAt("30 2 * * *", "America/New_York", ms("2026-03-08T06:45Z")))
      .toBe(ms("2026-03-08T07:00Z"));
    expect(nextCronAt("15 2 * * *", "Australia/Lord_Howe", ms("2026-10-03T15:29:59Z")))
      .toBe(ms("2026-10-03T15:30Z"));
    expect(nextCronAt("0 12 30 12 *", "Pacific/Apia", ms("2011-12-30T09:59:59Z")))
      .toBe(ms("2011-12-30T10:00Z"));
  });

  it("never returns the second copy even when the search begins in that copy", () => {
    expect(nextCronAt("30 1 * * *", "America/New_York", ms("2026-11-01T06:15Z")))
      .toBe(ms("2026-11-02T06:30Z"));
    expect(nextCronAt("45 1 * * *", "Australia/Lord_Howe", ms("2026-04-04T15:05Z")))
      .toBe(ms("2026-04-05T15:15Z"));
    expect(nextCronAt("* 1 * * *", "America/New_York", ms("2026-11-01T06:00Z")))
      .toBe(ms("2026-11-02T06:00Z"));
    expect(nextCronAt("30 1 * * *", "America/New_York", ms("2026-11-01T05:30:00.001Z")))
      .toBe(ms("2026-11-02T06:30Z"));
  });

  it("includes the exact five UTC calendar-year boundary but nothing beyond it", () => {
    // Feb 1 is not Monday in 2022 through 2026; its next Monday is in 2027.
    const expression = "0 0 */30 2 1";
    expect(nextCronAt(expression, "UTC", ms("2022-02-01T00:00Z")))
      .toBe(ms("2027-02-01T00:00Z"));
    expect(() => nextCronAt(expression, "UTC", ms("2022-01-31T23:59:59.999Z")))
      .toThrow(/no occurrence.*five calendar years/i);
    expect(nextCronAt(expression, "Asia/Kolkata", ms("2022-01-31T18:30Z")))
      .toBe(ms("2027-01-31T18:30Z"));
    expect(() => nextCronAt(expression, "Asia/Kolkata", ms("2022-01-31T18:29:59.999Z")))
      .toThrow(/no occurrence.*five calendar years/i);
  });

  it("clamps a leap-day horizon to February 28 instead of rolling to March 1", () => {
    // The next Thursday March 1 is in 2029, outside the clamped Feb 28 horizon.
    expect(() => nextCronAt("0 12 */31 3 4", "UTC", ms("2024-02-29T12:00Z")))
      .toThrow(/no occurrence.*five calendar years/i);
    expect(() => nextCronAt("0 0 29 2 *", "UTC", ms("2096-02-29T00:00Z")))
      .toThrow(/no occurrence.*five calendar years/i);
  });

  it("validates the zone and finite search time", () => {
    expect(() => nextCronAt("0 8 * * *", "Not/AZone", ms("2026-10-26T00:00Z"))).toThrow();
    expect(() => nextCronAt("0 8 * * *", "+05:30", ms("2026-10-26T00:00Z"))).toThrow();
    expect(() => nextCronAt("0 8 * * *", "UTC", NaN)).toThrow();
    expect(() => nextCronAt("0 8 * * *", "UTC", Infinity)).toThrow();
  });
});
