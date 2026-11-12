import { describe, expect, it } from "vitest";
import { compareHlc, observeHlc } from "@spider/db-core/roam/hlc";
import type { Hlc } from "@spider/db-core/roam/types";

const local: Hlc = { ms: 1000, count: 4, machine: "11111111-1111-4111-8111-111111111111", stream: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const remote: Hlc = { ms: 1000, count: 8, machine: "22222222-2222-4222-8222-222222222222", stream: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

describe("roaming hybrid logical clocks", () => {
  it("orders by milliseconds, counter, machine, and stream", () => {
    expect(compareHlc(local, { ...remote, ms: 1001, count: 0 })).toBe(-1);
    expect(compareHlc(local, { ...remote, count: 3 })).toBe(1);
    expect(compareHlc(local, { ...local, machine: remote.machine })).toBe(-1);
    expect(compareHlc(local, { ...local, stream: remote.stream })).toBe(-1);
    expect(compareHlc(local, { ...local })).toBe(0);
  }, 5000);

  it("orders valid Unicode identities by their UTF-8 bytes", () => {
    expect(compareHlc({ ...local, machine: "\ue000" }, { ...local, machine: "\u{10000}" })).toBe(-1);
  }, 5000);

  it.each([
    [1000, 4, 1000, 8, 999, 1000, 9],
    [1000, 4, 900, 8, 800, 1000, 5],
    [900, 4, 1000, 8, 800, 1000, 9],
    [900, 4, 950, 8, 1000, 1000, 0],
    [1000, 4, 900, 8, 1000, 1000, 5],
    [900, 4, 1000, 8, 1000, 1000, 9],
    [1000, 9, 1000, 4, 1000, 1000, 10],
  ])("receives clocks %i/%i and %i/%i at %i", (localMs, localCount, remoteMs, remoteCount, now, expectedMs, expectedCount) => {
    const result = observeHlc({ ...local, ms: localMs, count: localCount }, { ...remote, ms: remoteMs, count: remoteCount }, now);
    expect(result).toEqual({ ms: expectedMs, count: expectedCount, machine: local.machine, stream: local.stream });
    expect(result.count).toBe(expectedCount);
  }, 5000);

  it("keeps logical progress when wall time moves backwards", () => {
    expect(observeHlc(local, { ...remote, ms: 900 }, 800)).toEqual({ ...local, count: 5 });
  }, 5000);

  it("accepts five minutes of future skew and rejects one millisecond more", () => {
    expect(observeHlc(local, { ...remote, ms: 301000 }, 1000)).toEqual({ ...local, ms: 301000, count: 9 });
    expect(() => observeHlc(local, { ...remote, ms: 301001 }, 1000)).toThrow(/skew|future/i);
  }, 5000);

  it("rejects counter overflow but permits a newer wall clock to reset it", () => {
    const full = { ...local, count: Number.MAX_SAFE_INTEGER };
    expect(() => observeHlc(full, { ...remote, ms: 900 }, 999)).toThrow(/overflow|range/i);
    expect(() => observeHlc(local, { ...remote, count: Number.MAX_SAFE_INTEGER }, 1000)).toThrow(/overflow|range/i);
    expect(observeHlc(full, { ...remote, ms: 900 }, 1001)).toEqual({ ...local, ms: 1001, count: 0 });
  }, 5000);

  it("rejects malformed Unicode clock identities instead of comparing replacements", () => {
    expect(() => compareHlc({ ...local, machine: "\ud800" }, { ...local, machine: "\ud801" })).toThrow();
  }, 5000);

  it("rejects invalid clock values and unsafe wall time", () => {
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => observeHlc({ ...local, ms: invalid }, remote, 1000)).toThrow();
      expect(() => observeHlc(local, { ...remote, count: invalid }, 1000)).toThrow();
      expect(() => observeHlc(local, remote, invalid)).toThrow();
    }
    expect(() => compareHlc(local, { ...remote, ms: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  }, 5000);
});
