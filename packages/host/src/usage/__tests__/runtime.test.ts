import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageRuntime, supportsUsageWorkers, type UsageRuntimeOptions } from "../runtime.js";
import { usageDoctorLines } from "../doctor.js";
import type { UsageWorkerEvent } from "../protocol.js";

class FakeWorker extends EventEmitter {
  commands: unknown[] = [];
  terminations = 0;
  postMessage(command: unknown) { this.commands.push(command); }
  unref() {}
  async terminate() { this.terminations++; return 0; }
}
const roots = { registryDb: "fixture/registry.db", sessionsDir: "fixture/sessions", ledgerFile: "fixture/usage.db", authPath: "fixture/auth.json", leaseDir: "fixture/leases" };
const snapshot: UsageWorkerEvent = { type: "snapshot", health: { schemaVersion: 1, calls: 3, sources: 1, parseErrors: 0, sourceErrors: 0, unpricedModels: [], aggregateCalls: 0, lastIngestAt: 1 }, counter: { availability: "disabled", role: "inactive", lastAttemptAt: null, lastSuccessAt: null, nextPollAt: null, snapshotAgeMs: null, errorCode: null, notice: null, latest: null }, backfill: "complete", reconciliation: { windowStart: 0, windowEnd: 1, computedAIC: 0, counterAIC: null, gap: null, ratio: null, unpricedCalls: 0, estimated: true } };
let instances: UsageRuntime[];
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); })); instances = []; });
afterEach(async () => { const stops = instances.map(r => r.stop()); await vi.advanceTimersByTimeAsync(2000); await Promise.all(stops); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture(extra: Partial<UsageRuntimeOptions> = {}) {
  const worker = new FakeWorker();
  const factory = vi.fn(() => worker as any);
  const changed = vi.fn();
  const runtime = new UsageRuntime({ bundleUrl: new URL("file:///fixture/dist/extension.js?build=123"), roots, child: false, workerFactory: factory, onSnapshot: changed, ...extra });
  instances.push(runtime);
  return { runtime, factory, worker, changed };
}
it("construction starts no resources and startup returns before history work", async () => {
  const f = fixture();
  expect(f.factory).not.toHaveBeenCalled();
  f.runtime.start(false);
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.runtime.snapshot().backfill).toBe("pending");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.factory).toHaveBeenCalledTimes(1);
  const [url, options] = f.factory.mock.calls[0] as unknown as [URL, any];
  expect(url.href).toBe("file:///fixture/dist/extension.js?build=123");
  expect(options.resourceLimits.maxOldGenerationSizeMb).toBeLessThanOrEqual(256);
  expect(options.workerData.command).toMatchObject({ type: "start", poll: false, child: false, roots });
  expect(options.workerData.command.owner).toMatch(new RegExp(`^${process.pid}:`));
  expect(options.execArgv).toEqual([]);
});
it("does not inherit arbitrary NODE_OPTIONS preloads in the worker", async () => {
  vi.stubEnv("NODE_OPTIONS", "--import=file:///fixture/private-preload.mjs");
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  const options = (f.factory.mock.calls[0] as unknown as [URL, any])[1];
  expect(options.env).toBeDefined();
  expect(options.env.NODE_OPTIONS).toBeUndefined();
  expect(process.env.NODE_OPTIONS).toBe("--import=file:///fixture/private-preload.mjs");
});
it("child starts no worker ledger or poller", async () => {
  const f = fixture({ child: true }); f.runtime.start(true);
  await vi.advanceTimersByTimeAsync(0); await f.runtime.stop();
  expect(f.factory).not.toHaveBeenCalled(); expect(f.runtime.snapshot().health).toBeNull();
});
it("refresh coalesces until a snapshot acknowledges it", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 100; i++) f.runtime.refresh();
  expect(f.worker.commands).toEqual([{ type: "refresh" }]);
  f.worker.emit("message", snapshot);
  expect(f.runtime.snapshot().health?.calls).toBe(3);
  f.runtime.refresh(); expect(f.worker.commands).toHaveLength(2);
  f.runtime.configure(true); expect(f.worker.commands.at(-1)).toEqual({ type: "configure", poll: true });
});
it.each(["bun", "sea"])("unsupported %s runtime degrades without creating a worker", async () => {
  const f = fixture({ supportsWorkers: () => false }); f.runtime.start(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.factory).not.toHaveBeenCalled(); expect(f.runtime.snapshot().errorCode).toBe("usage-worker-unavailable");
});
it.each([["ERR_WORKER_OUT_OF_MEMORY", "usage-worker-oom"], ["SECRET:/private/path", "usage-worker-failed"]])("sanitizes worker failure %s and leaves the last snapshot usable", async (code, expected) => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0); f.worker.emit("message", snapshot);
  f.worker.emit("error", Object.assign(new Error("private transcript content"), { code }));
  expect(f.runtime.snapshot()).toMatchObject({ errorCode: expected, health: { calls: 3 }, backfill: "failed" });
  expect(JSON.stringify(f.runtime.snapshot())).not.toContain("private transcript");
  await f.runtime.stop(); expect(f.worker.terminations).toBe(1);
});
it("an OOM exit preserves the specific sanitized diagnostic", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  f.worker.emit("error", Object.assign(new Error("private heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
  f.worker.emit("exit", 1);
  expect(f.runtime.snapshot().errorCode).toBe("usage-worker-oom");
});
it("a failed refresh can be retried without waiting for a successful snapshot", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  f.runtime.refresh(); f.worker.emit("message", { type: "error", code: "usage-ingest-failed" });
  f.runtime.refresh();
  expect(f.worker.commands).toEqual([{ type: "refresh" }, { type: "refresh" }]);
});
it("capability detection rejects Bun and SEA without depending on executable names", () => {
  const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
  try {
    Object.defineProperty(process.versions, "bun", { value: "fixture", configurable: true });
    expect(supportsUsageWorkers()).toBe(false);
  } finally {
    if (bun) Object.defineProperty(process.versions, "bun", bun); else delete (process.versions as any).bun;
  }
  const builtin = vi.spyOn(process, "getBuiltinModule").mockReturnValue({ isSea: () => true } as any);
  try { expect(supportsUsageWorkers()).toBe(false); } finally { builtin.mockRestore(); }
  expect(supportsUsageWorkers()).toBe(true);
});
it("shutdown acknowledges and terminates once and rejects obsolete snapshot handlers", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  const first = f.runtime.stop(), second = f.runtime.stop();
  expect(first).toBe(second); expect(f.worker.commands).toEqual([{ type: "stop" }]);
  f.worker.emit("message", { type: "stopped" }); await first;
  expect(f.worker.terminations).toBe(1);
  f.worker.emit("message", snapshot); expect(f.runtime.snapshot().health).toBeNull();
  expect(f.worker.listenerCount("message")).toBe(0);
});
it("unacknowledged shutdown forces termination at the two second deadline", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  const stopping = f.runtime.stop(); await vi.advanceTimersByTimeAsync(1999); expect(f.worker.terminations).toBe(0);
  await vi.advanceTimersByTimeAsync(1); await stopping; expect(f.worker.terminations).toBe(1);
});
it("stop before deferred startup never creates a worker", async () => {
  const f = fixture(); f.runtime.start(false); await f.runtime.stop(); await vi.advanceTimersByTimeAsync(0);
  expect(f.factory).not.toHaveBeenCalled();
});
it("factory failure and abnormal exit never throw into pi", async () => {
  const f = fixture({ workerFactory: () => { throw new Error("secret"); } });
  expect(() => f.runtime.start(false)).not.toThrow(); await vi.advanceTimersByTimeAsync(0);
  expect(f.runtime.snapshot().errorCode).toBe("usage-worker-failed");
  const g = fixture(); g.runtime.start(false); await vi.advanceTimersByTimeAsync(0); g.worker.emit("exit", 1);
  expect(g.runtime.snapshot().errorCode).toBe("usage-worker-failed");
});

it("worker-reported ledger failure survives a stopped event and exit", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  f.worker.emit("message", { type: "error", code: "usage-ledger-unavailable" });
  f.worker.emit("message", { type: "stopped" }); f.worker.emit("exit", 0);
  expect(f.runtime.snapshot().errorCode).toBe("usage-ledger-unavailable");
});

it.each(["usage-ingest-lease-lost", "usage-ingest-lease-busy"])("%s becomes a healthy follower without failing backfill", async code => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  f.worker.emit("message", snapshot);
  f.worker.emit("message", { type: "error", code });
  const state = f.runtime.snapshot();
  expect(state).toMatchObject({ backfill: "complete", errorCode: null, ingestRole: "follower" });
  const report = usageDoctorLines(state, { calibration: "auto", footer: true, counterPoll: true, alertsSessionCredits: 0, alertsRunCredits: 0 });
  expect(report.ok).toBe(true);
  expect(report.lines.join("\n")).toContain("ingest: follower (another pi session owns ingestion)");
});
it("an ingest exception fails backfill with its distinct code", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  f.worker.emit("message", snapshot); f.worker.emit("message", { type: "error", code: "usage-ingest-failed" });
  expect(f.runtime.snapshot()).toMatchObject({ backfill: "failed", errorCode: "usage-ingest-failed" });
  expect(usageDoctorLines(f.runtime.snapshot(), { calibration: "auto", footer: true, counterPoll: true, alertsSessionCredits: 0, alertsRunCredits: 0 }).ok).toBe(false);
});

it("calibration DTO preserves old snapshots and reloads", async () => {
  const f = fixture(); f.runtime.start(false, "auto"); await vi.advanceTimersByTimeAsync(0);
  expect((f.factory.mock.calls[0] as unknown as [URL, any])[1].workerData.command.calibration).toBe("auto");
  f.worker.emit("message", snapshot);
  expect(f.runtime.snapshot().calibration).toMatchObject({ status: "uncalibrated", factor: null });
  const calibration = { status: "calibrated", factor: 0.56, windowStart: 0, windowEnd: 86400000, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 0, method: "trailing-7d-ratio" };
  f.worker.emit("message", { ...snapshot, calibration });
  expect(f.runtime.snapshot().calibration).toEqual(calibration);
  f.runtime.configure(false, "off");
  expect(f.worker.commands.at(-1)).toMatchObject({ type: "configure", poll: false, calibration: "off" });
  expect(f.runtime.snapshot()).toMatchObject({ health: { calls: 3 }, calibration: { status: "off", factor: null } });
  f.runtime.configure(false, "auto");
  expect(f.runtime.snapshot()).toMatchObject({ health: { calls: 3 }, calibration: { status: "uncalibrated" } });
  f.worker.emit("message", { ...snapshot, calibration });
  expect(f.runtime.snapshot().calibration?.factor).toBe(0.56);
});

it("unchanged calibration keeps legacy poll-only configure DTO", async () => {
  const f = fixture(); f.runtime.start(true, "auto"); await vi.advanceTimersByTimeAsync(0);
  f.runtime.configure(false, "auto");
  expect(f.worker.commands.at(-1)).toEqual({ type: "configure", poll: false });
  f.runtime.configure(false, "off");
  expect(f.worker.commands.at(-1)).toEqual({ type: "configure", poll: false, calibration: "off" });
  f.runtime.configure(true, "off");
  expect(f.worker.commands.at(-1)).toEqual({ type: "configure", poll: true });
});

it("runtime snapshot enforces off after a calibrated worker event", async () => {
  const f = fixture(); f.runtime.start(false, "off"); await vi.advanceTimersByTimeAsync(0);
  f.worker.emit("message", { ...snapshot, calibration: { status: "calibrated", factor: 0.56 } });
  expect(f.runtime.snapshot().calibration).toMatchObject({ status: "off", factor: null });
});

it("standby acknowledges refresh without discarding calibration or failure", async () => {
  const f = fixture(); f.runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  const calibration = { status: "calibrated", factor: 0.56, windowStart: 0, windowEnd: 86400000, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 0, method: "trailing-7d-ratio" };
  f.worker.emit("message", { ...snapshot, calibration });
  f.runtime.refresh(); f.worker.emit("message", { type: "error", code: "usage-ingest-failed" });
  f.worker.emit("message", { type: "standby" });
  expect(f.runtime.snapshot()).toMatchObject({ ingestRole: "standby", errorCode: "usage-ingest-failed", calibration });
  f.runtime.refresh(); expect(f.worker.commands.filter((command: any) => command.type === "refresh")).toHaveLength(2);
});

it("dashboard runtime disables polling on every command", async () => {
  const f = fixture({ dashboardMode: true }); f.runtime.start(true, "auto");
  await vi.advanceTimersByTimeAsync(0);
  expect((f.factory.mock.calls[0] as unknown as [URL, any])[1].workerData.command).toMatchObject({ dashboardMode: true, poll: false, calibration: "auto" });
  f.runtime.configure(true, "off");
  expect(f.worker.commands.at(-1)).toEqual({ type: "configure", poll: false, calibration: "off" });
});
