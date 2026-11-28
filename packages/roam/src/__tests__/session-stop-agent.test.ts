import * as processApi from "node:child_process";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
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
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { DEFAULT_LIMITS, disabledIntercom, type Peer, type RoamConfig, type Transport } from "../contracts";
import * as processes from "../relocate/local-process";
import { handleRelocateAgent, type RelocateAgentRequest } from "../relocate/remote";
import { createV0Runtime, type V0Runtime } from "../relocate/runtime";
import type { StopMode, StopObservation } from "../relocate/session-stop-types";
import { createHomeSupervisor } from "../relocate/supervisor";
import type { RunningHome, SessionId, StoppedHome, V0Result } from "../relocate/types";
import { revokeMachine } from "../revocation";
import * as sessionSocket from "../session-socket";

const hub = "11111111-1111-4111-8111-111111111111";
const box = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
const id = "stop-agent-session" as SessionId;
const running: RunningHome = { sessionId: id, machineId: box, state: "running", epoch: 7, moveId: null, destination: null, updatedAt: 7 };
const stopped: StoppedHome = { ...running, state: "stopped", epoch: 8, updatedAt: 8 };
const owner = { pid: 83001, startIdentity: "pi-birth" };
const bootA = "f22f2604-548d-421d-b5cb-9f31d7b50bd1";
const bootB = "9556da36-1481-49f7-86c6-53bdcb282dd1";
const cleanups: (() => void | Promise<void>)[] = [];
vi.mock("node:child_process", { spy: true });
const realExec = (await vi.importActual<typeof processApi>("node:child_process")).execFileSync;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanups.splice(0).reverse()) await close();
});

const ensure = (home = stopped, mode: StopMode = "hard") => ({ version: 1, kind: "ensure-stopped", sourceMachine: hub, home, mode });
const observe = (home = stopped) => ({ version: 1, kind: "session-observation", sourceMachine: hub, sessionId: home.sessionId, home });
function value<T>(reply: V0Result<T>): T {
  if (!reply.ok) throw new Error(JSON.stringify(reply.refusal));
  return reply.value;
}

function fixture(provenance: "placement" | "membership" | "none" = "placement") {
  const mac = createReplica("global", hub), replica = createReplica("global", box), worktree = createReplica("worktree", box);
  cleanups.push(mac.close, replica.close, worktree.close);
  for (const node of [mac, replica]) node.db.prepare("UPDATE roam_meta SET capture_enabled=1").run();
  const cwd = join(replica.root, "checkout"), file = join(replica.root, "session.jsonl"), key = worktree.storeKey;
  mkdirSync(cwd);
  writeFileSync(file, ""); // Deliberately not a usable placement transcript.
  const keys = ["global", key] as const;
  recordLocation(replica.db, { sessionId: id, stores: keys, home: null, ...(provenance === "placement" ? { file, cwd } : {}) });
  replica.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(cwd);
  replica.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(cwd);
  writeLocal(replica.db, "mapping-redirect", key, worktree.db.raw.name);
  worktree.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
  if (provenance !== "none") worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,7,'active')").run(id);
  const placement = { sessionId: id, machineId: box, repoKey: "fixture-repo", workspaceId: "fixture-workspace", repository: cwd, cwd, file, stores: keys, historyMachine: box };
  if (provenance === "placement") writeLocal(replica.db, "relocate-managed", id, placement);
  const effects: string[] = [], calls: RelocateAgentRequest[] = [], resolved: string[] = [];
  let launches = 0, online = true, live = false, boot = bootA;
  let lock: idLock.IdLockObservation | null = null;
  const self = join(replica.root, "herdr");
  const leases = createSessionLeases(self);
  const labels = { "spider.kind": "session", "spider.session": id, "spider.machine": box, "spider.roam.epoch": "7" };
  const terminal = { address: "t7", state: "live", pid: owner.pid, labels };
  const exit = () => { live = false; lock = null; };
  vi.stubEnv("SPIDER_GLOBAL_ROOT", mac.root);
  vi.stubEnv("HC_SOCKET", join(replica.root, "hc.sock"));
  vi.stubEnv("HC_SESSION", "stop-agent-fixture");
  vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  vi.spyOn(idLock, "localBootId").mockImplementation(async () => boot);
  vi.spyOn(idLock, "inspectIdLock").mockImplementation(async (root, session) => root === self && session === id ? lock : null);
  const realIdentity = handoff.processStartIdentity, realKill = process.kill;
  vi.spyOn(handoff, "processStartIdentity").mockImplementation(pid => pid === owner.pid ? (live ? owner.startIdentity : null) : realIdentity(pid));
  vi.spyOn(processApi, "execFileSync").mockImplementation((cmd, ...args) =>
    cmd === "ps" && Array.isArray(args[0]) && args[0][1] === String(owner.pid) ? "pi\n" : Reflect.apply(realExec, processApi, [cmd, ...args]));
  vi.spyOn(processes, "localProcessTree").mockResolvedValue({ groups: [], descendants: [] });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== owner.pid) return realKill(pid, signal);
    expect(["SIGTERM", "SIGKILL"]).toContain(signal);
    effects.push(String(signal)); exit(); return true;
  });
  vi.spyOn(sessionSocket, "requestSessionControl").mockImplementation(async (_root, operation) => {
    expect(operation.args).toMatchObject({ sessionId: id, homeState: "stopped", owner: { ...owner, bootId: boot } });
    effects.push("shutdown"); exit();
    return { code: 0, reason: "accepted", operationId: operation.id, home: null, epoch: null, repairCommand: null, value: null };
  });
  vi.spyOn(hc, "invokeCli").mockImplementation(async (_cli, argv) => {
    if (argv[0] === "ls") return { terminals: live ? [terminal] : [] };
    if (argv[0] === "get" && argv[1] === terminal.address) return { ...terminal, cwd, argv: ["pi", "--session", file] };
    throw new Error("Unexpected terminal call");
  });
  vi.spyOn(hc, "observeCoreIdentity").mockImplementation(async () => { launches++; throw new Error("Unexpected launch"); });
  const gitRun = vi.fn(async () => { throw new Error("The checkout cannot be opened"); });
  const unused = async () => { throw new Error("Unexpected transport method"); };
  const peer: Peer = { machineId: box, alias: "peer", node: "peer", pi: "pi", cli: "spider", core: "core", globalRoot: replica.root };
  let replyBytes = (_request: RelocateAgentRequest, reply: Buffer): Buffer => reply;
  const transport: Transport = {
    bootstrapProbe: unused, run: unused, write: unused,
    async read(peer, path) {
      expect(path.startsWith(join(peer.globalRoot, "roam", "staging") + "/")).toBe(true);
      return readFileSync(path);
    },
    async resolve(peer) { resolved.push(peer.machineId); if (!online) throw new Error("offline"); return peer; },
    async exec(peer, argv, options) {
      expect(peer.machineId).toBe(box);
      expect(argv).toEqual(["roam", "agent", "--v0"]);
      const request = JSON.parse(options.stdin!.toString()) as RelocateAgentRequest;
      if (request.kind !== "data" && request.kind !== "artifact")
        expect(options).toMatchObject({ timeoutMs: DEFAULT_LIMITS.controlMs, maxBytes: DEFAULT_LIMITS.replyBytes });
      calls.push(request);
      if (!online) throw new Error("offline");
      return replyBytes(request, Buffer.from(JSON.stringify(await handleRelocateAgent(request, agent.options))));
    },
  };
  const config: RoamConfig = { enabled: true, role: "hub", machineId: hub, hubMachineId: hub, peers: [peer], discoveryRoots: [],
    coreUnit: "core", syncMs: 120_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const boxConfig: RoamConfig = { ...config, machineId: box, role: "box", peers: [] };
  const open = (node: typeof replica, config: RoamConfig): V0Runtime => {
    const runtime = createV0Runtime(node.root, { openCore: () => ({ root: node.root, db: node.db, config, close() {} }), transport, gitRun });
    cleanups.push(() => runtime.close());
    return runtime;
  };
  let agent = open(replica, boxConfig);
  const macRuntime = open(mac, config);
  mac.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,7,7,'running')").run(id, box);
  async function importHome(home = stopped, from: RunningHome | StoppedHome = running) {
    expect(await macRuntime.homes.compareAndSwap(from, home)).toEqual({ kind: "applied", home });
    const results = await macRuntime.sync.sync(box);
    expect(await agent.homes.read(id), JSON.stringify(results)).toEqual(home);
    expect(calls.some(r => r.kind === "data" && r.operation.kind === "import" && r.operation.args.storeKey === "global")).toBe(true);
  }
  async function startOwner() {
    await leases.claim(file, owner, { leases, presence: createProcessPresence(self), processes: async () => [], probe: async () => ({ kind: "absent" }) }, { mode: "cutover", bootId: boot });
    lock = { identity: owner, bootId: boot, pendingOperationId: null, pendingFile: null, pendingCoreId: null, operationId: null };
    live = true;
  }
  async function tick() {
    const supervisor = createHomeSupervisor(agent.adapters.supervisor, () => {});
    try { await supervisor.tick(); } finally { await supervisor.stop(); }
  }
  return { mac, macRuntime, replica, effects, calls, resolved, self, gitRun, importHome, tick, startOwner,
    readReplica: () => agent.homes.read(id),
    handle: (request: unknown) => handleRelocateAgent(request, agent.options),
    async observation(home = stopped) { return value(await handleRelocateAgent(observe(home), agent.options)) as { version: 1; observation: StopObservation }; },
    disable: () => { boxConfig.enabled = false; }, offline: () => { online = false; },
    reply: (fn: typeof replyBytes) => { replyBytes = fn; },
    async reboot() { await agent.close(); boot = bootB; live = false; agent = open(replica, boxConfig); },
    launches: () => launches, removeCheckout: () => rmdirSync(cwd),
    membership: () => worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(id),
  };
}

it("queues hard mode without taking the local lock", async () => {
  const f = fixture(); await f.startOwner();
  const notReplied = Symbol("still waiting for the local lock");
  let acknowledgement: Promise<V0Result<unknown>> | undefined;
  const beforeUnlock = await withProcessLock(f.self, `v0-state:${id}`, async () => {
    await f.importHome();
    acknowledgement = f.handle(ensure());
    const reply = await Promise.race([acknowledgement, setImmediate(notReplied)]);
    expect(f.effects).toEqual([]);
    return reply;
  });
  await acknowledgement;
  expect(beforeUnlock).toEqual({ ok: true, value: { version: 1, pending: true } });
  expect(value(await f.handle({ version: 1, kind: "hello" }))).toMatchObject({ sessionStopVersion: 1 });
});

it("refuses disabled replication, non-hub senders, foreign targets, a wrong epoch and caller-selected PIDs", async () => {
  const f = fixture(); await f.importHome();
  const refusals = [
    await f.handle({ ...ensure(), sourceMachine: foreign }),
    await f.handle(ensure({ ...stopped, machineId: foreign })),
    await f.handle(ensure({ ...stopped, epoch: 9 })),
    await f.handle({ ...ensure(), pid: owner.pid }),
    await f.handle(ensure({ ...stopped, updatedAt: 9 })),
    await f.handle(ensure({ ...stopped, pid: owner.pid } as StoppedHome)),
    await f.handle({ ...observe(), sourceMachine: foreign }),
    await f.handle({ ...observe(), sessionId: "different-session" }),
  ];
  f.disable();
  refusals.push(await f.handle(ensure()), await f.handle(observe()));
  expect(refusals.map(r => r.ok ? "ok" : r.refusal.code)).toEqual([
    "invalid-arguments", "home-conflict", "home-conflict", "invalid-arguments", "home-conflict", "invalid-arguments",
    "invalid-arguments", "invalid-arguments", "replication-disabled", "replication-disabled",
  ]);
  expect(f.effects).toEqual([]);
});

it("enforces the replica even if the hub vanishes after publication", async () => {
  const f = fixture(); await f.startOwner(); await f.importHome(); f.offline();
  writeLocal(f.replica.db, "relocate-managed", id, undefined);
  expect((await f.handle({ version: 1, kind: "locate", sessionId: id })).ok).toBe(false);
  f.gitRun.mockClear();
  const traffic = f.calls.length;
  expect((await f.observation()).observation).toMatchObject({ home: stopped, evidence: { kind: "pending" } });
  expect(f.effects).toEqual([]);
  await f.tick();
  expect(f.effects).toEqual(["shutdown"]);
  expect(f.calls).toHaveLength(traffic);
  expect(f.launches()).toBe(0);
  expect(f.membership()).toEqual({ state: "frozen", epoch: 8 });
  expect(await f.observation()).toMatchObject({ version: 1, observation: { home: stopped, bootId: bootA, evidence: { kind: "confirmed", owner } } });
  expect(f.gitRun).not.toHaveBeenCalled();
});

it("upgrades graceful to hard without letting a later graceful call downgrade it", async () => {
  const f = fixture(); await f.startOwner(); await f.importHome();
  for (const mode of ["graceful", "hard", "graceful"] as const)
    expect(value(await f.handle(ensure(stopped, mode)))).toEqual({ version: 1, pending: true });
  f.offline(); await f.tick();
  expect(f.effects).toEqual(["SIGKILL"]);
  expect(f.launches()).toBe(0);
});

it("does not apply queued hard mode to a superseding stopped epoch", async () => {
  const f = fixture(); await f.startOwner(); await f.importHome();
  value(await f.handle(ensure()));
  const successor: StoppedHome = { ...stopped, epoch: 9, updatedAt: 9 };
  await f.importHome(successor, stopped);
  await f.tick();
  expect(f.effects).toEqual(["shutdown"]);
  expect((await f.observation(successor)).observation.home).toEqual(successor);
});

it.each(["placement", "membership"] as const)("enforces a foreign stopped replica using retained local %s even with a missing checkout", async provenance => {
  const displaced = fixture(provenance); await displaced.startOwner();
  await displaced.macRuntime.sync.sync(box);
  expect(await displaced.readReplica()).toEqual(running);
  const newerForeignStopped = { ...stopped, machineId: foreign };
  await displaced.importHome(newerForeignStopped); displaced.removeCheckout(); displaced.offline();
  await displaced.tick();
  expect(displaced.effects).toEqual(["shutdown"]);
  expect(displaced.launches()).toBe(0);
  expect(await displaced.observation(newerForeignStopped)).toMatchObject({ observation: {
    machineId: box, home: newerForeignStopped, bootId: bootA, evidence: { kind: "pending" },
  } });
});

it("does not turn a catalog-only foreign stopped row into local exit proof", async () => {
  const f = fixture("none");
  const newerForeignStopped = { ...stopped, machineId: foreign };
  await f.importHome(newerForeignStopped);
  await f.tick();
  expect(f.effects).toEqual([]);
  expect((await f.observation(newerForeignStopped)).observation).toMatchObject({ home: newerForeignStopped, evidence: { kind: "pending" } });
});

it("a reboot keeps the stopped home down and rechecks under the new boot", async () => {
  const afterReboot = fixture(); await afterReboot.startOwner(); await afterReboot.importHome();
  await afterReboot.tick();
  expect((await afterReboot.observation()).observation).toMatchObject({ bootId: bootA, evidence: { kind: "confirmed", owner } });
  await afterReboot.reboot(); afterReboot.offline();
  expect((await afterReboot.observation()).observation).toMatchObject({ home: stopped, bootId: bootB, evidence: { kind: "pending" } });
  await afterReboot.tick();
  expect(afterReboot.launches()).toBe(0);
  expect(afterReboot.effects).toEqual(["shutdown"]);
  expect((await afterReboot.observation()).observation).toMatchObject({ home: stopped, bootId: bootB, evidence: { kind: "confirmed", owner: null } });
});

it("reads the boot and reports missing or different homes without confirming them", async () => {
  const f = fixture();
  const missingReplica = (await f.observation()).observation;
  expect(missingReplica.home).toBeNull();
  expect(missingReplica).toMatchObject({ bootId: bootA, evidence: { kind: "pending" } });
  await f.macRuntime.sync.sync(box);
  const wrongReplica = (await f.observation()).observation;
  expect(wrongReplica.home).toEqual(running);
  expect(wrongReplica).toMatchObject({ bootId: bootA, evidence: { kind: "pending" } });
  expect(f.gitRun).not.toHaveBeenCalled();
});

it("reads back the exact stopped home after a separate store failure, without relaxing relocation", async () => {
  const f = fixture(); await f.importHome();
  const sync = vi.spyOn(f.macRuntime.options.sync, "sync").mockResolvedValue([
    { code: 1, reason: "worktree refused", operationId: "worktree", home: null, epoch: null, repairCommand: null, value: null },
  ]);
  const stop = f.macRuntime.adapters.stop;
  expect(await stop.publishStopped(stopped, box)).toEqual({ ok: true, value: undefined });
  expect(sync).toHaveBeenCalledExactlyOnceWith(box);
  expect(f.calls.at(-1)).toMatchObject({ kind: "home", sessionId: id });
  expect(await stop.publishStopped({ ...stopped, updatedAt: 9 }, box)).toMatchObject({ ok: false, refusal: { code: "sync-failed" } });
  const reads = f.calls.length;
  expect(await f.macRuntime.adapters.ports.publishHome(stopped, box)).toMatchObject({ ok: false, refusal: { code: "sync-failed" } });
  expect(f.calls).toHaveLength(reads);
  sync.mockRejectedValue(new Error("unrelated store failed after global import"));
  expect(await stop.publishStopped(stopped, box)).toEqual({ ok: true, value: undefined });
});

it("reports disabled replication when publication cannot reach the stopped replica", async () => {
  const f = fixture(); f.disable();
  expect(await f.macRuntime.homes.compareAndSwap(running, stopped)).toEqual({ kind: "applied", home: stopped });
  const stop = f.macRuntime.adapters.stop;
  expect(await stop.publishStopped(stopped, box)).toMatchObject({ ok: false, refusal: { code: "replication-disabled" } });
  expect(f.calls.at(-1)).toMatchObject({ kind: "home", sessionId: id });
  expect(await stop.observe(box, stopped)).toMatchObject({ ok: false, refusal: { code: "replication-disabled" } });
  expect(await f.readReplica()).toBeNull();
});

it("distinguishes a reachable old v0 agent from a broken or unreachable reply", async () => {
  const f = fixture(), stop = f.macRuntime.adapters.stop;
  expect(await stop.stopCapability(box)).toEqual({ ok: true, value: "supported" });
  const wire = (machineId: string, version?: number) => Buffer.from(JSON.stringify({ ok: true, value: {
    version: 1, machineId, spider: true, pi: false, sessionStopVersion: version,
  } }));
  f.reply(() => wire(box));
  expect(await stop.stopCapability(box)).toEqual({ ok: true, value: "old-agent" });
  f.reply(() => wire(foreign, 1));
  expect((await stop.stopCapability(box)).ok).toBe(false);
  f.reply(() => wire(box, 2));
  expect((await stop.stopCapability(box)).ok).toBe(false);
  f.offline();
  expect(await stop.stopCapability(box)).toMatchObject({ ok: false, refusal: { code: "source-unreachable" } });
});

it("checks pending acknowledgements and binds decoded observations to the contacted peer and session", async () => {
  const f = fixture(); await f.importHome(); await f.tick();
  const stop = f.macRuntime.adapters.stop;
  expect(await stop.ensureStopped(stopped, "hard")).toEqual({ ok: true, value: undefined });
  expect(f.calls.at(-1)).toEqual(ensure());
  const proved = value(await stop.observe(box, stopped));
  expect(proved).toMatchObject({ sessionId: id, machineId: box, home: stopped, bootId: bootA, evidence: { kind: "confirmed" } });
  expect(f.calls.at(-1)).toEqual(observe());
  expect(value(await stop.observe(box, { ...stopped, epoch: 9 }))).toMatchObject({ home: stopped, evidence: { kind: "pending" } });
  const wire = (value: object) => Buffer.from(JSON.stringify({ ok: true, value: { version: 1, ...value } }));
  for (const delta of [{ machineId: foreign }, { sessionId: "other" }, { home: { ...stopped, sessionId: "other" } },
    { home: running }, { home: null }, { observedAt: -1 }, { observedAt: Number.MAX_SAFE_INTEGER + 1 }, { bootId: null },
    { evidence: { kind: "confirmed", owner: { ...owner, bootId: bootB } } },
    { evidence: { kind: "pending", reason: "x".repeat(4097), blockers: [] } },
    { evidence: { kind: "pending", reason: "blocked", blockers: [{ kind: "job", id: "job-1", cancelFromOwner: 0 }] } },
  ]) {
    f.reply(() => wire({ observation: { ...proved, ...delta } }));
    expect((await stop.observe(box, stopped)).ok, JSON.stringify(Object.keys(delta))).toBe(false);
  }
  f.reply(() => Buffer.alloc(DEFAULT_LIMITS.replyBytes + 1));
  expect((await stop.observe(box, stopped)).ok).toBe(false);
  f.reply(() => wire({ pending: false }));
  expect((await stop.ensureStopped(stopped, "hard")).ok).toBe(false);
});

it("writes and enforces a Mac stop without an agent or supervisor", async () => {
  const f = fixture(), local: StoppedHome = { ...stopped, machineId: hub };
  const worktree = createReplica("worktree", hub), cwd = join(f.mac.root, "checkout"), file = join(f.mac.root, "session.jsonl");
  cleanups.push(worktree.close);
  mkdirSync(cwd);
  writeFileSync(file, "");
  f.mac.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(cwd);
  writeLocal(f.mac.db, "mapping-redirect", worktree.storeKey, worktree.db.raw.name);
  recordLocation(f.mac.db, { sessionId: id, stores: ["global", worktree.storeKey], home: null, file, cwd });
  worktree.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,7,'active')").run(id);
  expect(await f.macRuntime.homes.compareAndSwap(running, local)).toEqual({ kind: "applied", home: local });
  const stop = f.macRuntime.adapters.stop;
  expect(await stop.stopCapability(hub)).toEqual({ ok: true, value: "supported" });
  expect(await stop.publishStopped(local, hub)).toEqual({ ok: true, value: undefined });
  expect(await stop.ensureStopped(local, "hard")).toEqual({ ok: true, value: undefined });
  const proof = { machineId: hub, home: local, bootId: bootA, evidence: { kind: "confirmed", owner: null } };
  expect(await stop.enforceLocal(local)).toMatchObject(proof);
  expect(value(await stop.observe(hub, local))).toMatchObject(proof);
  expect(worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(id)).toEqual({ state: "frozen", epoch: 8 });
  expect(f.calls).toEqual([]);
});

it("does not contact a peer after its revocation, even to read a stopped replica", async () => {
  const f = fixture(), stop = f.macRuntime.adapters.stop;
  const journal = openDb(join(f.mac.root, "roam", "journal.db"), { fileMustExist: true, checkpointOnClose: false });
  try { revokeMachine(journal, box); } finally { journal.close(); }
  for (const result of [await stop.stopCapability(box), await stop.publishStopped(stopped, box),
    await stop.ensureStopped(stopped, "hard"), await stop.observe(box, stopped)]) expect(result.ok).toBe(false);
  expect(f.resolved).toEqual([]);
  expect(f.calls).toEqual([]);
});
