import * as processApi from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "@spider/db-core";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { createReplica } from "@spider/db-core/testutil";
import * as hc from "@spider/herdr/client/hc";
import * as handoff from "@spider/herdr/jobs/handoff";
import * as idLock from "@spider/herdr/sessions/id-lock";
import { DEFAULT_LIMITS, disabledIntercom, type Clock, type Peer, type RoamConfig, type Transport } from "../contracts";
import { revokeMachine } from "../revocation";
import * as processes from "../relocate/local-process";
import { handleRelocateAgent, type RelocateAgentRequest } from "../relocate/remote";
import { createV0Runtime, startV0Hub } from "../relocate/runtime";
import { createSessionStopStore, projectSessionStatus } from "../relocate/session-stop-store";
import type { StopObservation, StopRequest } from "../relocate/session-stop-types";
import { createHomeSupervisor } from "../relocate/supervisor";
import type { RunningHome, SessionId, StoppedHome, V0Result } from "../relocate/types";
import * as sessionSocket from "../session-socket";
import { deferred } from "./relocate-fakes";

const mac = "11111111-1111-4111-8111-111111111111";
const box = "22222222-2222-4222-8222-222222222222";
const id = "reconnect-stop-session" as SessionId;
const running: RunningHome = { sessionId: id, machineId: box, state: "running", epoch: 7, moveId: null, destination: null, updatedAt: 7 };
const input: StopRequest = { operationId: "graceful", sessionId: id, homeEpoch: 7, machineId: box, mode: "graceful" };
const bootA = "boot-a", bootB = "boot-b";
const readyMs = DEFAULT_LIMITS.readyMs;
const unreachable = "Stop pending: the box is unreachable and may still be running";
const blocker = { kind: "pending", reason: "Still running", blockers: [{ kind: "job", id: "owned-job", cancelFromOwner: true }] } as const;
const confirmed = { kind: "confirmed", owner: null } as const;

vi.mock("node:child_process", { spy: true });
const realExecFileSync = (await vi.importActual<typeof processApi>("node:child_process")).execFileSync;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

function manualClock() {
  let now = 100_000;
  const timers = new Map<() => void, number>();
  const clock: Clock = { now: () => now, later(ms, fn) { timers.set(fn, now + ms); return () => { timers.delete(fn); }; } };
  return { clock, advance(ms: number) {
    now += ms;
    for (const [run, at] of [...timers]) if (at <= now && timers.delete(run)) run();
  }, offsets: () => [...timers.values()].map(at => at - now) };
}

const observationReply = (observation: StopObservation): V0Result<unknown> => ({ ok: true, value: { version: 1, observation } });
const unsupported = { ok: false, refusal: { code: "invalid-arguments", message: "Unsupported v0 request", nextStep: "Update agent" } } as const;

function fixture({ online = true, old = false, ownerLive = false, boxEnabled = true } = {}) {
  const local = createReplica("global", mac), replica = createReplica("global", box);
  const time = manualClock();
  const calls: RelocateAgentRequest[] = [], resolutions: number[] = [], effects: string[] = [], refusedStores: string[] = [];
  const owner = { pid: 83007, startIdentity: "owner-start" };
  let refusalAfterImport = false, observation: ((home: StoppedHome) => Promise<V0Result<unknown>> | V0Result<unknown>) | undefined;
  let beforeObservation: (() => Promise<void>) | undefined;
  const worktree = createReplica("worktree", box), localWorktree = createReplica("worktree", mac);
  cleanups.push(local.close, replica.close, worktree.close, localWorktree.close);
  const key = worktree.storeKey;
  for (const [node, work] of [[local, localWorktree], [replica, worktree]]) {
    node.db.exec("UPDATE roam_meta SET capture_enabled=1");
    const cwd = join(node.root, "checkout");
    mkdirSync(cwd);
    node.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(cwd);
    node.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(cwd);
    writeLocal(node.db, "mapping-redirect", key, work.db.raw.name);
  }
  const cwd = join(replica.root, "checkout"), file = join(replica.root, "session.jsonl");
  writeFileSync(file, "");
  const stores = ["global", key] as const;
  recordLocation(replica.db, { sessionId: id, stores, file, cwd, home: null });
  worktree.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,7,'active')").run(id);
  writeLocal(replica.db, "relocate-managed", id, { sessionId: id, machineId: box, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
    repository: cwd, cwd, file, stores, historyMachine: box });
  local.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,7,7,'running')").run(id, box);

  const terminal = { address: "t7", state: "live", pid: owner.pid, labels: {
    "spider.kind": "session", "spider.session": id, "spider.machine": box, "spider.roam.epoch": "7",
  } };
  vi.stubEnv("SPIDER_GLOBAL_ROOT", local.root);
  vi.stubEnv("HC_SOCKET", join(replica.root, "hc.sock"));
  vi.stubEnv("HC_SESSION", "stop-reconnect-fixture");
  vi.spyOn(idLock, "localBootId").mockResolvedValue(bootA);
  vi.spyOn(idLock, "inspectIdLock").mockImplementation(async (root, session) =>
    root === join(replica.root, "herdr") && session === id && ownerLive ? {
      identity: owner, bootId: bootA, pendingOperationId: null, pendingFile: null, pendingCoreId: null, operationId: null,
    } : null);
  const startIdentity = handoff.processStartIdentity, realKill = process.kill;
  vi.spyOn(handoff, "processStartIdentity").mockImplementation(pid => pid === owner.pid ? (ownerLive ? owner.startIdentity : null) : startIdentity(pid));
  vi.spyOn(processApi, "execFileSync").mockImplementation((cmd, ...args) =>
    cmd === "ps" && Array.isArray(args[0]) && args[0][1] === String(owner.pid) ? "pi\n" : Reflect.apply(realExecFileSync, processApi, [cmd, ...args]));
  vi.spyOn(processes, "localProcessTree").mockResolvedValue({ groups: [], descendants: [] });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== owner.pid) return realKill(pid, signal);
    effects.push(String(signal)); ownerLive = false; return true;
  });
  vi.spyOn(sessionSocket, "requestSessionControl").mockImplementation(async (_root, operation) => {
    effects.push("shutdown"); ownerLive = false;
    return { code: 0, reason: "accepted", operationId: operation.id, home: null, epoch: null, repairCommand: null, value: null };
  });
  vi.spyOn(hc, "invokeCli").mockImplementation(async (_cli, argv) => {
    if (argv[0] === "ls") return { terminals: ownerLive ? [terminal] : [] };
    if (argv[0] === "get" && argv[1] === terminal.address) return { ...terminal, cwd, argv: ["pi", "--session", file] };
    throw new Error("Unexpected terminal call");
  });
  const peer: Peer = { machineId: box, alias: "peer.invalid", node: "peer", pi: "pi", cli: "spider", core: "core", globalRoot: replica.root };
  const macConfig: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac, peers: [peer], discoveryRoots: [],
    coreUnit: "fixture", syncMs: 120_000, limits: { ...DEFAULT_LIMITS, retryDelaysMs: [] }, intercom: disabledIntercom() };
  const boxConfig: RoamConfig = { ...macConfig, machineId: box, role: "box", enabled: boxEnabled, peers: [] };
  const offline = () => Object.assign(new Error("Offline"), { code: "ENETUNREACH" });
  const unused = async () => { throw new Error("Unexpected transport method"); };
  const transport: Transport = {
    bootstrapProbe: unused, run: unused, write: unused,
    async read(_peer, path) { return readFileSync(path); },
    async resolve(peer) { resolutions.push(time.clock.now()); if (!online) throw offline(); return peer; },
    async exec(peer, argv, options) {
      expect(peer.machineId).toBe(box);
      expect(argv).toEqual(["roam", "agent", "--v0"]);
      const request = JSON.parse(options.stdin!.toString()) as RelocateAgentRequest;
      calls.push(request);
      if (!online) throw offline();
      let reply: V0Result<unknown>;
      if (request.kind === "hello" && old) reply = { ok: true, value: { version: 1, machineId: box, pi: true, spider: true } };
      else if (old && (request.kind === "ensure-stopped" || request.kind === "session-observation")) reply = unsupported;
      else if (request.kind === "session-observation" && observation) {
        const result = await observation(request.home);
        await beforeObservation?.();
        reply = result;
      } else if (refusalAfterImport && request.kind === "data" && request.operation.args.storeKey === key &&
          (await agent.homes.read(id))?.state === "stopped") {
        refusedStores.push(key);
        reply = { ok: true, value: { version: 1, outcome: { code: 1, reason: "Unrelated store refused", operationId: request.operation.id,
          home: null, epoch: null, repairCommand: null, value: null } } };
      } else reply = await handleRelocateAgent(request, agent.options);
      return Buffer.from(JSON.stringify(reply));
    },
  };
  const agent = createV0Runtime(replica.root, { clock: time.clock, transport, openCore: () => ({ config: boxConfig, root: replica.root, db: replica.db, close() {} }) });
  cleanups.push(() => agent.close());
  const macOptions = { clock: time.clock, transport, openCore() {
    const db = openDb(local.db.raw.name);
    return { config: macConfig, root: local.root, db, close: () => db.close() };
  } };
  const runtime = createV0Runtime(local.root, { ...macOptions, liveHub: true });
  cleanups.push(() => runtime.close());
  const cache = createSessionStopStore(local.db);
  return { local, replica, runtime, cache, time, calls, resolutions, effects, key, refusedStores, macConfig, agent,
    online(value: boolean) { online = value; }, refuseAfterImport() { refusalAfterImport = true; },
    reply(fn: typeof observation) { observation = fn; }, holdObservation(fn: typeof beforeObservation) { beforeObservation = fn; },
    async status() { return projectSessionStatus(await runtime.homes.read(id), cache.current(id), id, time.clock.now()); },
    async hub() { const live = await startV0Hub(local.root, macOptions); cleanups.push(() => live.stop()); return live; },
    async stoppedHome() { const home = await runtime.homes.read(id); if (home?.state !== "stopped") throw new Error("Expected a stopped home"); return home; },
    revoke() { const db = openDb(join(local.root, "roam", "journal.db")); try { revokeMachine(db, box); } finally { db.close(); } },
    async tick() { const supervisor = createHomeSupervisor(agent.adapters.supervisor, () => {}); try { await supervisor.tick(); } finally { await supervisor.stop(); } },
  };
}

type Fixture = ReturnType<typeof fixture>;
const observations = (f: Fixture) => f.calls.filter(r => r.kind === "session-observation");
const sends = (f: Fixture) => f.calls.filter(r => r.kind === "ensure-stopped");
async function record(f: Fixture, observation: StopObservation) {
  const previous = observations(f).length;
  f.reply(() => observationReply(observation));
  const sync = await f.runtime.sync.sync(box);
  const offsets = f.time.offsets();
  f.time.advance(0);
  await vi.waitFor(() => expect(observations(f), JSON.stringify({ sync, offsets, calls: f.calls.map(r => r.kind) })).toHaveLength(previous + 1));
  await vi.waitFor(() => expect(f.time.offsets()).not.toContain(readyMs));
}

it("resumes a saved hard stop after reconnect", async () => {
  const f = fixture({ online: false, ownerLive: true });
  const retryOffsetsMs: number[] = [];
  async function recordRetry(offset: number) {
    await vi.waitFor(() => expect(f.time.offsets()).toContain(offset));
    retryOffsetsMs.push(f.time.offsets().find(ms => ms === offset)!);
  }
  f.runtime.sync.start();
  const initial = await f.runtime.stopSession(input);
  expect(initial.reason).toBe(unreachable);
  await recordRetry(30_000);
  const afterUpgrade = await f.runtime.stopSession({ ...input, operationId: "kill-now", homeEpoch: 8, mode: "hard" });
  expect(afterUpgrade.homeEpoch).toBe(8);
  await recordRetry(60_000);
  expect(f.cache.current(id)).toMatchObject({ mode: "hard", committed: { epoch: 8 } });
  expect(f.effects).toEqual([]);
  await f.runtime.close();

  f.macConfig.enabled = false;
  await f.hub();
  const beforeEnable = f.resolutions.length;
  f.time.advance(1_000);
  expect(f.resolutions).toHaveLength(beforeEnable);
  f.macConfig.enabled = true;
  f.time.advance(1_000);
  f.time.advance(0);
  await recordRetry(120_000);
  f.online(true);
  f.refuseAfterImport();
  f.time.advance(120_000);
  // Run the work scheduled by the sync completion, not the next sync retry.
  await vi.waitFor(() => {
    f.time.advance(0);
    expect(sends(f).map(r => r.mode)).toEqual(["hard"]);
  });
  await vi.waitFor(() => expect(f.time.offsets()).not.toContain(readyMs));
  expect(retryOffsetsMs).toEqual([30_000, 60_000, 120_000]);
  expect(f.calls.some(r => r.kind === "data" && r.operation.kind === "import" && r.operation.args.storeKey === "global")).toBe(true);
  expect(f.refusedStores).toContain(f.key);
  const home = f.cache.current(id)!.committed as StoppedHome;
  const status = () => projectSessionStatus(home, f.cache.current(id), id, f.time.clock.now());
  // An ensure-stopped receipt is pending even with the exact replica and saved hard mode.
  expect(status().status).toBe("stop-pending");
  expect(f.effects).toEqual([]);
  const syncRounds = f.calls.filter(r => r.kind === "data" && r.operation.kind === "stores").length;
  expect(syncRounds).toBe(1);
  f.time.advance(1);
  const exitCheckAt = f.time.clock.now();
  await f.tick();
  expect(f.effects).toEqual(["SIGKILL"]);
  await vi.waitFor(() => expect(f.time.offsets().some(ms => ms > 1_000 && ms <= 10_000)).toBe(true));
  f.time.advance(10_000);
  await vi.waitFor(() => expect(status()).toMatchObject({ status: "stopped", observedAt: exitCheckAt }));
  expect(f.calls.filter(r => r.kind === "data" && r.operation.kind === "stores")).toHaveLength(syncRounds);
});

it("keeps the original Stop open for the next observation round", async () => {
  const f = fixture({ ownerLive: true });
  let settled = false;
  const done = f.runtime.stopSession(input).finally(() => { settled = true; });
  await vi.waitFor(() => expect(f.cache.current(id)).toMatchObject({ observations: [{ evidence: { kind: "pending" } }] }));
  expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stop-pending" });
  expect(settled).toBe(false);
  f.time.advance(6_000);
  await f.tick();
  const checkedAt = f.time.clock.now();
  expect(settled).toBe(false);
  f.time.advance(4_000);
  expect(await done).toMatchObject({ outcome: "complete", status: "stopped", observedAt: checkedAt });
});

it("older proof cannot erase a blocker", async () => {
  const f = fixture();
  f.reply(home => observationReply({ sessionId: id, machineId: box, home, bootId: bootA, observedAt: 100_010, evidence: blocker }));
  expect(await f.runtime.stopSession(input)).toMatchObject({ status: "stop-pending", reason: expect.stringContaining("owned-job") });
  await vi.waitFor(() => expect(f.time.offsets()).toContain(10_000));
  const home = await f.stoppedHome();
  const newer = { sessionId: id, machineId: box, home, bootId: bootA, observedAt: 100_040, evidence: blocker };
  await record(f, newer);
  expect(await f.status()).toMatchObject({ status: "stop-pending", observedAt: 100_040 });
  await record(f, { ...newer, observedAt: 100_030, evidence: confirmed });
  expect(await f.status()).toMatchObject({ status: "stop-pending", observedAt: 100_040, reason: expect.stringContaining("owned-job") });

  const newerHome: StoppedHome = { ...home, epoch: 9, updatedAt: 100_050 };
  const release = deferred(), waiting = deferred();
  f.reply(() => observationReply({ ...newer, observedAt: 100_060, evidence: confirmed }));
  f.holdObservation(() => { waiting.resolve(); return release.promise; });
  try {
    await f.runtime.sync.sync(box);
    f.time.advance(0);
    await waiting.promise;
    const saved = f.cache.current(id);
    expect(await f.runtime.homes.compareAndSwap(home, newerHome)).toEqual({ kind: "applied", home: newerHome });
    release.resolve();
    await vi.waitFor(() => expect(f.time.offsets()).not.toContain(readyMs));
    expect(await f.runtime.homes.read(id)).toEqual(newerHome);
    expect(f.cache.current(id)).toEqual(saved);
  } finally { release.resolve(); }
});

it("invalidates an exact confirmation when the peer reports a missing replica", async () => {
  const f = fixture();
  f.reply(home => observationReply({ sessionId: id, machineId: box, home, bootId: bootA, observedAt: 100_010, evidence: confirmed }));
  expect(await f.runtime.stopSession(input)).toMatchObject({ status: "stopped", observedAt: 100_010 });
  await vi.waitFor(() => expect(f.time.offsets()).toEqual([]));
  f.online(false);
  await f.runtime.sync.sync(box);
  f.time.advance(0);
  await vi.waitFor(() => expect(f.time.offsets()).toEqual([]));
  expect(await f.status()).toMatchObject({ status: "stopped", observedAt: 100_010 });
  f.online(true);
  // Simulate local replica loss, not an outbound deletion authored by the box.
  f.replica.db.exec("UPDATE roam_meta SET capture_enabled=0");
  f.replica.db.prepare("DELETE FROM session_homes WHERE session_id=?").run(id);
  f.replica.db.exec("UPDATE roam_meta SET capture_enabled=1");
  f.reply(undefined);
  f.time.advance(100);
  const sync = await f.runtime.sync.sync(box);
  const offsets = f.time.offsets();
  expect(await f.agent.homes.read(id)).toBeNull();
  f.time.advance(0);
  await vi.waitFor(async () => expect(await f.status(), JSON.stringify({ sync, offsets, calls: f.calls.map(r => r.kind) }))
    .toMatchObject({ status: "stop-pending", reason: expect.stringContaining("missing") }));
  const before = f.calls.length;
  f.time.advance(10_000);
  await vi.waitFor(() => expect(f.calls.slice(before).some(r => r.kind === "data" && r.operation.kind === "stores")).toBe(true));
});

it.each([
  ["offline", { online: false }, unreachable],
  ["old", { old: true }, "Stop pending: update roaming on the box. It may still be running."],
  ["disabled", { boxEnabled: false }, /disabled/],
] as const)("reports a peer in state %s without claiming exit", async (kind, options, reason) => {
  const f = fixture(options);
  const pending = await f.runtime.stopSession(input);
  expect(pending.status).toBe("stop-pending");
  if (typeof reason === "string") expect(pending.reason).toBe(reason);
  else expect(pending.reason).toMatch(reason);
  if (kind === "old") expect(await f.agent.homes.read(id)).toMatchObject({ state: "stopped", epoch: 8 });
  if (kind === "offline") expect(f.calls).toEqual([]);
});

it("leaves a capable peer without proof pending at the caller deadline", async () => {
  const f = fixture();
  const call = f.runtime.stopSession(input);
  await vi.waitFor(() => expect(sends(f)).toHaveLength(1));
  f.time.advance(readyMs);
  const pending = await call;
  expect(pending.status).toBe("stop-pending");
  expect(pending.reason).not.toContain("update roaming");
  const count = f.calls.length;
  expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stop-pending" });
  expect(f.calls).toHaveLength(count);
});

it("never contacts a revoked peer for a previously accepted Stop", async () => {
  const f = fixture({ online: false });
  expect(await f.runtime.stopSession(input)).toMatchObject({ status: "stop-pending" });
  f.online(true);
  f.resolutions.length = 0;
  f.revoke();
  f.runtime.resumeSessionStops();
  await f.runtime.sync.sync(box);
  f.time.advance(0);
  await setImmediate();
  expect(f.resolutions).toEqual([]);
  expect(f.calls).toEqual([]);
});

it("bounds a hung round, coalesces in-flight triggers, and rejects its late proof from a previous boot", async () => {
  const f = fixture(), oldReply = deferred();
  const old = f.runtime.stopSession(input);
  f.reply(home => observationReply({ sessionId: id, machineId: box, home, bootId: bootA, observedAt: 999_999, evidence: confirmed }));
  f.holdObservation(() => oldReply.promise);
  try {
    await vi.waitFor(() => expect(observations(f)).toHaveLength(1));
    const concurrent = f.runtime.stopSession(input);
    await Promise.all([f.runtime.sync.sync(box), f.runtime.sync.sync(box)]);
    f.time.advance(0);
    await setImmediate();
    expect(observations(f)).toHaveLength(1);
    f.time.advance(readyMs);
    expect(await old).toMatchObject({ status: "stop-pending" });
    await concurrent;
    f.holdObservation(undefined);
    f.reply(home => observationReply({ sessionId: id, machineId: box, home, bootId: bootB, observedAt: 2, evidence: blocker }));
    const retried = await f.runtime.stopSession(input);
    expect(retried).toMatchObject({ status: "stop-pending", observedAt: 2, reason: expect.stringContaining("owned-job") });
    expect(observations(f)).toHaveLength(2);
    oldReply.resolve();
    await setImmediate();
    expect(await f.status()).toMatchObject({ status: "stop-pending", observedAt: 2 });
  } finally { oldReply.resolve(); }
});

it("sends the hard upgrade on the same epoch when a graceful round is in flight", async () => {
  const f = fixture(), waiting = deferred(), release = deferred();
  f.reply(home => observationReply({ sessionId: id, machineId: box, home, bootId: bootA, observedAt: 100_010, evidence: blocker }));
  f.holdObservation(() => { waiting.resolve(); return release.promise; });
  const gentle = f.runtime.stopSession(input);
  try {
    await waiting.promise;
    const hard = f.runtime.stopSession({ ...input, operationId: "hard-in-flight", homeEpoch: 8, mode: "hard" });
    await vi.waitFor(() => expect(f.cache.current(id)).toMatchObject({ mode: "hard", committed: { epoch: 8 } }));
    expect(sends(f).map(r => r.mode)).toEqual(["graceful"]);
    expect(observations(f)).toHaveLength(1);
    release.resolve();
    await Promise.all([gentle, hard]);
    await vi.waitFor(() => expect(sends(f).map(r => [r.mode, r.home.epoch])).toEqual([["graceful", 8], ["hard", 8]]));
  } finally { release.resolve(); }
});

it("reports the authoritative home if a Stop is superseded while awaiting evidence", async () => {
  const f = fixture(), waiting = deferred(), release = deferred();
  f.reply(home => observationReply({ sessionId: id, machineId: box, home, bootId: bootA, observedAt: 100_010, evidence: confirmed }));
  f.holdObservation(() => { waiting.resolve(); return release.promise; });
  const request = f.runtime.stopSession(input);
  try {
    await waiting.promise;
    const stopped = await f.stoppedHome();
    const runningAgain: RunningHome = { ...stopped, machineId: mac, epoch: 9, state: "running", updatedAt: 100_001 };
    expect(await f.runtime.homes.compareAndSwap(stopped, runningAgain)).toEqual({ kind: "applied", home: runningAgain });
    f.time.advance(readyMs);
    expect(await request).toMatchObject({ homeEpoch: 9, homeState: "running", outcome: "refused", reason: "home-superseded" });
  } finally { release.resolve(); }
});

it("drains a displaced Mac check before closing its database even after the contact deadline", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const stopped: StoppedHome = { ...running, epoch: 8, state: "stopped", updatedAt: f.time.clock.now() };
  expect(await f.runtime.homes.compareAndSwap(running, stopped)).toEqual({ kind: "applied", home: stopped });
  f.cache.write({ action: "force", operationId: "force-example", committed: stopped, expected: running,
    mode: "graceful", displaced: [mac], contactReason: null, observations: [] });
  let dbStillOpen: unknown, checked: StoppedHome | undefined;
  vi.spyOn(f.runtime.adapters.stop, "enforceLocal").mockImplementation(async home => {
    checked = home;
    entered.resolve();
    await release.promise;
    dbStillOpen = f.runtime.options.globalDb.prepare("SELECT 1 AS open").get();
    return { sessionId: id, machineId: mac, home, bootId: bootA, observedAt: f.time.clock.now(), evidence: confirmed };
  });
  f.runtime.resumeSessionStops();
  f.time.advance(0);
  try {
    await entered.promise;
    expect(checked).toEqual(stopped);
    f.time.advance(readyMs);
    let closed = false;
    const close = f.runtime.close().finally(() => { closed = true; });
    await setImmediate();
    expect(closed).toBe(false);
    release.resolve();
    await close;
    expect(dbStillOpen).toEqual({ open: 1 });
    expect(f.time.offsets()).toEqual([]);
  } finally { release.resolve(); }
});

it("uses the box check time for Stopping and does not treat future checks as current", async () => {
  const f = fixture();
  const checkAt = f.time.clock.now() + 2_000; // Box clock runs ahead of the Mac.
  f.reply(home => observationReply({ sessionId: id, machineId: box, home, bootId: bootA, observedAt: checkAt, evidence: { kind: "checking" } }));
  const request = f.runtime.stopSession(input);
  await vi.waitFor(() => expect(f.cache.current(id)).toMatchObject({ observations: [{ observedAt: checkAt }] }));
  expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stop-pending", observedAt: checkAt });
  f.time.advance(2_000);
  expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stopping", observedAt: checkAt });
  f.time.advance(10_000);
  expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stop-pending", observedAt: checkAt });
  f.time.advance(readyMs);
  await request;
});
