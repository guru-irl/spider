import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Worker, type MessagePort, type WorkerOptions } from "node:worker_threads";
import { afterAll, beforeAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as runtimeModule from "../runtime.js";
import { startUsageServerIngest } from "../server-ingest.js";
import { UsageRuntime, type UsageWorker } from "../runtime.js";
import { bootUsageWorker, type UsageWorkerDependencies } from "../worker-entry.js";
import * as leaseModule from "../lease.js";
import { UsageLeaseError } from "../lease.js";
import { openUsageLedger } from "../ledger.js";
import * as ledgerModule from "../ledger.js";
import { openDb } from "@spider/db-core";
import { ingestOnce } from "../ingest.js";
import * as credential from "../credential.js";
import { CounterPoller } from "../counter.js";
import * as dbModule from "@spider/db-core";
import type { UsageWorkerCommand, UsageWorkerEvent } from "../protocol.js";

class Port extends EventEmitter {
  events: UsageWorkerEvent[] = [];
  closed = false;
  postMessage(event: UsageWorkerEvent) { this.events.push(event); }
  close() { this.closed = true; }
}
const at = Date.parse("2026-10-04T12:00:00Z");
let root: string;
let ports: Port[];
let runtimes: UsageRuntime[];
let releases: (() => void)[];
const children = new Set<ChildProcess>();
let buildRoot: string, fixtureBundle: string;
beforeAll(async () => {
  const scratch = resolve(".spider/scratch"); mkdirSync(scratch, { recursive: true });
  buildRoot = mkdtempSync(join(scratch, "dashboard-ingest-build-"));
  fixtureBundle = join(buildRoot, "extension.js");
  await promisify(execFile)(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "build", "--ssr",
    fileURLToPath(new URL("./fixtures/dashboard-ingest.mjs", import.meta.url)), "--outDir", buildRoot],
    { timeout: 60000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
}, 90000);
afterAll(() => { if (buildRoot) rmSync(buildRoot, { recursive: true, force: true }); });
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "server-ingest-"));
  ports = []; runtimes = []; releases = [];
  vi.useFakeTimers(); vi.setSystemTime(at);
});
afterEach(async () => {
  try {
    for (const release of releases) release();
    for (const port of ports) port.emit("message", { type: "stop" });
    const stops = runtimes.map(runtime => runtime.stop());
    await vi.advanceTimersByTimeAsync(2000); await Promise.all(stops);
    await vi.waitFor(() => expect(ports.every(port => port.closed)).toBe(true));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGKILL"); await exited;
      }
    }
    children.clear();
    vi.restoreAllMocks(); vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});
function command(dashboardMode = true, poll = true): Extract<UsageWorkerCommand, { type: "start" }> {
  return { type: "start", owner: `${process.pid}:${ports.length}`, child: false, poll, dashboardMode,
    roots: { registryDb: join(root, "missing-registry.db"), sessionsDir: join(root, "sessions"), ledgerFile: join(root, "usage.db"), authPath: join(root, "auth.json"), leaseDir: join(root, "leases") } };
}
async function boot(dashboardMode = true, dependencies: UsageWorkerDependencies = {}, poll = true) {
  const port = new Port(); ports.push(port);
  const start = command(dashboardMode, poll);
  await bootUsageWorker(port as unknown as MessagePort, start, {
    discover: async () => ({ sources: [], runs: [], errors: [] }), ...dependencies,
  });
  return { port, start };
}
function snapshots(port: Port) { return port.events.filter(event => event.type === "snapshot"); }
function inspect(name = "ingest") {
  const ledger = openUsageLedger(command().roots.ledgerFile);
  try { return ledger.leases.inspect(name, Date.now()); } finally { ledger.close(); }
}

// Removing the dashboard-mode override would read auth and claim the counter lease.
it("server worker always disables polling", async () => {
  writeFileSync(command().roots.authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "synthetic-token", access: "synthetic-access", expires: 0 } }));
  const auth = vi.spyOn(credential, "readCopilotOAuthToken");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { credits_used: 10 } } })));
  const { port } = await boot(true, { fetch });
  await vi.advanceTimersByTimeAsync(0);
  port.emit("message", { type: "configure", poll: true, calibration: "off" });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(auth).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(inspect("counter").owner).toBeNull(); expect(inspect("counter").nextDueAt).toBeNull();
  expect(snapshots(port).at(-1)?.counter.availability).toBe("disabled");
  expect(snapshots(port).at(-1)?.calibration?.status).toBe("off");
});

// A missing finally release strands pi after either an import or discovery failure.
it("server never holds ingest across passes", async () => {
  for (const outcome of ["success", "ingest-failure", "discovery-failure"] as const) {
    let passes = 0;
    const { port, start } = await boot(true, {
      discover: async () => {
        if (outcome === "discovery-failure") { passes++; throw new Error("synthetic discovery failure"); }
        return { sources: [], runs: [], errors: [] };
      },
      ingest: async (...args) => {
        passes++;
        expect(inspect().owner).toBe(start.owner);
        if (outcome === "ingest-failure") throw new Error("synthetic import failure");
        return ingestOnce(...args);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(1);
    expect(inspect().owner).toBeNull();
    expect(port.events.at(-1)).toEqual({ type: "standby" });
    if (outcome !== "success") expect(port.events).toContainEqual({ type: "error", code: "usage-ingest-failed" });
    port.emit("message", { type: "refresh" });
    port.emit("message", { type: "configure", poll: true });
    await vi.advanceTimersByTimeAsync(9999);
    expect(passes).toBe(1); expect(inspect().owner).toBeNull();
    port.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
  }
});

// The factory replaces only worker transport; the real worker and ledger run.
function runtimeWorker(dependencies: UsageWorkerDependencies) {
  return (_entry: URL, options: WorkerOptions) => {
    const transport = new EventEmitter();
    const port = new Port(); ports.push(port);
    port.postMessage = event => { port.events.push(event); transport.emit("message", event); };
    void bootUsageWorker(port as unknown as MessagePort, options.workerData.command, {
      discover: async () => ({ sources: [], runs: [], errors: [] }), ...dependencies,
    });
    return Object.assign(transport, {
      postMessage: (message: UsageWorkerCommand) => port.emit("message", message),
      unref() {}, terminate: async () => { port.emit("message", { type: "stop" }); return 0; },
    }) as unknown as UsageWorker;
  };
}
async function handback(poll: boolean) {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  const path = join(root, "one-call.jsonl");
  writeFileSync(path, JSON.stringify({ type: "message", id: "one", timestamp: new Date(at).toISOString(), message: {
    role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
  } }) + "\n");
  const discovery = { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] };
  let imports = 0, active = 0, peak = 0;
  const importTimes: number[] = [];
  const ingest = async (...args: Parameters<typeof ingestOnce>) => {
    imports++; importTimes.push(Date.now()); active++; peak = Math.max(peak, active);
    if (imports === 1) await blocked;
    try { return await ingestOnce(...args); } finally { active--; }
  };
  let completedAt: number | undefined;
  const server = new UsageRuntime({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots,
    onSnapshot: snapshot => { if (snapshot.ingestRole === "standby") completedAt ??= Date.now(); },
    child: false, dashboardMode: true, workerFactory: runtimeWorker({ discover: async () => discovery, ingest }) });
  runtimes.push(server); server.start(false, "auto");
  await vi.advanceTimersByTimeAsync(1);
  expect(imports).toBe(1);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { credits_used: 10 } } })));
  writeFileSync(command().roots.authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "synthetic-token", access: "synthetic-access", expires: 0 } }));
  const pi = await boot(false, { discover: async () => discovery, ingest, fetch }, poll);
  await vi.advanceTimersByTimeAsync(4500);
  expect(snapshots(pi.port).at(-1)?.ingestRole).toBe("follower");
  expect(fetch).not.toHaveBeenCalled(); expect(inspect("counter").owner).toBeNull();
  release();
  await vi.waitFor(() => expect(server.snapshot().ingestRole).toBe("standby"));
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(snapshots(pi.port).at(-1)?.ingestRole).toBe("owner"));
  return { pi, server, fetch, completedAt: completedAt!, ownerAt: importTimes[1], imports, peak };
}

// Omitting runtime's dashboard start flag leaves the server sticky and pi following.
it("running pi reacquires within one pass plus three seconds", async () => {
  const { pi, server, completedAt, ownerAt, imports, peak } = await handback(false);
  expect(snapshots(pi.port).at(-1)?.ingestRole).toBe("owner");
  expect(inspect().owner).toBe(pi.start.owner);
  expect(ownerAt - completedAt).toBeLessThanOrEqual(3000);
  expect(imports).toBe(2); expect(peak).toBe(1);
  expect(snapshots(pi.port).at(-1)?.health.calls).toBe(1);
  expect(server.snapshot().ingestRole).toBe("standby");
});

// A counter left read-only after handback cannot append the synthetic response.
it("handback restores pi counter polling", async () => {
  const { pi, server, fetch } = await handback(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(server.snapshot().counter?.availability).toBe("disabled");
  const ledger = openUsageLedger(pi.start.roots.ledgerFile);
  try { await vi.waitFor(() => expect(ledger.latestCounter()?.creditsUsed).toBe(10)); } finally { ledger.close(); }
  pi.port.emit("message", { type: "refresh" });
  await vi.waitFor(() => expect(snapshots(pi.port).at(-1)).toMatchObject({ ingestRole: "owner", counter: { role: "owner", availability: "available", latest: { creditsUsed: 10 } } }));
});

// Using the ten-second ownership backoff as discovery cadence imports too often.
it("unattended ingestion keeps minute cadence", async () => {
  const starts: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  const { port } = await boot(true, { ingest: async (...args) => {
    starts.push(Date.now());
    if (starts.length === 1) await blocked;
    return ingestOnce(...args);
  } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000); release(); await vi.advanceTimersByTimeAsync(0);
  const completedAt = Date.now();
  expect(inspect().owner).toBeNull();
  for (let i = 0; i < 59; i++) {
    port.emit("message", { type: "refresh" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toHaveLength(1); expect(inspect().owner).toBeNull();
  }
  await vi.advanceTimersByTimeAsync(4000);
  expect(starts).toHaveLength(2);
  expect(starts[1] - completedAt).toBeGreaterThanOrEqual(60000);
  expect(starts[1] - completedAt).toBeLessThanOrEqual(63000);
  expect(inspect().owner).toBeNull();
});

// A minute gate must not defer takeover once the observed pi participant leaves.
it("server takes over after pi stops or dies", async () => {
  for (const mode of ["stop", "SIGKILL"] as const) {
    let passes = 0;
    const server = await boot(true, { ingest: async (...args) => { passes++; return ingestOnce(...args); } });
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(1);
    if (mode === "stop") {
      const pi = await boot(false, {}, false);
      await vi.advanceTimersByTimeAsync(10000);
      expect(snapshots(server.port).at(-1)?.ingestRole).toBe("follower");
      pi.port.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
    } else {
      mkdirSync(command().roots.sessionsDir, { recursive: true });
      const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "pi-agent") };
      const child = spawn(process.execPath, [fixtureBundle, "fixture-pi", root], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.add(child);
      await new Promise<void>((resolve, reject) => {
        child.on("message", (snapshot: any) => { if (snapshot.ingestRole === "owner" && snapshot.backfill === "complete") resolve(); });
        child.once("error", reject); child.once("exit", () => reject(new Error("fixture exited before ownership")));
      });
      expect(inspect().owner).toMatch(new RegExp(`^${child.pid}:`));
      await vi.advanceTimersByTimeAsync(10000);
      expect(snapshots(server.port).at(-1)?.ingestRole).toBe("follower");
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
      expect(inspect().role).toBe("expired"); // The 120 s TTL has not elapsed.
    }
    const departedAt = Date.now();
    await vi.advanceTimersByTimeAsync(3000);
    expect(passes).toBe(2); expect(Date.now() - departedAt).toBe(3000);
    expect(inspect().owner).toBeNull();
    expect(server.port.events.at(-1)).toEqual({ type: "standby" });
    server.port.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
  }
});

it("server releases its fenced lease even after a busy transition", async () => {
  const { port } = await boot(true, { ingest: async () => { throw new UsageLeaseError("lease-busy"); } });
  await vi.advanceTimersByTimeAsync(0);
  expect(port.events).toContainEqual({ type: "error", code: "usage-ingest-lease-busy" });
  expect(inspect().owner).toBeNull();
  expect(port.events.at(-1)).toEqual({ type: "standby" });
});

it("participant handle reports standby and closes its worker once", async () => {
  const RealRuntime = UsageRuntime;
  const path = join(root, "session.jsonl"); writeFileSync(path, JSON.stringify({ type: "session", id: "synthetic-session" }) + "\n");
  vi.spyOn(runtimeModule, "UsageRuntime").mockImplementation(function(options) {
    const runtime = new RealRuntime({ ...options, workerFactory: runtimeWorker({ discover: async () => ({ sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] }) }) });
    runtimes.push(runtime); return runtime;
  });
  const changes: unknown[] = [];
  const handle = startUsageServerIngest({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots,
    getCalibrationMode: () => "auto", onSnapshot: state => changes.push(state) });
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(handle.snapshot()).toMatchObject({ role: "standby", backfill: "complete", lastIngestAt: at + 1, errorCode: null }));
  expect(changes.at(-1)).toMatchObject({ role: "standby" });
  expect(inspect().owner).toBeNull(); expect(inspect("counter").owner).toBeNull();
  const snapshot = handle.snapshot(); snapshot.role = "owner";
  expect(handle.snapshot().role).toBe("standby");
  const first = handle.stop(), second = handle.stop();
  expect(first).toBe(second); await vi.advanceTimersByTimeAsync(0); await first;
  expect(handle.snapshot().role).toBe("inactive");
});

it("unobserved clean pi departure keeps the sixty second cadence", async () => {
  const starts: number[] = [];
  const server = await boot(true, { ingest: async (...args) => { starts.push(Date.now()); return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  const pi = await boot(false, {}, false); await vi.advanceTimersByTimeAsync(0);
  expect(inspect().owner).toBe(pi.start.owner);
  pi.port.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
  expect(inspect().owner).toBeNull();
  // Both lease transitions occurred during the server's ten-second backoff.
  expect(server.port.events.at(-1)).toEqual({ type: "standby" });
  await vi.advanceTimersByTimeAsync(58999);
  expect(starts).toEqual([at]); expect(inspect().owner).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(starts).toEqual([at, at + 60000]); expect(inspect().owner).toBeNull();
});

it("a busy initial renewal still releases the dashboard lease", async () => {
  const acquire = leaseModule.acquireUsageLease;
  vi.spyOn(leaseModule, "acquireUsageLease").mockImplementation((...args) => {
    const lease = acquire(...args);
    if (lease && args[1] === "ingest") {
      vi.spyOn(lease, "renew").mockImplementationOnce(() => { throw new UsageLeaseError("lease-busy"); });
    }
    return lease;
  });
  const { port } = await boot(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(port.events).toContainEqual({ type: "error", code: "usage-ingest-lease-busy" });
  expect(inspect().owner).toBeNull();
  expect(port.events.at(-1)).toEqual({ type: "standby" });
});

// Ported from the review's X1: dropping the failed release loses prompt handback.
it("failed dashboard release retries next tick without skipping minute cadence", async () => {
  const acquire = leaseModule.acquireUsageLease;
  let armed = true;
  vi.spyOn(leaseModule, "acquireUsageLease").mockImplementation((...args) => {
    const lease = acquire(...args);
    if (lease && args[1] === "ingest" && armed) {
      armed = false;
      vi.spyOn(lease, "release").mockImplementationOnce(() => { throw new UsageLeaseError("lease-busy"); });
    }
    return lease;
  });
  let passes = 0;
  const server = await boot(true, { ingest: async (...args) => { passes++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  expect(server.port.events).toContainEqual({ type: "error", code: "usage-ingest-lease-busy" });
  expect(server.port.events).not.toContainEqual({ type: "error", code: "usage-ledger-unavailable" });
  expect(server.port.events.at(-1)).toEqual({ type: "standby" });
  expect(inspect().owner).toBe(server.start.owner);
  const pi = await boot(false, {}, false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(inspect().owner).toBe(pi.start.owner);
  pi.port.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(56999);
  expect(passes).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(passes).toBe(2);
});

// X2 plus the forward step: Date.now must not control elapsed-time gates.
it.each([-3600000, 3600000])("wall-clock step %i preserves ten second and minute gates", async step => {
  let passes = 0;
  const server = await boot(true, { ingest: async (...args) => { passes++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + step);
  server.port.emit("message", { type: "refresh" });
  await vi.advanceTimersByTimeAsync(9999);
  expect(server.port.events.at(-1)).toEqual({ type: "standby" });
  expect(passes).toBe(1);
  await vi.advanceTimersByTimeAsync(50000);
  expect(passes).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(passes).toBe(2);
});

function armBusyOpen() {
  const real = ledgerModule.openUsageLedger;
  const state = { armed: false, thrown: 0 };
  vi.spyOn(ledgerModule, "openUsageLedger").mockImplementation(file => {
    if (state.armed) {
      state.armed = false; state.thrown++;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return real(file);
  });
  return state;
}
// X4: a closed read-only reference must not survive a failed writable reopen.
it("dashboard recovers on the next cycle after a busy writable open", async () => {
  const busy = armBusyOpen(); let passes = 0;
  const server = await boot(true, { ingest: async (...args) => { passes++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0); busy.armed = true;
  await vi.advanceTimersByTimeAsync(60000);
  expect(passes).toBe(1); expect(busy.thrown).toBe(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(passes).toBe(2);
  expect(server.port.events.filter(e => e.type === "error")).toHaveLength(1);
});
// X5: the same reopen defect can strand a pi follower at handback.
it("pi follower recovers next cycle after a busy writable handback open", async () => {
  const busy = armBusyOpen();
  let release!: () => void; const blocked = new Promise<void>(r => { release = r; }); releases.push(release);
  await boot(true, { discover: async () => { await blocked; return { sources: [], runs: [], errors: [] }; } });
  await vi.advanceTimersByTimeAsync(0);
  const pi = await boot(false, {}, false); await vi.advanceTimersByTimeAsync(3000);
  busy.armed = true; release(); await vi.advanceTimersByTimeAsync(3000);
  expect(busy.thrown).toBe(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(inspect().owner).toBe(pi.start.owner);
  expect(snapshots(pi.port).at(-1)?.ingestRole).toBe("owner");
  expect(pi.port.events.filter(e => e.type === "error")).toHaveLength(1);
});

// The audit also covers failures from close itself, not only open.
it.each([true, false])("participant dashboard=%s recovers after close throws", async dashboard => {
  const real = ledgerModule.openUsageLedgerReadOnly;
  let armed = false;
  vi.spyOn(ledgerModule, "openUsageLedgerReadOnly").mockImplementation(file => {
    const ledger = real(file);
    if (ledger) {
      const close = ledger.close.bind(ledger);
      vi.spyOn(ledger, "close").mockImplementation(() => {
        close();
        if (armed) { armed = false; throw new Error("synthetic close failure"); }
      });
    }
    return ledger;
  });
  let release!: () => void; const blocked = new Promise<void>(r => { release = r; }); releases.push(release);
  const server = await boot(true, dashboard ? {} : { discover: async () => { await blocked; return { sources: [], runs: [], errors: [] }; } }); await vi.advanceTimersByTimeAsync(0);
  if (dashboard) {
    armed = true; await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(server.port.events.at(-1)).toEqual({ type: "standby" });
  } else {
    const pi = await boot(false, {}, false);
    armed = true; release(); await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(inspect().owner).toBe(pi.start.owner);
  }
});

it.each([true, false])("initial busy open dashboard=%s retries instead of stopping", async dashboard => {
  const busy = armBusyOpen(); busy.armed = true;
  const participant = await boot(dashboard, {}, false);
  expect(participant.port.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(snapshots(participant.port).at(-1)?.ingestRole).toBe("owner");
});

// Pins all three non-equivalent survivors, independently of the minute gate.
it("standby publishes standby role on a read-only connection after the ten second silence", async () => {
  const real = ledgerModule.openUsageLedgerReadOnly;
  const readers: ReturnType<typeof real>[] = [];
  vi.spyOn(ledgerModule, "openUsageLedgerReadOnly").mockImplementation(file => {
    const ledger = real(file); if (ledger) readers.push(ledger); return ledger;
  });
  const server = await boot(true); await vi.advanceTimersByTimeAsync(0);
  const count = snapshots(server.port).length;
  server.port.emit("message", { type: "refresh" });
  server.port.emit("message", { type: "configure", poll: true, calibration: "off" });
  await vi.advanceTimersByTimeAsync(9999);
  expect(snapshots(server.port)).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(snapshots(server.port).at(-1)).toMatchObject({ ingestRole: "standby", calibration: { status: "off" } });
  const reader = readers.at(-1)!;
  expect(() => reader.apply({ calls: [], runs: [], states: [], resetSources: [], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at, backfillState: "complete" })).toThrow(/readonly/i);
});

it("server calibration getter follows reloads and off reaches the shared DTO", async () => {
  const RealRuntime = UsageRuntime;
  vi.spyOn(runtimeModule, "UsageRuntime").mockImplementation(function(options) {
    const runtime = new RealRuntime({ ...options, workerFactory: runtimeWorker({}) });
    runtimes.push(runtime); return runtime;
  });
  let mode: "auto" | "off" = "off";
  const handle = startUsageServerIngest({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots,
    getCalibrationMode: () => mode });
  await vi.advanceTimersByTimeAsync(1);
  const dto = () => { const ledger = openUsageLedger(command().roots.ledgerFile); try { return ledger.getPublishedSnapshot()?.calibration; } finally { ledger.close(); } };
  expect(dto()).toMatchObject({ status: "off", factor: null });
  mode = "auto"; await vi.advanceTimersByTimeAsync(63000);
  expect(dto()?.status).not.toBe("off");
  mode = "off"; await vi.advanceTimersByTimeAsync(63000);
  expect(dto()).toMatchObject({ status: "off", factor: null });
  const stopped = handle.stop(); await vi.advanceTimersByTimeAsync(0); await stopped;
});

it("forced stop of a stuck server pass lets pi acquire within three seconds", async () => {
  const runtime = new UsageRuntime({ bundleUrl: new URL(`file://${fixtureBundle}`), roots: command().roots, child: false, dashboardMode: true,
    workerFactory: (entry, options) => new Worker(entry, { ...options, workerData: { ...options.workerData, fixtureStuck: true } }) });
  runtimes.push(runtime); runtime.start(false, "off");
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(runtime.snapshot().ingestRole).toBe("owner"));
  const pi = await boot(false, {}, false);
  const stopped = runtime.stop(); await vi.advanceTimersByTimeAsync(2000); await stopped;
  await vi.advanceTimersByTimeAsync(3000);
  expect(inspect().owner).toBe(pi.start.owner);
});

it.each(["successor", "foreign-host", "foreign-pid"])("forced-stop cleanup preserves %s identity", async identity => {
  let owner!: string;
  const ledger = openUsageLedger(command().roots.ledgerFile);
  const transport = new EventEmitter();
  const runtime = new UsageRuntime({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots, child: false, dashboardMode: true,
    workerFactory: (_entry, options) => {
      owner = options.workerData.command.owner;
      ledger.leases.acquire("ingest", owner, Date.now, 120000);
      return Object.assign(transport, { postMessage() {}, unref() {}, terminate: async () => {
        const db = openDb(command().roots.ledgerFile);
        try {
          if (identity === "successor") db.prepare("UPDATE leases SET owner=? WHERE name='ingest'").run(`${process.pid}:successor`);
          else if (identity === "foreign-host") db.prepare("UPDATE leases SET owner_host='synthetic-other-host' WHERE name='ingest'").run();
          else db.prepare("UPDATE leases SET owner_pid=1 WHERE name='ingest'").run();
        } finally { db.close(); }
        return 0;
      } }) as unknown as UsageWorker;
    } });
  runtimes.push(runtime);
  try {
    runtime.start(false); await vi.advanceTimersByTimeAsync(0);
    const stopped = runtime.stop(); await vi.advanceTimersByTimeAsync(2000); await stopped;
    expect(inspect().owner).toBe(identity === "successor" ? `${process.pid}:successor` : owner);
  } finally { ledger.close(); }
});

// A failed standby opener must not turn the next observation into an early pass.
it("failed read-only standby reopen retries without losing the minute deadline", async () => {
  const real = ledgerModule.openUsageLedgerReadOnly;
  let opens = 0, passes = 0;
  vi.spyOn(ledgerModule, "openUsageLedgerReadOnly").mockImplementation(file => {
    if (++opens === 2) throw Object.assign(new Error("synthetic readonly open busy"), { code: "SQLITE_BUSY" });
    return real(file);
  });
  await boot(true, { ingest: async (...args) => { passes++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(59999);
  expect(passes).toBe(1); expect(inspect().owner).toBeNull();
  await vi.advanceTimersByTimeAsync(1); expect(passes).toBe(2);
});

it("failed writable close after a pass retains no closed handle or early acquisition", async () => {
  const real = ledgerModule.openUsageLedger;
  let armed = true, passes = 0;
  vi.spyOn(ledgerModule, "openUsageLedger").mockImplementation(file => {
    const ledger = real(file), close = ledger.close.bind(ledger);
    vi.spyOn(ledger, "close").mockImplementation(() => {
      close(); if (armed) { armed = false; throw new Error("synthetic writable close failure"); }
    });
    return ledger;
  });
  const server = await boot(true, { ingest: async (...args) => { passes++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(59999);
  expect(passes).toBe(1);
  await vi.advanceTimersByTimeAsync(1); expect(passes).toBe(2);
  expect(server.port.events.filter(e => e.type === "error")).toHaveLength(1);
});

it("pi forced stop never opens the ledger on the main thread", async () => {
  const ledger = openUsageLedger(command().roots.ledgerFile);
  const transport = new EventEmitter();
  const runtime = new UsageRuntime({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots, child: false,
    workerFactory: (_entry, options) => {
      const owner = options.workerData.command.owner;
      ledger.leases.acquire("ingest", owner, Date.now, 120000);
      const counter = ledger.leases.acquire("counter", owner, Date.now, 120000)!;
      counter.claimPoll(Date.now, 600000);
      return Object.assign(transport, { postMessage() {}, unref() {}, terminate: async () => 0 }) as unknown as UsageWorker;
    } });
  runtimes.push(runtime);
  try {
    runtime.start(false); await vi.advanceTimersByTimeAsync(0);
    const dbOpen = vi.spyOn(dbModule, "openDb");
    const stopped = runtime.stop(); await vi.advanceTimersByTimeAsync(2000); await stopped;
    expect(dbOpen).not.toHaveBeenCalled();
    expect(inspect().owner).not.toBeNull();
    expect(inspect("counter").nextDueAt).toBe(at + 600000);
  } finally { ledger.close(); }
});

// Review X6: retain the newly acquired fence before the first fallible renew.
it("X6 dashboard lease acquired by in-cycle open() survives a busy renew", async () => {
  const realOpen = ledgerModule.openUsageLedger;
  let busyOpen = false;
  vi.spyOn(ledgerModule, "openUsageLedger").mockImplementation(file => {
    if (busyOpen) { busyOpen = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
    return realOpen(file);
  });
  const acquire = leaseModule.acquireUsageLease;
  let busyRenew = false;
  vi.spyOn(leaseModule, "acquireUsageLease").mockImplementation((...args) => {
    const lease = acquire(...args);
    if (lease && args[1] === "ingest" && busyRenew) {
      busyRenew = false;
      vi.spyOn(lease, "renew").mockImplementationOnce(() => { throw new UsageLeaseError("lease-busy"); });
    }
    return lease;
  });
  let passes = 0;
  const server = await boot(true, { ingest: async (...args) => { passes++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  expect(passes).toBe(1); expect(inspect().owner).toBeNull();
  busyOpen = true;
  await vi.advanceTimersByTimeAsync(60000); // writable open busy at the minute deadline
  busyRenew = true;
  await vi.advanceTimersByTimeAsync(3000); // next cycle: open() acquires, then renew throws lease-busy
  const owner = inspect().owner;
  const pi = await boot(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(inspect().owner).toBe(pi.start.owner);
  expect(owner).toBeNull();
});

it("server fenced cleanup clears both identities but preserves durable lease diagnostics", async () => {
  const ledger = openUsageLedger(command().roots.ledgerFile);
  const transport = new EventEmitter();
  const runtime = new UsageRuntime({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots, child: false, dashboardMode: true,
    workerFactory: (_entry, options) => {
      const owner = options.workerData.command.owner;
      for (const name of ["ingest", "counter"]) {
        const lease = ledger.leases.acquire(name, owner, Date.now, 120000)!;
        lease.claimPoll(Date.now, 600000); lease.recordError(Date.now, "save-failed");
      }
      const db = openDb(command().roots.ledgerFile);
      try { db.prepare("UPDATE leases SET notice_code='clock-jump', notice_at=?").run(at); } finally { db.close(); }
      return Object.assign(transport, { postMessage() {}, unref() {}, terminate: async () => 0 }) as unknown as UsageWorker;
    } });
  runtimes.push(runtime);
  try {
    runtime.start(false); await vi.advanceTimersByTimeAsync(0);
    const stopped = runtime.stop(); await vi.advanceTimersByTimeAsync(2000); await stopped;
    for (const name of ["ingest", "counter"]) {
      expect(inspect(name)).toMatchObject({ owner: null, expiresAt: null, nextDueAt: at + 600000,
        lastErrorCode: "save-failed", notice: { code: "clock-jump", at } });
    }
    const db = openDb(command().roots.ledgerFile);
    try { expect(db.prepare("SELECT owner, token, acquired_at, expires_at, owner_pid, owner_host FROM leases").all())
      .toEqual(Array.from({ length: 2 }, () => ({ owner: null, token: null, acquired_at: null, expires_at: null, owner_pid: null, owner_host: null }))); }
    finally { db.close(); }
  } finally { ledger.close(); }
});

it("graceful stop retries a pending release before acknowledging success", async () => {
  const acquire = leaseModule.acquireUsageLease;
  vi.spyOn(leaseModule, "acquireUsageLease").mockImplementation((...args) => {
    const lease = acquire(...args);
    if (lease && args[1] === "ingest") vi.spyOn(lease, "release").mockImplementationOnce(() => { throw new UsageLeaseError("lease-busy"); });
    return lease;
  });
  const server = await boot(true); await vi.advanceTimersByTimeAsync(0);
  expect(inspect().owner).toBe(server.start.owner);
  server.port.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
  expect(inspect().owner).toBeNull();
  expect(server.port.events.at(-1)).toEqual({ type: "stopped", released: true });
});

it.each([true, false])("failed graceful release dashboard=%s uses server cleanup or pi TTL", async dashboardMode => {
  const acquire = leaseModule.acquireUsageLease;
  vi.spyOn(leaseModule, "acquireUsageLease").mockImplementation((...args) => {
    const lease = acquire(...args);
    if (lease && args[1] === "ingest") vi.spyOn(lease, "release").mockImplementation(() => { throw new UsageLeaseError("lease-busy"); });
    return lease;
  });
  const runtime = new UsageRuntime({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots, child: false, dashboardMode,
    workerFactory: runtimeWorker({}) }); runtimes.push(runtime);
  runtime.start(false); await vi.advanceTimersByTimeAsync(0);
  const owner = inspect().owner; expect(owner).not.toBeNull();
  const stopped = runtime.stop(); await vi.advanceTimersByTimeAsync(0); await stopped;
  expect(ports.at(-1)!.events.at(-1)).toEqual({ type: "stopped", released: false });
  expect(inspect().owner).toBe(dashboardMode ? null : owner);
  if (!dashboardMode) { await vi.advanceTimersByTimeAsync(120000); expect(inspect().role).toBe("expired"); }
});

it("retried release storage failure reports the fixed storage code", async () => {
  const acquire = leaseModule.acquireUsageLease;
  vi.spyOn(leaseModule, "acquireUsageLease").mockImplementation((...args) => {
    const lease = acquire(...args);
    if (lease && args[1] === "ingest") vi.spyOn(lease, "release")
      .mockImplementationOnce(() => { throw new UsageLeaseError("lease-busy"); })
      .mockImplementationOnce(() => { throw new UsageLeaseError("lease-storage"); });
    return lease;
  });
  const server = await boot(true); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  expect(server.port.events).toContainEqual({ type: "error", code: "usage-ingest-failed" });
  await vi.advanceTimersByTimeAsync(3000); expect(inspect().owner).toBeNull();
});

it("counter poller is detached before its fallible stop", async () => {
  const realStop = CounterPoller.prototype.stop;
  let first: CounterPoller | undefined;
  let firstStops = 0;
  vi.spyOn(CounterPoller.prototype, "stop").mockImplementation(async function(this: CounterPoller) {
    first ??= this;
    if (this === first) firstStops++;
    await realStop.call(this);
    if (firstStops === 1 && this === first) throw new Error("synthetic stop failure");
  });
  const server = await boot(true); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(firstStops).toBe(1);
  expect(server.port.events).toContainEqual({ type: "error", code: "usage-ledger-unavailable" });
});

it("throwing calibration reload keeps last good mode, records a fixed code, and stop clears its interval", async () => {
  const RealRuntime = UsageRuntime;
  vi.spyOn(runtimeModule, "UsageRuntime").mockImplementation(function(options) {
    const runtime = new RealRuntime({ ...options, workerFactory: runtimeWorker({}) }); runtimes.push(runtime); return runtime;
  });
  let throwing = false, reads = 0;
  const changes: any[] = [];
  const handle = startUsageServerIngest({ bundleUrl: "file:///fixture/worker.mjs", roots: command().roots,
    getCalibrationMode: () => { reads++; if (throwing) throw new Error("synthetic private detail"); return "off"; },
    onSnapshot: state => changes.push(state) });
  await vi.advanceTimersByTimeAsync(0); throwing = true;
  await vi.advanceTimersByTimeAsync(3000);
  expect(handle.snapshot().errorCode).toBe("usage-calibration-config-failed");
  expect(changes.at(-1).errorCode).toBe("usage-calibration-config-failed");
  await vi.advanceTimersByTimeAsync(60000);
  const ledger = openUsageLedger(command().roots.ledgerFile);
  try { expect(ledger.getPublishedSnapshot()?.calibration?.status).toBe("off"); } finally { ledger.close(); }
  const stopped = handle.stop(); await vi.advanceTimersByTimeAsync(0); await stopped;
  const before = reads; await vi.advanceTimersByTimeAsync(60000); expect(reads).toBe(before);
});

it.each(["transient", "future", "unsupported"])("first-open %s failures use exponential backoff capped at sixty seconds", async kind => {
  const attempts: number[] = [];
  const real = ledgerModule.openUsageLedgerReadOnly;
  let failing = true;
  vi.spyOn(ledgerModule, "openUsageLedgerReadOnly").mockImplementation(file => {
    attempts.push(Date.now() - at);
    if (failing) throw new Error(kind === "future" ? "Unsupported future usage schema 99; supported version is 2"
      : kind === "unsupported" ? "Unsupported usage schema 2 layout marker" : "synthetic transient open failure");
    return real(file);
  });
  const server = await boot(true, {}, false);
  await vi.advanceTimersByTimeAsync(250000);
  expect(attempts).toEqual(kind === "transient" ? [0, 3000, 9000, 21000, 45000, 93000, 153000, 213000] : [0, 60000, 120000, 180000, 240000]);
  failing = false; await vi.advanceTimersByTimeAsync(60000);
  expect(snapshots(server.port).at(-1)?.ingestRole).toBe("standby");
});
