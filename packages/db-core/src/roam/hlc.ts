import type { Hlc } from "./types";

const MAX_SKEW_MS = 5 * 60 * 1000;
const INVALID_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function validUnicode(value: unknown): value is string {
  return typeof value === "string" && !INVALID_SURROGATE.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate clocks at the database and wire boundaries. */
export function assertHlc(value: unknown): asserts value is Hlc {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid roaming clock");
  const clock = value as Record<string, unknown>;
  if (!nonnegativeInteger(clock.ms) || !nonnegativeInteger(clock.count) ||
      !validUnicode(clock.machine) || !clock.machine || !validUnicode(clock.stream) || !clock.stream) {
    throw new Error("Invalid roaming clock");
  }
}

function order(a: number, b: number): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Match SQLite's binary ordering for the origin components. */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  assertHlc(a);
  assertHlc(b);
  return order(a.ms, b.ms) || order(a.count, b.count) ||
    order(Buffer.compare(Buffer.from(a.machine), Buffer.from(b.machine)), 0) ||
    order(Buffer.compare(Buffer.from(a.stream), Buffer.from(b.stream)), 0);
}

export function observeHlc(local: Hlc, remote: Hlc, now: number): Hlc {
  assertHlc(local);
  assertHlc(remote);
  if (!nonnegativeInteger(now)) throw new Error("Invalid roaming wall clock");
  if (remote.ms > now && remote.ms - now > MAX_SKEW_MS) throw new Error("Remote roaming clock exceeds future skew limit");
  const ms = Math.max(local.ms, remote.ms, now);
  let count = 0;
  if (local.ms === ms && remote.ms === ms) count = Math.max(local.count, remote.count) + 1;
  else if (local.ms === ms) count = local.count + 1;
  else if (remote.ms === ms) count = remote.count + 1;
  if (!Number.isSafeInteger(count)) throw new Error("Roaming clock counter overflow");
  return { ms, count, machine: local.machine, stream: local.stream };
}
