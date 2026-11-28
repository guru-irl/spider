import * as processApi from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { writeLocal } from "@spider/db-core/roam/local-state";
import * as hc from "@spider/herdr/client/hc";
import type { CoreIdentity } from "@spider/herdr/contracts";
import * as handoff from "@spider/herdr/jobs/handoff";
import * as idLock from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { testTmpDir } from "@spider/intercom/test-support";
import { serveRelocateShutdown } from "../../../host/src/roam/relocate-control";
import { DEFAULT_LIMITS, disabledIntercom, type Clock, type Peer, type RoamConfig, type Transport } from "../contracts";
import { readAwayHomeFence } from "../relocate/away-home";
import { runV0Control } from "../relocate/cli";
import * as processes from "../relocate/local-process";
import { handleRelocateAgent, type RelocateAgentRequest } from "../relocate/remote";
import { createV0Runtime } from "../relocate/runtime";
import { requestV0Services, serveV0Control } from "../relocate/service";
import { createSessionStopStore } from "../relocate/session-stop-store";
import type { StartRequest, StopObservation } from "../relocate/session-stop-types";
import { createHomeSupervisor } from "../relocate/supervisor";
import type { RelocateHome, RelocateId, SessionId, SessionPlacement, StoppedHome, V0Result } from "../relocate/types";
import * as sessionSocket from "../session-socket";
import { deferred } from "./relocate-fakes";

const mac = "11111111-1111-4111-8111-111111111111";
const box = "22222222-2222-4222-8222-222222222222";
const id = "explicit-start" as SessionId;
const moveId = "v0-33333333-3333-4333-8333-333333333333" as RelocateId;
const bootId = "test-boot";
const identity = { pid: 83008, startIdentity: "test-owner" };
const generation = { ...identity, bootId };
const terminal = "test-terminal";
const cleanups: (() => void | Promise<void>)[] = [];
vi.mock("node:child_process", { spy: true });
const realExecFileSync = (await vi.importActual<typeof processApi>("node:child_process")).execFileSync;

afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

async function fixture({ at = box, adopted = false }: { at?: string; adopted?: boolean } = {}) {
  const hub = createReplica("global", mac), replica = createReplica("global", box);
  const target = at === box ? replica : hub;
  const checkout = createReplica("worktree", at), key = checkout.storeKey;
  cleanups.push(hub.close, replica.close, checkout.close);
  let now = 100_000, launched = false, admitted = false;
  const timers = new Map<() => void, number>();
  const clock: Clock = { now: () => now, later(ms, fn) { timers.set(fn, now + ms); return () => { timers.delete(fn); }; } };
  function advance(ms: number) {
    now += ms;
    for (const [run, when] of [...timers]) if (when <= now && timers.delete(run)) run();
  }
  const cwd = join(target.root, "checkout"), file = join(target.root, "exact.jsonl");
  const stamp = "2020-01-01T00:00:00Z";
  const transcript = [
    { type: "session", version: 3, id, cwd, timestamp: stamp },
    { type: "message", id: "entry", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "same session" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  mkdirSync(cwd);
  writeFileSync(file, transcript);
  const placement: SessionPlacement = { sessionId: id, machineId: at, file, cwd, repository: cwd, historyMachine: mac,
    repoKey: "fixture-repo", workspaceId: "fixture-workspace", stores: ["global", key] };
  target.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(cwd);
  target.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(cwd);
  writeLocal(target.db, "mapping-redirect", key, checkout.db.raw.name);
  for (const node of [hub, replica]) node.db.exec("UPDATE roam_meta SET capture_enabled=1");
  recordLocation(target.db, { sessionId: id, stores: placement.stores, file, cwd, home: null });
  writeLocal(target.db, "relocate-managed", id, placement);
  checkout.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
  checkout.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,7,'active')").run(id);
  hub.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state,move_id) VALUES (?,?,7,7,?,?)")
    .run(id, at, adopted ? null : "running", adopted ? null : moveId);
  const member = () => checkout.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(id);
  const launches: { argv: readonly string[]; membership: ReturnType<typeof member>; replica: RelocateHome | null }[] = [];
  let verifiedReplica: RelocateHome | null = null;
  const activations: { home: RelocateHome; replica: RelocateHome | null; verifiedReplica: RelocateHome | null }[] = [];
  const calls: RelocateAgentRequest[] = [];
  let beforeRpc: ((request: RelocateAgentRequest, reply: () => Promise<V0Result<unknown>>) => Promise<V0Result<unknown>>) | undefined;
  let beforeSpawnCheck: (() => void | Promise<void>) | undefined;
  const unused = async () => { throw new Error("Unexpected transport method"); };
  const transport: Transport = {
    bootstrapProbe: unused, run: unused, write: unused,
    async read(_peer, path) { return readFileSync(path); },
    async resolve(peer) { return peer; },
    async exec(peer, argv, options) {
      expect(peer.machineId).toBe(box);
      expect(argv).toEqual(["roam", "agent", "--v0"]);
      const request = JSON.parse(options.stdin!.toString()) as RelocateAgentRequest;
      calls.push(request);
      if (request.kind === "activate") activations.push({ home: request.home, replica: await agent.homes.read(id), verifiedReplica });
      const handle = () => handleRelocateAgent(request, agent.options);
      const reply = await (beforeRpc ? beforeRpc(request, handle) : handle());
      if (request.kind === "home" && reply.ok) verifiedReplica = (reply.value as { home: RelocateHome | null }).home;
      return Buffer.from(JSON.stringify(reply));
    },
  };

  const peer: Peer = { machineId: box, alias: "peer.invalid", node: "peer", pi: "pi", cli: "spider", core: "core", globalRoot: replica.root };
  const hubConfig: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac, peers: [peer], discoveryRoots: [],
    coreUnit: "fixture", syncMs: 120_000, limits: { ...DEFAULT_LIMITS, retryDelaysMs: [] }, intercom: disabledIntercom() };
  const boxConfig: RoamConfig = { ...hubConfig, machineId: box, role: "box", peers: [] };
  vi.stubEnv("SPIDER_GLOBAL_ROOT", hub.root);
  vi.stubEnv("SPIDER_ROAM_PI", process.execPath); // The fake Core observes argv; it never runs the executable.
  vi.stubEnv("HC_SOCKET", join(target.root, "fixture-hc.sock"));
  vi.stubEnv("HC_SESSION", "explicit-start-fixture");
  vi.spyOn(idLock, "localBootId").mockResolvedValue(bootId);
  vi.spyOn(idLock, "inspectIdLock").mockImplementation(async (root, session) =>
    launched && root === join(target.root, "herdr") && session === id ? {
      identity, bootId, pendingOperationId: null, pendingFile: null, pendingCoreId: null, operationId: null,
    } : null);
  const birth = handoff.processStartIdentity;
  let foreignLease = false;
  vi.spyOn(handoff, "processStartIdentity").mockImplementation(pid => pid === identity.pid
    ? (launched || foreignLease ? identity.startIdentity : null) : birth(pid));
  vi.spyOn(processApi, "execFileSync").mockImplementation((cmd, ...args) =>
    cmd === "ps" && Array.isArray(args[0]) && args[0][1] === String(identity.pid) ? "pi\n" : Reflect.apply(realExecFileSync, processApi, [cmd, ...args]));
  vi.spyOn(processes, "locklessPiInCheckout").mockResolvedValue([]);
  const leaseRoot = join(target.root, "herdr"), leases = createSessionLeases(leaseRoot);
  async function claimFixtureLease() {
    await leases.claim(file, identity, { leases, presence: createProcessPresence(leaseRoot), processes: async () => [], probe: async () => ({ kind: "absent" }) }, { mode: "bookkeeping" });
  }
  const terminalRecord = { address: terminal, state: "live", pid: identity.pid, labels: {
    "spider.kind": "session", "spider.session": id, "spider.machine": at, "spider.roam.epoch": "9",
  }, cwd, argv: ["pi", "--session", file] };
  vi.spyOn(hc, "observeCoreIdentity").mockImplementation(async () => {
    await beforeSpawnCheck?.();
    return { coreId: "fixture", socket: join(target.root, "fixture-hc.sock"), sessionNamespace: "explicit-start-fixture" } as CoreIdentity;
  });
  vi.spyOn(hc, "invokeCli").mockImplementation(async (_binary, argv) => {
    if (argv[0] === "ls") return { terminals: launched ? [terminalRecord] : [] };
    if (argv[0] === "get" && argv[1] === terminal) return terminalRecord;
    if (argv[0] !== "run") throw new Error("Unexpected Core command");
    launches.push({ argv, membership: member(), replica: await targetRuntime.homes.read(id) });
    launched = true;
    await claimFixtureLease();
    return { address: terminal };
  });
  const requestControl = sessionSocket.requestSessionControl;
  const ownerSocketRoot = mkdtempSync(join(testTmpDir(), "s8-"));
  cleanups.push(() => rmSync(ownerSocketRoot, { recursive: true, force: true }));
  const inspections: string[] = [];
  vi.spyOn(sessionSocket, "requestSessionControl").mockImplementation(async (root, operation, limits) => {
    if (root !== join(target.root, "roam", "s")) throw new Error("Wrong owner socket root");
    const reply = await requestControl(ownerSocketRoot, operation, limits);
    inspections.push(reply.reason);
    return reply;
  });
  const gitRun = async (_cwd: string, argv: readonly string[]) => {
    if (argv.join(" ") !== "git rev-parse --show-toplevel") throw new Error("Unexpected git command");
    return Buffer.from(cwd);
  };
  const agent = createV0Runtime(replica.root, { clock, transport, gitRun, openCore: () => ({ config: boxConfig, root: replica.root, db: replica.db, close() {} }) });
  const runtime = createV0Runtime(hub.root, { clock, transport, gitRun, liveHub: true, openCore: () => ({ config: hubConfig, root: hub.root, db: hub.db, close() {} }) });
  const targetRuntime = at === box ? agent : runtime;
  cleanups.push(() => agent.close(), () => runtime.close());
  const socket = await serveRelocateShutdown({ sessionId: id, machineId: at, runtimeRoot: ownerSocketRoot, admittedEpoch: 9,
    home: () => targetRuntime.homes.read(id), admittedOwner: async () => admitted && launched && await leases.get(file) ? generation : null,
    shutdown: async () => { throw new Error("Start inspection cannot shut down pi"); } });
  cleanups.push(() => socket.close());

  const cache = createSessionStopStore(hub.db);
  const running = adopted ? await runtime.homes.initialize(id, at) : await runtime.homes.read(id);
  if (running?.state !== "running") throw new Error("Expected initial running home");
  const stopped: StoppedHome = { ...running, state: "stopped", epoch: 8, updatedAt: now };
  expect(await runtime.homes.compareAndSwap(running, stopped)).toEqual({ kind: "applied", home: stopped });
  if (at === box) await runtime.sync.sync(box);
  const proof = await targetRuntime.adapters.stop.enforceLocal(stopped);
  expect(proof.evidence).toEqual({ kind: "confirmed", owner: null });
  const saveStop = (observations: readonly StopObservation[], displaced: readonly string[] = []) => cache.write({ action: "stop", operationId: "stop-8",
    expected: running, committed: stopped, mode: "hard", displaced, observations, contactReason: null });
  saveStop([proof]);
  calls.length = 0;
  advance(0); // Drain the setup sync's contact snapshot (which had no pending operation).
  const request: StartRequest = { operationId: "start-8", sessionId: id, machineId: at, homeEpoch: 8 };
  return { runtime, targetRuntime, hub, hubConfig, cache, stopped, request, clock, advance, member, calls, activations, launches, inspections, proof, saveStop, placement, terminalRecord,
    rpc(fn: typeof beforeRpc) { beforeRpc = fn; },
    beforeSpawn(fn: typeof beforeSpawnCheck) { beforeSpawnCheck = fn; },
    admit() { admitted = true; },
    async leaseFromAnotherOwner() { foreignLease = true; await claimFixtureLease(); },
    async exit() {
      launched = false;
      const lease = await leases.get(file);
      if (lease) await leases.release(file, lease.token, { mode: "bookkeeping" });
    },
    async tick() {
      const supervisor = createHomeSupervisor(targetRuntime.adapters.supervisor, () => {});
      try { await supervisor.tick(); } finally { await supervisor.stop(); }
    },
  };
}

it("keeps moveId and publishes before activation", async () => {
  const f = await fixture();
  const awaitingExactOwner = await f.runtime.startSession(f.request);
  const issuedHome = await f.runtime.homes.read(id);
  expect(issuedHome).toMatchObject({ state: "running", epoch: 9, moveId });
  expect(f.activations).toEqual([{ home: issuedHome, verifiedReplica: issuedHome, replica: issuedHome }]);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).toMatchObject({ replica: issuedHome, membership: { state: "active", epoch: 9 } });
  expect(f.launches[0].argv.slice(-2)).toEqual(["--session", f.placement.file]);
  expect(awaitingExactOwner).toMatchObject({ status: "starting", outcome: "pending" });
  expect(f.inspections).toEqual(["owner-conflict"]);
  expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "starting", observedAt: null });
  expect(await readAwayHomeFence(f.hub.root, id)).toEqual({ machineId: box, epoch: 9, moveId });

  f.admit(); f.advance(13);
  const ownerCheckedAt = f.clock.now();
  const confirmed = await f.runtime.startSession(f.request);
  expect(confirmed).toMatchObject({ status: "running", outcome: "complete", observedAt: ownerCheckedAt });
  expect(f.calls.filter(r => r.kind === "confirm").at(-1)).toEqual({ version: 1, kind: "confirm", exact: true, admitted: true, home: issuedHome, placement: f.placement });
  expect(f.launches).toHaveLength(1);
});

it.each(["exact", "admitted"] as const)("does not complete from a successful confirmation missing %s", async flag => {
  const f = await fixture();
  f.admit();
  f.rpc(async (request, handle) => {
    const reply = await handle();
    if (request.kind === "confirm" && reply.ok) {
      const value = { ...reply.value as Record<string, unknown> };
      delete value[flag];
      return { ok: true, value };
    }
    return reply;
  });
  expect(await f.runtime.startSession(f.request)).toMatchObject({ outcome: "pending", status: "starting", observedAt: null });
  expect(f.inspections).toContain("session-inspect");
  expect(f.launches).toHaveLength(1);
});

it("a delayed Start cannot spawn after the next Stop", async () => {
  const f = await fixture();
  const held = deferred(), release = deferred();
  f.rpc(async (request, handle) => {
    const reply = await handle();
    if (request.kind === "home" && reply.ok && (reply.value as { home: RelocateHome }).home.epoch === 9) {
      held.resolve(); await release.promise;
    }
    return reply;
  });
  const delayed = f.runtime.startSession(f.request);
  try {
    expect(await Promise.race([held.promise.then(() => "held"), delayed.then(() => "settled")])).toBe("held");
    const stopped = f.runtime.stopSession({ ...f.request, operationId: "stop-10", homeEpoch: 9, mode: "hard" });
    await vi.waitFor(async () => expect(await f.targetRuntime.homes.read(id)).toMatchObject({ state: "stopped", epoch: 10 }));
    await f.targetRuntime.adapters.stop.enforceLocal((await f.targetRuntime.homes.read(id)) as StoppedHome);
    f.advance(10_000);
    release.resolve();
    expect(await delayed).toMatchObject({ outcome: "refused", homeEpoch: 10 });
    f.advance(DEFAULT_LIMITS.readyMs);
    await stopped;
    expect(await f.runtime.homes.read(id)).toMatchObject({ state: "stopped", epoch: 10 });
    expect(f.activations).toEqual([]);
    expect(f.launches).toEqual([]);
  } finally { release.resolve(); }
});

it.each([false, true])("replays a lost CAS reply at epoch 9 (owner already present: %s)", async ownerExists => {
  const f = await fixture();
  const swap = f.runtime.homes.compareAndSwap;
  let cas = 0;
  f.runtime.homes.compareAndSwap = async (...args) => {
    const result = await swap(...args);
    if (++cas === 1) throw new Error("Start CAS reply lost");
    return result;
  };
  f.admit();
  await f.runtime.startSession(f.request).catch(() => {});
  expect(await f.runtime.homes.read(id)).toMatchObject({ state: "running", epoch: 9 });
  expect(f.cache.operation(f.request.operationId)).toMatchObject({ action: "start", request: f.request, committed: { epoch: 9 } });
  if (ownerExists) { await f.runtime.sync.sync(box); await f.tick(); }
  expect(await f.runtime.startSession(f.request)).toMatchObject({ status: "running", outcome: "complete", homeEpoch: 9 });
  expect(await f.targetRuntime.homes.read(id)).toEqual(await f.runtime.homes.read(id));
  expect(cas).toBe(1);
  expect(f.launches).toHaveLength(1);
  expect(await f.runtime.startSession({ ...f.request, homeEpoch: 9 })).toMatchObject({ outcome: "refused" });
});

it.each(["missing placement", "pending Stop", "stale epoch", "old agent", "displaced", "new terminal"] as const)("refuses Start with %s without granting a home", async why => {
  const f = await fixture();
  let request = f.request;
  if (why === "missing placement") writeFileSync(f.placement.file, "not the session\n");
  if (why === "pending Stop") f.saveStop([]);
  if (why === "stale epoch") request = { ...request, homeEpoch: 7 };
  if (why === "old agent") f.rpc(async (r, handle) => r.kind === "hello"
    ? { ok: true, value: { version: 1, machineId: box, spider: true, pi: true } } : handle());
  if (why === "displaced") f.saveStop([f.proof], [mac]);
  if (why === "new terminal") vi.mocked(hc.invokeCli).mockImplementation(async () => ({ terminals: [{ address: "new", state: "live", pid: identity.pid, labels: {} }] }));
  expect(await f.runtime.startSession(request)).toMatchObject({ outcome: "refused" });
  expect(await f.runtime.homes.read(id)).toEqual(f.stopped);
  expect(await f.targetRuntime.homes.read(id)).toEqual(f.stopped);
  expect(f.cache.operation(request.operationId)).toBeNull();
  expect(f.activations).toEqual([]);
  expect(f.launches).toEqual([]);
});

it("does not grant an away epoch without a move ID", async () => {
  const f = await fixture({ adopted: true });
  const cas = vi.spyOn(f.runtime.homes, "compareAndSwap");
  expect(f.stopped.moveId).toBeNull();
  expect(await f.runtime.startSession(f.request)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("relocate") });
  expect(await f.runtime.homes.read(id)).toEqual(f.stopped);
  expect(await readAwayHomeFence(f.hub.root, id)).toBeNull();
  expect(cas).not.toHaveBeenCalled();
  expect(f.activations).toEqual([]);
  expect(f.launches).toEqual([]);
});

it("records exact admission on box contact after its supervisor launches", async () => {
  const f = await fixture();
  f.rpc(async (r, handle) => {
    if (r.kind === "start") throw new Error("Launch delivery lost");
    return handle();
  });
  expect(await f.runtime.startSession(f.request)).toMatchObject({ status: "starting", outcome: "pending" });
  expect(f.launches).toEqual([]);
  f.admit(); await f.tick();
  f.advance(5);
  await f.runtime.sync.sync(box);
  f.advance(0);
  await vi.waitFor(async () => expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "running", observedAt: f.clock.now() }));
  expect(f.launches).toHaveLength(1);
});

it("starts on the Mac at the next epoch and only explicit Start restarts that epoch", async () => {
  const f = await fixture({ at: mac, adopted: true });
  f.admit();
  expect(await f.runtime.startSession(f.request)).toMatchObject({ status: "running", outcome: "complete", homeEpoch: 9 });
  expect(await f.runtime.homes.read(id)).toMatchObject({ state: "running", epoch: 9, moveId: null });
  await f.exit();
  f.runtime.resumeSessionStops(); f.advance(0);
  expect(await f.runtime.startSession(f.request)).toMatchObject({ outcome: "complete", homeEpoch: 9 });
  expect(f.launches).toHaveLength(1);
  expect(await f.runtime.startSession({ ...f.request, operationId: "start-9", homeEpoch: 9 })).toMatchObject({ outcome: "complete", homeEpoch: 9 });
  expect(f.launches).toHaveLength(2);
  expect(f.calls).toEqual([]);
});

it("a pending Mac Start records late admission without another launch or request", async () => {
  const f = await fixture({ at: mac, adopted: true });
  expect(await f.runtime.startSession(f.request)).toMatchObject({ status: "starting", outcome: "pending" });
  expect(f.launches).toHaveLength(1);
  f.admit(); f.advance(1_000);
  await vi.waitFor(async () => expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "running", observedAt: f.clock.now() }));
  expect(f.launches).toHaveLength(1);
  expect(f.calls).toEqual([]);
});

it.each(["file", "lease", "home", "terminal"] as const)("checks the exact %s again before the native spawn", async changes => {
  const f = await fixture();
  f.beforeSpawn(async () => {
    if (changes === "file") writeFileSync(f.placement.file, "replaced after placement verification\n");
    if (changes === "lease") await f.leaseFromAnotherOwner();
    if (changes === "terminal") {
      const invoke = vi.mocked(hc.invokeCli).getMockImplementation()!;
      vi.mocked(hc.invokeCli).mockImplementation((binary, argv, ...rest) => argv[0] === "ls"
        ? Promise.resolve({ terminals: [f.terminalRecord] }) : invoke(binary, argv, ...rest));
    }
    if (changes === "home") {
      const home = await f.runtime.homes.read(id);
      if (home?.state !== "running") throw new Error("Expected published running home");
      const stopped: StoppedHome = { ...home, state: "stopped", epoch: 10 };
      await f.runtime.homes.compareAndSwap(home, stopped);
      await f.runtime.sync.sync(box);
    }
  });
  const result = await f.runtime.startSession(f.request);
  expect(result.outcome).not.toBe("complete");
  expect(f.launches).toEqual([]);
});

it("the box rejects activation under the stopped predecessor", async () => {
  const f = await fixture();
  const granted = { ...f.stopped, state: "running", epoch: 9 } as const;
  expect(await handleRelocateAgent({ version: 1, kind: "activate", home: granted, placement: f.placement }, f.targetRuntime.options))
    .toMatchObject({ ok: false, refusal: { code: "home-conflict" } });
  expect(f.member()).toEqual({ state: "frozen", epoch: 8 });
});

it("reports the cached Stop without a terminal, through the relocate socket and CLI", async () => {
  const f = await fixture();
  writeFileSync(f.placement.file, "unavailable copy\n");
  const server = await serveV0Control(f.hub.root, f.runtime.services);
  try {
    const client = requestV0Services(f.hub.root);
    expect(await client.relocate({ sessionId: id, destinationMachine: box })).toEqual({ ok: true, value: {
      home: f.stopped, moveId, disposition: "already-home", stop: await f.runtime.sessionStatus(id),
    } });
    const out: string[] = [], err: string[] = [];
    expect(await runV0Control({ kind: "relocate", session: id, machine: box }, f.hubConfig, [{ id, name: null }], client,
      { out: line => out.push(line), err: line => err.push(line), confirmation: async () => null })).toBe(0);
    expect(out.join("")).toMatch(/stopped/i);
    expect(out.join("")).not.toMatch(/terminal/i);
    expect(err).toEqual([]);
    expect(f.launches).toEqual([]);
  } finally { await server.close(); }
});

it("rejects a stopped relocate reply that claims a running terminal", async () => {
  const f = await fixture();
  const server = await serveV0Control(f.hub.root, {
    ...f.runtime.services,
    async relocate() {
      const stop = await f.runtime.sessionStatus(id);
      return { ok: true, value: { home: f.stopped, moveId, disposition: "already-home", stop, terminal } };
    },
  });
  try { await expect(requestV0Services(f.hub.root).relocate({ sessionId: id, destinationMachine: box })).rejects.toThrow(/invalid v0 relocate reply/i); }
  finally { await server.close(); }
});
