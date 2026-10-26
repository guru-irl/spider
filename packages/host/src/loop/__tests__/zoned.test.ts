import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatInZone, offsetMinutes, parseAt, resolveLocalMinute, resolveTimeZone,
  zonedMinute, zoneSource,
} from "../zoned";
import type { LocalMinute } from "../zoned";

const ms = Date.parse;
const now = ms("2026-10-26T00:00Z");

afterEach(() => vi.restoreAllMocks());

describe("absolute and zoned times", () => {
  it("converts an offset-bearing time to an instant and local fields", () => {
    const at = ms("2026-10-27T02:30Z");
    expect(parseAt("2026-10-27T08:00+05:30", now)).toBe(at);
    expect(zonedMinute(at, "Asia/Kolkata"))
      .toEqual({ year: 2026, month: 10, day: 27, hour: 8, minute: 0, weekday: 2 });
    expect(offsetMinutes(at, "Asia/Kolkata")).toBe(330);
    expect(resolveTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(formatInZone(at, "Asia/Kolkata")).toBe("2026-10-27 08:00:00 Asia/Kolkata");
  });

  it("requires an offset and a future valid date", () => {
    for (const input of [
      "2026-10-27T08:00", "2027-02-30T08:00Z", "2027-02-29T08:00Z",
      "2026-13-01T08:00Z", "2026-00-01T08:00Z", "2026-10-00T08:00Z",
      "2026-10-27T24:00Z", "2026-10-27T08:60Z", "2026-10-27T08:00:60Z",
      "2026-10-27T08:00+15:00", "2026-10-27T08:00+05:60",
      "2026-10-27t08:00Z", "2026-10-27T08:00z", "2026-10-27T08:00+0530",
      "2026-10-27T08:00.1Z", "2026-10-27T08:00:01.1234Z",
      "2026-10-27T08:00:01.Z", " 2026-10-27T08:00Z", "2026-10-27T08:00Z\n",
      "2026-10-26T00:00Z", "2026-10-25T23:59:59.999Z",
    ]) expect(() => parseAt(input, now), input).toThrow();
  });

  it("accepts optional seconds and dates beyond one hour", () => {
    for (const [input, expected] of [
      ["2026-10-27T08:00Z", "2026-10-27T08:00:00.000Z"],
      ["2026-10-27T08:00-04:30", "2026-10-27T12:30:00.000Z"],
      ["2026-10-27T08:00:17Z", "2026-10-27T08:00:17.000Z"],
      ["2026-10-27T08:00:17.1Z", "2026-10-27T08:00:17.100Z"],
      ["2026-10-27T08:00:17.12Z", "2026-10-27T08:00:17.120Z"],
      ["2026-10-27T08:00:17.123Z", "2026-10-27T08:00:17.123Z"],
      ["2026-10-27T08:00+14:59", "2026-10-26T17:01:00.000Z"],
      ["2026-10-27T08:00-14:59", "2026-10-27T22:59:00.000Z"],
      ["2040-02-29T08:00Z", "2040-02-29T08:00:00.000Z"],
      ["9999-12-31T23:59Z", "9999-12-31T23:59:00.000Z"],
    ]) expect(parseAt(input, now), input).toBe(ms(expected));
    expect(parseAt("0099-01-01T00:00Z", ms("0098-01-01T00:00Z")))
      .toBe(ms("0099-01-01T00:00Z"));
  });

  it("resolves and validates IANA zones", () => {
    expect(resolveTimeZone("UTC")).toBe("UTC");
    expect(resolveTimeZone("Asia/Calcutta")).toBe("Asia/Calcutta");
    expect(resolveTimeZone("Etc/GMT+5")).toBe("Etc/GMT+5");
    expect(() => resolveTimeZone()).not.toThrow();
    for (const tz of ["Not/AZone", "+05:30", "-0430", "+05", "GMT+05:30", "", " Asia/Kolkata"])
      expect(() => resolveTimeZone(tz), tz).toThrow();
  });

  it("preserves the machine zone spelling before falling back to Intl", () => {
    const env = vi.spyOn(zoneSource, "environment").mockReturnValue(undefined);
    const link = vi.spyOn(zoneSource, "readLink").mockReturnValue("/usr/share/zoneinfo/Asia/Kolkata");
    vi.spyOn(zoneSource, "defaultZone").mockReturnValue("Asia/Calcutta");
    expect(resolveTimeZone()).toBe("Asia/Kolkata");
    env.mockReturnValue("America/New_York");
    expect(resolveTimeZone()).toBe("America/New_York");
    env.mockReturnValue("Asia/Kolkata");
    link.mockReturnValue("/usr/share/zoneinfo/UTC");
    expect(resolveTimeZone()).toBe("Asia/Kolkata");
    link.mockReturnValue("/usr/share/zoneinfo/Asia/Kolkata");
    for (const invalid of ["Not/AZone", "+05:30", "-04", ""]) {
      env.mockReturnValue(invalid);
      expect(resolveTimeZone()).toBe("Asia/Kolkata");
    }
    env.mockReturnValue(undefined);
    for (const target of ["/usr/share/zoneinfo/Not/AZone", "/usr/share/zoneinfo/UTC", "no-zoneinfo-suffix"]) {
      link.mockReturnValue(target);
      expect(resolveTimeZone()).toBe("Asia/Calcutta");
    }
    for (const message of ["ENOENT", "EACCES"]) {
      link.mockImplementation(() => { throw new Error(message); });
      expect(resolveTimeZone()).toBe("Asia/Calcutta");
    }
  });

  it.each([undefined, "Etc/Unknown"])("uses a valid localtime link when Intl reports %s", fallback => {
    vi.spyOn(zoneSource, "environment").mockReturnValue("UTC0");
    vi.spyOn(zoneSource, "defaultZone").mockReturnValue(fallback!);
    vi.spyOn(zoneSource, "readLink").mockReturnValue("/usr/share/zoneinfo/Asia/Kolkata");
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300);
    expect(resolveTimeZone()).toBe("Asia/Kolkata");
  });

  it.each([
    [0, "Etc/GMT"], [300, "Etc/GMT+5"], [-180, "Etc/GMT-3"],
    [-330, "UTC"], [NaN, "UTC"], [-900, "UTC"],
  ])("uses an offset-derived zone or UTC when no named zone is valid: %s", (offset, expected) => {
    vi.spyOn(zoneSource, "environment").mockReturnValue("EST5");
    vi.spyOn(zoneSource, "defaultZone").mockReturnValue("Etc/Unknown");
    vi.spyOn(zoneSource, "readLink").mockImplementation(() => { throw new Error("ENOENT"); });
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(offset);
    expect(resolveTimeZone()).toBe(expected);
    expect(() => formatInZone(now, resolveTimeZone())).not.toThrow();
  });

  it.each([undefined, null, 3])("rejects a non-string zone rather than using the machine default: %s", tz => {
    expect(() => formatInZone(now, tz as unknown as string)).toThrow(/Invalid IANA time zone/);
  });

  it("uses Gregorian h23 fields at midnight", () => {
    expect(zonedMinute(ms("2026-12-31T18:30Z"), "Asia/Kolkata"))
      .toEqual({ year: 2027, month: 1, day: 1, hour: 0, minute: 0, weekday: 5 });
    expect(formatInZone(ms("2026-12-31T18:30:07.123Z"), "Asia/Kolkata"))
      .toBe("2027-01-01 00:00:07 Asia/Kolkata");
    expect(offsetMinutes(ms("2026-12-31T18:30:07.123Z"), "Asia/Kolkata")).toBe(330);
  });

  it("resolves gaps to their end and overlaps to their first instant", () => {
    const rows: [string, LocalMinute, string][] = [
      ["America/New_York", { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "2026-03-08T07:00Z"],
      ["America/New_York", { year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "2026-11-01T05:30Z"],
      ["Australia/Lord_Howe", { year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, "2026-10-03T15:30Z"],
      ["Australia/Lord_Howe", { year: 2026, month: 4, day: 5, hour: 1, minute: 45 }, "2026-04-04T14:45Z"],
      ["Asia/Kolkata", { year: 2026, month: 10, day: 27, hour: 8, minute: 0 }, "2026-10-27T02:30Z"],
      ["Pacific/Apia", { year: 2011, month: 12, day: 30, hour: 12, minute: 0 }, "2011-12-30T10:00Z"],
    ];
    for (const [zone, local, expected] of rows)
      expect(resolveLocalMinute(local, zone), `${zone} ${JSON.stringify(local)}`).toBe(ms(expected));
  });

  it("resolves both sides of non-hour and hour transitions", () => {
    for (const [zone, local, expected] of [
      ["America/New_York", "2026-03-08T01:59", "2026-03-08T06:59Z"],
      ["America/New_York", "2026-03-08T03:00", "2026-03-08T07:00Z"],
      ["America/New_York", "2026-11-01T00:59", "2026-11-01T04:59Z"],
      ["America/New_York", "2026-11-01T02:00", "2026-11-01T07:00Z"],
      ["Australia/Lord_Howe", "2026-10-04T01:59", "2026-10-03T15:29Z"],
      ["Australia/Lord_Howe", "2026-10-04T02:30", "2026-10-03T15:30Z"],
      ["Australia/Lord_Howe", "2026-04-05T01:29", "2026-04-04T14:29Z"],
      ["Australia/Lord_Howe", "2026-04-05T02:00", "2026-04-04T15:30Z"],
      ["America/New_York", "2027-01-01T00:00", "2027-01-01T05:00Z"],
      ["Asia/Kolkata", "2027-01-01T00:00", "2026-12-31T18:30Z"],
      ["America/New_York", "2026-04-01T00:00", "2026-04-01T04:00Z"],
    ]) {
      const [year, month, day, hour, minute] = local.split(/[-T:]/).map(Number);
      expect(resolveLocalMinute({ year, month, day, hour, minute }, zone)).toBe(ms(expected));
    }
    expect(offsetMinutes(ms("2026-03-08T06:59Z"), "America/New_York")).toBe(-300);
    expect(offsetMinutes(ms("2026-03-08T07:00Z"), "America/New_York")).toBe(-240);
    expect(offsetMinutes(ms("2026-04-04T14:59Z"), "Australia/Lord_Howe")).toBe(660);
    expect(offsetMinutes(ms("2026-04-04T15:00Z"), "Australia/Lord_Howe")).toBe(630);
  });

  it("rejects invalid civil dates before resolving", () => {
    const local = { year: 2026, month: 2, day: 28, hour: 8, minute: 0 };
    for (const patch of [
      { day: 30 }, { day: 29 }, { day: 0 }, { month: 13 }, { month: 0 },
      { hour: 24 }, { hour: -1 }, { minute: 60 }, { minute: 1.5 }, { year: NaN },
    ]) expect(() => resolveLocalMinute({ ...local, ...patch }, "UTC")).toThrow();
    expect(resolveLocalMinute({ ...local, year: 2028, day: 29 }, "UTC"))
      .toBe(ms("2028-02-29T08:00Z"));
  });
});
