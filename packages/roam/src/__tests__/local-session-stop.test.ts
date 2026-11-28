import { chmodSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { localEntries, writeLocal } from "@spider/db-core/roam/local-state";
import type { MachineId } from "@spider/db-core/roam/types";
import * as hc from "@spider/herdr/client/hc";
import { serveRelocateShutdown } from "../../../host/src/roam/relocate-control";
import { DEFAULT_LIMITS, disabledIntercom, type Operation } from "../contracts";
import { createHomeStore } from "../relocate/home";
import { createLocalIO, createLocalRuntime, type LocalIO } from "../relocate/local";
import { queueStopMode } from "../relocate/local-stop";
import { requestSessionControl, sessionControlPath } from "../session-socket";
import type { RelocateAdapterOptions, RelocateHome, RunningHome, SessionId, StoppedHome } from "../relocate/types";

const machine = "11111111-1111-4111-8111-111111111111" as MachineId;
const hub = "22222222-2222-4222-8222-222222222222" as MachineId;
const id = "session-to-stop" as SessionId;
const other = "session-to-keep" as SessionId;
const running: RunningHome = { sessionId: id, machineId: machine, epoch: 7, state: "running", destination: null, moveId: null, updatedAt: 7 };
const stopped: StoppedHome = { ...running, epoch: 8, state: "stopped", updatedAt: 8 };
const pid = 83001, child = 83002, otherSessionPid = 83003, unclassified = 83004;
const bootA = "f22f2604-548d-421d-b5cb-9f31d7b50bd1";
const bootB = "9556da36-1481-49f7-86c6-53bdcb282dd1";
const cleanup: Array<() => void> = [];
vi.mock("@spider/herdr/client/hc", { spy: true });
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(readyMs = 15_000) {
  const global = createReplica("global", machine), project = createReplica("worktree", machine);
  cleanup.push(global.close, project.close);
  const checkout = join(global.root, "checkout"), file = join(global.root, "session.jsonl"), key = project.storeKey;
  mkdirSync(checkout);
  writeFileSync(file, "", { mode: 0o600 });
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(checkout);
  writeLocal(global.db, "mapping-redirect", key, project.db.raw.name);
  recordLocation(global.db, { sessionId: id, stores: ["global", key], home: null, cwd: checkout, file });
  for (const session of [id, other]) {
    project.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(session);
    project.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,7,'active')").run(session);
  }
  const homes = createHomeStore({ db: global.db, hubMachineId: hub, localMachineId: machine });
  function replicate(home: RelocateHome | null) {
    global.db.prepare("DELETE FROM session_homes WHERE session_id=?").run(id);
    if (home) global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,state,destination,move_id,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(home.sessionId, home.machineId, home.epoch, home.state, home.destination, home.moveId, home.updatedAt);
  }
  replicate(running);
  let now = 0;
  const timers = new Map<() => void, number>();
  function advance(ms: number) {
    now += ms;
    for (const [fn, at] of timers) if (at <= now) { timers.delete(fn); fn(); }
  }
  const unused = (): never => { throw new Error("Unexpected unrelated effect"); };
  const journal = {} as RelocateAdapterOptions["journal"];
  const limits = { ...DEFAULT_LIMITS, readyMs };
  const git: RelocateAdapterOptions["git"] = { run: unused, journal, limits, scratch: global.root, worktreeCommand: null };
  const options: RelocateAdapterOptions = {
    root: global.root, globalDb: global.db, homes, journal, git, limits,
    config: { enabled: true, role: "box", machineId: machine, hubMachineId: hub, peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 120000, limits, intercom: disabledIntercom() },
    sync: { start: unused, stop: unused, sync: unused, barriers: unused },
    transport: { resolve: unused, bootstrapProbe: unused, exec: unused, run: unused, read: unused, write: unused },
    clock: { now: () => now, later(ms, fn) { timers.set(fn, now + ms); return () => { timers.delete(fn); }; } },
    workspaceImport: { ...git, resolveCommonRepository: unused, lastExportedSnapshot: unused, verifiedArtifactPath: unused },
  };
  const processes = new Map<number, { startIdentity: string; pi: boolean }>([[otherSessionPid, { startIdentity: "other-pi", pi: true }]]);
  const descendants = new Map<number, number[]>();
  const effects: Array<[number, "shutdown" | "SIGTERM" | "SIGKILL", number]> = [];
  let lock: Awaited<ReturnType<LocalIO["inspect"]>> = null;
  let terminals: Awaited<ReturnType<LocalIO["terminals"]>> = [];
  let lease: { pid: number; startIdentity: string; bootId?: string } | null = null;
  let boot = bootA;
  let fullCheckCount = 0;
  const behavior = {
    pause: async (_ms: number) => {},
    signal: async (_pid: number) => {},
    shutdown: async (_operation: Operation, _timeoutMs?: number): Promise<boolean> => true,
    launch: async (): Promise<{ terminal: string }> => { throw new Error("Lost launch reply"); },
  };
  const add = (pid: number, startIdentity: string, pi = true) => processes.set(pid, { startIdentity, pi });
  const label = (ownerPid = pid, epoch = 7, source = machine) => {
    terminals = [{ terminal: `pi-${ownerPid}`, state: "live", pid: ownerPid, owned: true,
      launch: { sessionId: id, machineId: source, epoch, cwd: checkout, file } }];
  };
  function owner(ownerPid = pid, birth = "pi-birth") {
    add(ownerPid, birth);
    lock = { identity: { pid: ownerPid, startIdentity: birth }, bootId: boot,
      pendingOperationId: null, pendingFile: null, pendingCoreId: null, operationId: null };
    lease = { pid: ownerPid, startIdentity: birth, bootId: boot };
    label(ownerPid);
  }
  function exit(ownerPid = pid) {
    processes.delete(ownerPid);
    if (lock?.identity.pid === ownerPid) lock = null;
    if (lease?.pid === ownerPid) lease = null;
    terminals = terminals.filter(t => t.pid !== ownerPid);
  }
  const io: LocalIO & { bootId(): Promise<string>; fileLease(file: string): Promise<typeof lease> } = {
    bootId: async () => boot,
    fileLease: async checked => { fullCheckCount++; expect(checked).toBe(file); return lease; },
    inspect: async () => lock,
    claimFree: async () => { lock = null; },
    probe: async pid => { const p = processes.get(pid); return p ? { kind: "live", ...p } : { kind: "absent" }; },
    tree: async root => {
      fullCheckCount++;
      return { groups: [], descendants: (descendants.get(root) ?? []).flatMap(pid => {
        const p = processes.get(pid);
        return p ? { pid, startIdentity: p.startIdentity, command: p.pi ? "pi" : "shell" } : [];
      }) };
    },
    groupBlockers: unused,
    writerBlockers: async (_id, _placement, requireCheckout) => {
      if (requireCheckout) unused();
      return [];
    },
    shutdown: async (operation, timeout) => { effects.push([now, "shutdown", Number((operation.args.owner as { pid?: number } | undefined)?.pid)]); return behavior.shutdown(operation, timeout); },
    signal: async (pid, signal) => { effects.push([now, signal, pid]); await behavior.signal(pid); },
    pause: async ms => { advance(ms); await behavior.pause(ms); },
    terminals: async () => terminals,
    launch: () => behavior.launch(),
  };
  const runtime = createLocalRuntime(options, io);
  const placement = { sessionId: id, machineId: machine, cwd: checkout, file, stores: ["global", key],
    repoKey: "fixture-repo", workspaceId: "fixture-workspace", repository: checkout, historyMachine: machine } as const;
  const run = (name: string, pid: number, birth: string, session = id, hostPid = 83001) => project.db.prepare(`INSERT INTO runs(id,agent,session_id,status,pid,pid_start_time,host_pid,origin_machine) VALUES (?,'test',?,'running',?,?,?,?)`)
    .run(name, session, pid, birth, hostPid, machine);
  return { runtime, options, io, effects, replicate, owner, exit, add, label, behavior, advance, descendants, placement, run,
    setLease: (value: typeof lease) => { lease = value; }, reboot: () => { boot = bootB; },
    advanceToNextTimer: () => advance(Math.min(...timers.values()) - now),
    fullCheckCount: () => fullCheckCount, clearCwd: () => rmdirSync(checkout),
    membership: (session = id) => project.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(session),
    runStatus: (name: string) => project.db.prepare("SELECT status FROM runs WHERE id=?").get(name),
  };
}

it("does not signal before the exact stopped replica is durable", async () => {
  const f = fixture(); f.owner();
  f.behavior.signal = async pid => f.exit(pid);
  const beforeReplica = await f.runtime.enforceStopped(stopped);
  expect(f.effects).toEqual([]);
  expect(beforeReplica).toMatchObject({ home: running, evidence: { kind: "pending" } });
  f.replicate(null);
  expect(await f.runtime.observeStopped(stopped)).toMatchObject({ home: null, bootId: bootA, evidence: { kind: "pending" } });
  f.replicate({ ...stopped, updatedAt: 80 });
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect(f.effects).toEqual([]);
  f.replicate(stopped);
  queueStopMode(f.options.globalDb, stopped, "hard");
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  expect(f.effects).toEqual([[0, "SIGKILL", pid]]);
});

it("a wedged shutdown socket costs at most five seconds", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  const root = resolve(".spider/scratch/s5w");
  const path = sessionControlPath(root, id), sockets = new Set<Socket>();
  mkdirSync(root, { mode: 0o700, recursive: true });
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const data = deferred<string>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", bytes => { input += bytes.toString(); if (input.endsWith("\n")) data.resolve(input); });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, done); });
  try {
    chmodSync(path, 0o600);
    const timeouts: Array<number | undefined> = [];
    f.behavior.shutdown = async (operation, timeoutMs) => {
      timeouts.push(timeoutMs);
      return (await requestSessionControl(root, operation, { timeoutMs })).code === 0;
    };
    f.behavior.pause = async () => { await data.promise; };
    f.behavior.signal = async target => { if (f.effects.at(-1)?.[1] === "SIGKILL") f.exit(target); };
    expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
    expect(timeouts).toEqual([5_000]);
    expect(f.effects).toEqual([[0, "shutdown", pid], [5_000, "SIGTERM", pid], [10_000, "SIGKILL", pid]]);
    expect(JSON.parse(await data.promise)).toMatchObject({ op: "shutdown", operation: { expectedEpoch: 8,
      args: { homeState: "stopped", sessionId: id, homeMachineId: machine, owner: { pid, startIdentity: "pi-birth", bootId: bootA } } } });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(done => server.close(() => done()));
  }
});

it("hard stop verifies absence, not signal delivery", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  f.add(child, "owned-child"); f.add(unclassified, "arbitrary-shell", false);
  f.run("owned-run", child, "owned-child"); f.run("other-run", otherSessionPid, "other-pi", other, otherSessionPid);
  const jobId = "20261128T000000Z-deadbeef", detachedJobPid = 83007, nestedJobPid = 83008;
  const jobDirectory = join(f.placement.cwd, ".spider", "scratch", "bg", jobId);
  mkdirSync(jobDirectory, { mode: 0o700, recursive: true });
  const manifest = { schema: 1, id: jobId, cwd: f.placement.cwd, ownerSessionId: id, argv: ["node"], windowsHide: true,
    startedAt: "2026-11-28T00:00:00.000Z" };
  writeFileSync(join(jobDirectory, "job.json"), JSON.stringify({ ...manifest, childPid: process.pid, supervisorPid: detachedJobPid }));
  f.add(detachedJobPid, "detached-job", false); f.add(nestedJobPid, "nested-job");
  // Even a matching local run birth is not authority inside a detached tree.
  f.run("detached-child-row", nestedJobPid, "nested-job", id, detachedJobPid);
  f.descendants.set(pid, [child, unclassified, detachedJobPid, nestedJobPid]);
  f.descendants.set(detachedJobPid, [nestedJobPid]);
  f.behavior.signal = async target => { if (target === pid) f.exit(pid); };
  queueStopMode(f.options.globalDb, stopped, "hard");
  queueStopMode(f.options.globalDb, stopped, "graceful");
  const whileChildSurvives = await f.runtime.enforceStopped(stopped);
  expect(whileChildSurvives.evidence.kind).toBe("pending");
  expect(f.effects).toEqual([[0, "SIGKILL", pid], [0, "SIGKILL", child]]);
  expect(f.runStatus("owned-run")).toEqual({ status: "running" });
  expect(f.membership()).toEqual({ state: "active", epoch: 7 });
  f.add(child, "replacement-not-the-run", false); f.exit(unclassified); f.exit(nestedJobPid);
  const restartedRuntime = createLocalRuntime(f.options, f.io);
  const whileJobSurvives = await restartedRuntime.enforceStopped(stopped);
  expect(whileJobSurvives.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "job", id: jobId }] });
  expect(f.runStatus("owned-run")).toEqual({ status: "cancelled" });
  f.exit(detachedJobPid);
  writeFileSync(join(jobDirectory, "exit.json"), JSON.stringify({ schema: 1, state: "exited", exitCode: 0, signal: null }));
  writeFileSync(join(jobDirectory, "job.json"), JSON.stringify(manifest));
  expect((await restartedRuntime.enforceStopped(stopped)).evidence).toEqual({ kind: "confirmed", owner: { pid, startIdentity: "pi-birth", bootId: bootA } });
  expect(f.membership()).toEqual({ state: "frozen", epoch: 8 });
  expect(f.membership(other)).toEqual({ state: "active", epoch: 7 });
  expect(f.runStatus("other-run")).toEqual({ status: "running" });
  expect(f.effects.map(effect => effect[2])).toEqual([pid, child]);
});

it("upgrades while shutdown is waiting without renewing a read-only observation", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  f.behavior.shutdown = async () => new Promise<boolean>(() => {});
  f.behavior.signal = async target => f.exit(target);
  f.behavior.pause = async () => {
    expect(await f.runtime.observeStopped(stopped)).toMatchObject({ observedAt: 0, evidence: { kind: "checking" } });
    queueStopMode(f.options.globalDb, stopped, "hard");
  };
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  expect(f.effects.map(effect => effect[1])).toEqual(["shutdown", "SIGKILL"]);
  expect(f.effects[1][0]).toBeLessThan(5_000);
});

it("an acknowledgement does not clear a surviving owner", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  const result = await f.runtime.enforceStopped(stopped);
  expect(result.evidence.kind).toBe("pending");
  expect(f.effects).toEqual([[0, "shutdown", pid], [5_000, "SIGTERM", pid], [10_000, "SIGKILL", pid]]);
  expect(f.membership()).toEqual({ state: "active", epoch: 7 });
  f.exit();
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
});

it("late terminals invalidate the cheap confirmation after a lost launch reply", async () => {
  const f = fixture();
  expect(await f.runtime.start(running, { ...f.placement, stores: [...f.placement.stores] })).toMatchObject({ ok: false, refusal: { code: "start-pending" } });
  f.replicate(stopped);
  const confirmed = await f.runtime.enforceStopped(stopped);
  expect(confirmed.evidence.kind).toBe("confirmed");
  const count = f.fullCheckCount();
  f.advance(300);
  expect(await f.runtime.enforceStopped(stopped)).toEqual(confirmed);
  expect(await f.runtime.observeStopped(stopped)).toEqual(confirmed);
  expect(f.fullCheckCount()).toBe(count);
  f.add(pid, "late-launch-pi"); f.label();
  expect(await f.runtime.observeStopped(stopped)).toMatchObject({ observedAt: 300, evidence: { kind: "pending" } });
  queueStopMode(f.options.globalDb, stopped, "hard");
  f.behavior.signal = async target => f.exit(target);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  expect(f.effects).toEqual([[300, "SIGKILL", pid]]);
  expect(f.fullCheckCount()).toBeGreaterThan(count);
});

it("does not signal a recycled PID even with the same birth value after reboot", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  f.add(child, "recycled-birth"); f.run("child-at-stop", child, "recycled-birth"); f.descendants.set(pid, [child]);
  queueStopMode(f.options.globalDb, stopped, "hard");
  f.behavior.signal = async target => { if (target === pid) f.exit(pid); };
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect(f.effects.map(e => e[2])).toContain(child);
  f.effects.length = 0;
  f.reboot(); f.add(child, "recycled-birth", false);
  expect((await createLocalRuntime(f.options, f.io).enforceStopped(stopped)).bootId).toBe(bootB);
  expect(f.effects.map(e => e[2])).not.toContain(child);
  f.add(child, "independent-new-birth", false);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  expect(f.effects).toEqual([]);
});

it("an old shutdown cannot touch a new owner", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  const release = deferred<void>(), reply = deferred<number>(), actualShutdowns: number[] = [];
  const runtimeRoot = resolve(".spider/scratch/s5r");
  const newPid = 83005;
  const socket = await serveRelocateShutdown({ sessionId: id, machineId: machine, runtimeRoot, admittedEpoch: 9,
    home: () => f.options.homes.read(id), admittedOwner: async () => ({ pid: newPid, startIdentity: "new-owner", bootId: bootA }),
    shutdown: async () => { actualShutdowns.push(newPid); } });
  try {
    f.behavior.shutdown = async (operation, timeoutMs) => {
      await release.promise;
      const result = await requestSessionControl(runtimeRoot, operation, { timeoutMs });
      reply.resolve(result.code);
      return result.code === 0;
    };
    const newer = { ...running, epoch: 9, updatedAt: 9 };
    f.behavior.pause = async () => {
      f.exit(); f.replicate(newer); f.owner(newPid, "new-owner");
      release.resolve(); await reply.promise;
    };
    expect(await f.runtime.enforceStopped(stopped)).toMatchObject({ home: newer, evidence: { kind: "pending" } });
    expect(await reply.promise).toBe(3);
    expect(actualShutdowns).toEqual([]);
    expect(f.effects).toEqual([[0, "shutdown", pid]]);
  } finally { release.resolve(); await socket.close(); }
});

it("a future or contradictory terminal label and a conflicting lease cannot authorize a signal", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  queueStopMode(f.options.globalDb, stopped, "hard");
  f.label(pid, 9);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  f.label(pid, 7, hub);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  f.label(); f.setLease({ pid: otherSessionPid, startIdentity: "other-pi", bootId: bootA });
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect(f.effects).toEqual([]);
});

it("can stop the known displaced owner without a checkout or a live view", async () => {
  const f = fixture(); f.owner(); f.clearCwd();
  const foreign = { ...stopped, machineId: hub };
  f.replicate(foreign);
  f.io.terminals = async () => { throw new Error("Live view unavailable"); };
  f.behavior.signal = async target => f.exit(target);
  expect((await f.runtime.enforceStopped(foreign)).evidence.kind).toBe("pending");
  expect(f.effects.map(effect => [effect[1], effect[2]])).toContainEqual(["SIGTERM", pid]);
});

it("bounds stalled I/O without signalling when a late read finishes", async () => {
  const f = fixture(500); f.replicate(stopped); f.owner();
  const entered = deferred<void>(), tree = deferred<Awaited<ReturnType<LocalIO["tree"]>>>();
  f.io.tree = async () => { entered.resolve(); return tree.promise; };
  const enforcing = f.runtime.enforceStopped(stopped);
  // Race the entry marker with an early reply so a missing entry point fails immediately in RED.
  expect(await Promise.race([enforcing.then(() => "settled"), entered.promise.then(() => "reading")])).toBe("reading");
  f.advance(500);
  expect((await enforcing).evidence.kind).toBe("pending");
  f.replicate({ ...running, epoch: 9, updatedAt: 9 });
  tree.resolve({ groups: [], descendants: [] });
  await new Promise<void>(done => setImmediate(done));
  expect(f.effects).toEqual([]);
});


it("does not extend the socket window for a stalled process probe", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  const probe = f.io.probe, entered = deferred<void>();
  f.behavior.shutdown = async () => {
    f.io.probe = pid => { f.io.probe = probe; entered.resolve(); return new Promise(() => {}); };
    return true;
  };
  f.behavior.signal = async target => { if (f.effects.at(-1)?.[1] === "SIGKILL") f.exit(target); };
  const checking = f.runtime.enforceStopped(stopped);
  expect(await Promise.race([checking.then(() => "settled"), entered.promise.then(() => "probing")])).toBe("probing");
  // Advance to the next scheduled event. If the phase did not get its own
  // deadline, this releases the probe only when the overall budget expires.
  f.advanceToNextTimer();
  expect((await checking).evidence.kind).toBe("confirmed");
  expect(f.effects).toEqual([[0, "shutdown", pid], [5_000, "SIGTERM", pid], [10_000, "SIGKILL", pid]]);
});

it("does not publish an old confirmation over a concurrently invalidated proof", async () => {
  const f = fixture(); f.replicate(stopped);
  queueStopMode(f.options.globalDb, stopped, "hard");
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  const terminals = f.io.terminals, entered = deferred<void>();
  const release = deferred<Awaited<ReturnType<LocalIO["terminals"]>>>();
  f.io.terminals = () => { f.io.terminals = terminals; entered.resolve(); return release.promise; };
  const observing = f.runtime.observeStopped(stopped);
  await entered.promise;
  f.advance(500);
  f.owner(); f.add(child, "late-child", false); f.descendants.set(pid, [child]);
  f.behavior.signal = async target => { if (target === pid) f.exit(pid); };
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  release.resolve([]);
  expect(await observing).toMatchObject({ observedAt: 500, evidence: { kind: "pending" } });
});

it("a replacement appearing during a run probe prevents cancellation", async () => {
  const f = fixture(); f.replicate(stopped);
  f.run("unsettled-run", child, "old-child");
  const probe = f.io.probe;
  f.io.probe = target => {
    if (target === child) f.owner(83005, "replacement");
    return probe(target);
  };
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect(f.runStatus("unsettled-run")).toEqual({ status: "running" });
  expect(f.effects).toEqual([]);
});

it("rechecks the new boot after it invalidates a shutdown in progress", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  f.behavior.pause = async () => { f.exit(); f.reboot(); };
  expect(await f.runtime.enforceStopped(stopped)).toMatchObject({ bootId: bootB, evidence: { kind: "pending" } });
  expect(await f.runtime.enforceStopped(stopped)).toMatchObject({ bootId: bootB, evidence: { kind: "confirmed", owner: null } });
  expect(f.effects).toEqual([[0, "shutdown", pid]]);
});


it("retains unclassified survivors when the owner exits during the tree check", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  f.add(unclassified, "still-running", false); f.descendants.set(pid, [unclassified]);
  const tree = f.io.tree;
  f.io.tree = async target => { const snapshot = await tree(target); f.exit(pid); return snapshot; };
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect((await createLocalRuntime(f.options, f.io).enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect(f.effects).toEqual([]);
  f.exit(unclassified);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
});

it("captures a local run started before the first signal", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  f.behavior.pause = async () => {
    f.behavior.pause = async () => {};
    f.add(child, "new-run"); f.run("new-run", child, "new-run"); f.descendants.set(pid, [child]);
  };
  f.behavior.signal = async target => f.exit(target);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  expect(f.effects).toEqual([[0, "shutdown", pid], [5_000, "SIGTERM", pid], [5_000, "SIGTERM", child]]);
});

it("looks for conflicting terminal labels on the admitted PID as well as by session", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  queueStopMode(f.options.globalDb, stopped, "hard");
  f.io.terminals = async (_id, admittedPid) => admittedPid === pid ? [{ terminal: "other-pi", state: "live", pid,
    launch: { sessionId: other, machineId: machine, epoch: 7, file: f.placement.file, cwd: f.placement.cwd } }] : [];
  f.behavior.signal = async target => f.exit(target);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect(f.effects).toEqual([]);
});

it("freezes existing membership in both the checkout and its recorded store", async () => {
  const f = fixture(); f.replicate(stopped);
  const project = openDb(join(f.placement.cwd, ".spider", "project.db"));
  cleanup.push(() => project.close());
  migrate(project, "worktree", { machineId: machine, globalRoot: f.options.root });
  project.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,7,'active')").run(id);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  expect(f.membership()).toEqual({ epoch: 8, state: "frozen" });
  expect(project.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(id)).toEqual({ epoch: 8, state: "frozen" });
});


it("a Herdr viewer labelled for the session is not mistaken for pi", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  queueStopMode(f.options.globalDb, stopped, "hard");
  const viewer = { address: "viewer", state: "live", pid: 83008,
    labels: { "spider.kind": "subagent-viewer", "spider.session": id, "spider.run": "viewed-run" } };
  const owner = { address: "pi", state: "live", pid, cwd: f.placement.cwd, argv: ["pi", "--session", f.placement.file],
    labels: { "spider.kind": "session", "spider.session": id, "spider.machine": machine, "spider.roam.epoch": "7" } };
  let ownerLive = true;
  vi.mocked(hc.invokeCli).mockImplementation(async (_binary, argv) => {
    if (argv[0] === "ls") return { terminals: ownerLive ? [viewer, owner] : [viewer] };
    if (argv[0] === "get" && argv[1] === "pi") return owner;
    if (argv[0] === "get" && argv[1] === "viewer") return viewer;
    throw new Error("Unexpected Herdr read");
  });
  f.io.terminals = createLocalIO(f.options).terminals;
  f.behavior.signal = async target => { f.exit(target); ownerLive = false; };
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("confirmed");
  expect(f.effects).toEqual([[0, "SIGKILL", pid]]);
  expect((await f.runtime.observeStopped(stopped)).evidence.kind).toBe("confirmed");
});


it("does not replace unreadable survivor evidence with an empty proof", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  f.add(unclassified, "still-running", false); f.descendants.set(pid, [unclassified]);
  f.behavior.signal = async target => f.exit(target);
  expect((await f.runtime.enforceStopped(stopped)).evidence.kind).toBe("pending");
  const db = f.options.globalDb, scope = "relocate-stop-proof";
  const [record] = localEntries<{ capture: unknown }>(db, scope);
  expect(record.key).toBe(id);
  writeLocal(db, scope, id, { ...record.value, capture: { broken: true } });
  expect((await createLocalRuntime(f.options, f.io).enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect((await createLocalRuntime(f.options, f.io).enforceStopped(stopped)).evidence.kind).toBe("pending");
  expect(f.membership()).toEqual({ epoch: 7, state: "active" });
});


it("rechecks detached job journals after checking the captured children", async () => {
  const f = fixture(); f.owner(); f.replicate(stopped);
  queueStopMode(f.options.globalDb, stopped, "hard");
  f.add(unclassified, "short-lived", false); f.descendants.set(pid, [unclassified]);
  const jobId = "20261128T000000Z-cafef00d", directory = join(f.placement.cwd, ".spider", "scratch", "bg", jobId);
  const probe = f.io.probe;
  f.behavior.signal = async target => {
    f.exit(target);
    f.exit(unclassified);
    f.io.probe = async target => {
      if (target === unclassified) {
        f.io.probe = probe;
        mkdirSync(directory, { mode: 0o700, recursive: true });
        writeFileSync(join(directory, "job.json"), JSON.stringify({ schema: 1, id: jobId, cwd: f.placement.cwd,
          ownerSessionId: id, argv: ["node"], windowsHide: true, startedAt: "2026-11-28T00:00:00.000Z", childPid: process.pid }));
      }
      return probe(target);
    };
  };
  expect((await f.runtime.enforceStopped(stopped)).evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "job", id: jobId }] });
  expect(f.membership()).toEqual({ epoch: 7, state: "active" });
  expect(f.effects).toEqual([[0, "SIGKILL", pid]]);
});
