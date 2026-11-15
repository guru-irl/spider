import { expect, it } from "vitest";
import type { Probe } from "@spider/db-core/roam/types";
import * as production from "../production-supervisor";

type StopFactory = (input: { now(): number; stopToken(id: string): Promise<string | null>; observe(id: string): Promise<Probe>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void }) => { stop(id: string): Promise<Probe>; cancel(id: string): void };
const create = (production as typeof production & { createBoundedStop?: StopFactory }).createBoundedStop;
const live = (startTime = "start-1"): Probe => ({ kind: "live", identity: { bootId: "boot-1", pid: 91, startTime } });

it("sends SIGTERM once and SIGKILL after the grace period to the same live owner", async () => {
  expect(create).toBeTypeOf("function");
  let now = 1000; const signals: string[] = [];
  const { stop } = create!({ now: () => now, stopToken: async () => "stop-1", observe: async () => live(),
    signal: (pid, signal) => signals.push(`${pid}:${signal}`) });
  await stop("session"); now += 29_999; await stop("session");
  expect(signals).toEqual(["91:SIGTERM"]);
  now++; await stop("session");
  expect(signals).toEqual(["91:SIGTERM", "91:SIGKILL"]);
}, 5000);

it("starts a new grace period after PID reuse and never signals an uncertain owner", async () => {
  expect(create).toBeTypeOf("function");
  let now = 0, observed: Probe = live(); const signals: string[] = [];
  const { stop } = create!({ now: () => now, stopToken: async () => "stop-1", observe: async () => observed,
    signal: (pid, signal) => signals.push(`${pid}:${signal}`) });
  await stop("session"); now = 30_000; observed = { kind: "uncertain" }; await stop("session");
  expect(signals).toEqual(["91:SIGTERM"]);
  observed = live("start-2"); await stop("session");
  expect(signals).toEqual(["91:SIGTERM", "91:SIGTERM"]);
  now += 30_000; await stop("session");
  expect(signals).toEqual(["91:SIGTERM", "91:SIGTERM", "91:SIGKILL"]);
}, 5000);

it("starts a fresh grace period when stop is reissued after an unobserved resume", async () => {
  expect(create).toBeTypeOf("function");
  let now = 0, token = "first-stop"; const signals: string[] = [];
  const { stop } = create!({ now: () => now, stopToken: async () => token, observe: async () => live(),
    signal: (pid, signal) => signals.push(`${pid}:${signal}`) });
  await stop("session"); now = 30_000; token = "second-stop"; await stop("session");
  expect(signals).toEqual(["91:SIGTERM", "91:SIGTERM"]);
  now += 30_000; await stop("session"); expect(signals.at(-1)).toBe("91:SIGKILL");
}, 5000);

it("rechecks stopped intent and owner identity before escalating", async () => {
  expect(create).toBeTypeOf("function");
  let now = 0, stopped = true, changeDuringCheck = false, calls = 0; const signals: string[] = [];
  const { stop } = create!({ now: () => now, stopToken: async () => stopped ? "stop-1" : null,
    observe: async () => changeDuringCheck && ++calls > 1 ? live("replacement") : live(),
    signal: (pid, signal) => signals.push(`${pid}:${signal}`) });
  await stop("session"); now = 30_000; stopped = false; await stop("session");
  expect(signals).toEqual(["91:SIGTERM"]);
  stopped = true; now = 31_000; await stop("session");
  now = 61_000; changeDuringCheck = true; calls = 0; await stop("session");
  expect(signals).toEqual(["91:SIGTERM", "91:SIGTERM"]);
}, 5000);
