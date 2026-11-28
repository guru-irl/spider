import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "@spider/db-core";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { createReplica } from "@spider/db-core/testutil";
import * as hc from "@spider/herdr/client/hc";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { main } from "../cli";
import { DEFAULT_LIMITS, disabledIntercom, type Clock, type Peer, type RoamConfig, type Transport } from "../contracts";
import { readAwayHomeFence, withAwayHomeFenceLock, publishAwayHomeFence } from "../relocate/away-home";
import { createLocalIO, createLocalRuntime } from "../relocate/local";
import * as processes from "../relocate/local-process";
import { handleRelocateAgent, type RelocateAgentRequest } from "../relocate/remote";
import { createV0Runtime, type V0Runtime } from "../relocate/runtime";
import { createSessionStopStore } from "../relocate/session-stop-store";
import type { StopObservation } from "../relocate/session-stop-types";
import { setHome } from "../relocate/set-home";
import { requestV0Services, serveV0Control } from "../relocate/service";
import type { MovingHome, RelocateHome, RelocateId, SessionId, SessionPlacement, StoppedHome, V0Result } from "../relocate/types";
import { deferred } from "./relocate-fakes";

const macId = "11111111-1111-4111-8111-111111111111";
const aId = "22222222-2222-4222-8222-222222222222";
const bId = "33333333-3333-4333-8333-333333333333";
const cId = "44444444-4444-4444-8444-444444444444";
const id = "stopped-force" as SessionId;
const moveId = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId;
const running = { sessionId: id, machineId: aId, state: "running", epoch: 7, destination: null, updatedAt: 7, moveId } as const;
const moving: MovingHome = { ...running, state: "moving", destination: macId, epoch: 8, updatedAt: 8 };
const macSourceHome: StoppedHome = { ...running, state: "stopped", machineId: macId, epoch: 8, updatedAt: 8, moveId: null };
const request = (destinationMachine: string) => ({ sessionId: id, destinationMachine, force: true,
  confirmation: `reassign ${id} to ${destinationMachine}; source will not run` });

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

function clockFixture() {
  let now = 100_000;
  const timers = new Map<() => void, number>();
  const clock: Clock = { now: () => now, later(ms, fn) { timers.set(fn, now + ms); return () => { timers.delete(fn); }; } };
  return { clock, tick() {
    now++;
    for (const [run, at] of [...timers]) if (at <= now && timers.delete(run)) run();
  }, hasRound: () => [...timers.values()].some(at => at - now > 10_000) };
}

function useSyntheticTerminals() {
  vi.stubEnv("HC_SOCKET", resolve(".spider/scratch/stopped-force-hc.sock"));
  vi.stubEnv("HC_SESSION", "stopped-force-fixture");
  const launched: string[] = [];
  vi.spyOn(hc, "invokeCli").mockImplementation(async (_binary, argv) => {
    if (argv[0] === "ls") return { terminals: [] };
    launched.push(argv.join(" "));
    throw new Error(`Unexpected Core operation: ${argv[0]}`);
  });
  return launched;
}

function fixture(initial: RelocateHome = running, enabled = true) {
  const time = clockFixture();
  const global = [macId, aId, bId, cId].map(machine => createReplica("global", machine));
  const worktrees = global.map(node => createReplica("worktree", node.machineId));
  cleanup.push(...[...global, ...worktrees].map(replica => replica.close));
  const [hub, from, to, next] = global;
  const launched = useSyntheticTerminals();
  const membership = (machine: string) => worktrees.find(replica => replica.machineId === machine)!.db
    .prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(id);
  for (const [i, node] of global.entries()) {
    const worktree = worktrees[i], key = worktree.storeKey;
    const cwd = join(node.root, "checkout"), file = join(node.root, "session.jsonl");
    mkdirSync(cwd);
    const timestamp = "2020-01-01T00:00:00Z";
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd, timestamp }) + "\n" +
      JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "force copy" }] } }) + "\n");
    const placement: SessionPlacement = { sessionId: id, machineId: node.machineId, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
      repository: cwd, cwd, file, stores: ["global", key], historyMachine: aId };
    node.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(cwd);
    node.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(cwd);
    writeLocal(node.db, "mapping-redirect", key, worktree.db.raw.name);
    writeLocal(node.db, "relocate-managed", id, placement);
    recordLocation(node.db, { sessionId: id, stores: placement.stores, file, cwd, home: null });
    worktree.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
    worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,?,?)")
      .run(id, initial.epoch, node.machineId === initial.machineId && initial.state === "running" ? "active" : "frozen");
    node.db.exec("UPDATE roam_meta SET capture_enabled=1");
  }
  hub.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state,destination,move_id) VALUES (?,?,?,?,?,?,?)")
    .run(id, initial.machineId, initial.epoch, initial.updatedAt, initial.state, initial.destination, initial.moveId);
  const peers: Peer[] = [from, to, next].map(({ machineId, root }) => ({ machineId, globalRoot: root,
    alias: `box-${machineId[0]}.invalid`, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/core" }));
  const config: RoamConfig = { role: "hub", enabled, machineId: macId, hubMachineId: macId, peers, discoveryRoots: [], coreUnit: "fixture",
    syncMs: 120_000, limits: { ...DEFAULT_LIMITS, retryDelaysMs: [] }, intercom: disabledIntercom() };
  const agents = new Map<string, V0Runtime>();
  const offline = new Set([aId]);
  const replies = new Map<string, (home: StoppedHome) => Promise<V0Result<unknown>> | V0Result<unknown>>();
  const confirming = new Set<string>();
  const calls: { machine: string; input: RelocateAgentRequest }[] = [];
  const opUnavailable = async () => { throw new Error("Unexpected transport operation"); };
  const verifyOnline = (machine: string) => { if (offline.has(machine)) throw Object.assign(new Error("Offline"), { code: "ENETUNREACH" }); };
  const transport: Transport = {
    bootstrapProbe: opUnavailable, run: opUnavailable, write: opUnavailable,
    async read(_peer, file) { return readFileSync(file); },
    async resolve(peer) { verifyOnline(peer.machineId); return peer; },
    async exec(peer, argv, options) {
      const machine = peer.machineId;
      expect(argv).toEqual(["roam", "agent", "--v0"]);
      verifyOnline(machine);
      const agent = agents.get(machine)!;
      const input = JSON.parse(options.stdin!.toString()) as RelocateAgentRequest;
      calls.push({ machine, input });
      if (input.kind === "session-observation") {
        const reply = replies.get(machine);
        if (reply) return Buffer.from(JSON.stringify(await reply(input.home)));
        if (confirming.has(machine)) await agent.adapters.stop.enforceLocal(input.home);
      }
      return Buffer.from(JSON.stringify(await handleRelocateAgent(input, agent.options)));
    },
  };
  for (const node of global) {
    const localConfig: RoamConfig = node === hub ? config : { ...config, enabled: true, role: "box", machineId: node.machineId, peers: [] };
    const runtime = createV0Runtime(node.root, { clock: time.clock, transport, liveHub: node === hub,
      gitRun: async cwd => Buffer.from(`${cwd}\n`), // Each isolated checkout is its own root.
      openCore: () => ({ config: localConfig, root: node.root, db: node.db, close() {} }) });
    agents.set(node.machineId, runtime);
    cleanup.push(() => runtime.close());
  }
  const runtime = agents.get(macId)!;
  const store = createSessionStopStore(hub.db);
  return { hub, runtime, store, membership, config, offline, launched, confirming, replies,
    agent: (machine: string) => agents.get(machine)!,
    status: () => runtime.sessionStatus(id), force: (machine: string) => runtime.services.setHome(request(machine)),
    stopOnA: () => runtime.stopSession({ operationId: "stop-on-a", sessionId: id, machineId: aId, homeEpoch: 7, mode: "graceful" }),
    start: (machineId: string, homeEpoch: number, operationId: string) => runtime.startSession({ operationId, sessionId: id, machineId, homeEpoch }),
    async receive(machine: string, reply?: (home: StoppedHome) => Promise<V0Result<unknown>> | V0Result<unknown>) {
      if (reply) replies.set(machine, reply); else replies.delete(machine);
      offline.delete(machine);
      const observed = () => calls.filter(({ input, machine: from }) => from === machine && input.kind === "session-observation").length;
      const before = observed();
      const synced = await runtime.sync.sync(machine);
      expect(await agents.get(machine)!.homes.read(id)).toEqual(await runtime.homes.read(id));
      time.tick();
      await vi.waitFor(() => { expect(observed()).toBe(before + 1); expect(time.hasRound()).toBe(false); });
      return synced;
    },
    get activationOrLaunch() { return [...launched, ...calls.filter(({ input }) => input.kind === "activate" || input.kind === "start")]; },
    observation(home: StoppedHome, evidence: StopObservation["evidence"] = { kind: "confirmed", owner: null }): V0Result<unknown> {
      const observation: StopObservation = { sessionId: id, machineId: aId, home, observedAt: time.clock.now(), bootId: "a-boot", evidence };
      return { ok: true, value: { version: 1, observation } };
    },
  };
}

it("B confirming does not clear an unreachable A", async () => {
  const f = fixture();
  expect(await f.stopOnA()).toMatchObject({ status: "stop-pending", homeEpoch: 8 });
  const old = await f.runtime.homes.read(id);
  if (old?.state !== "stopped") throw new Error("Expected the saved Stop on A");
  f.confirming.add(bId);
  const assignment = await f.force(bId);
  expect(await f.runtime.homes.read(id)).toMatchObject({ machineId: bId, state: "stopped", epoch: 9 });
  expect(assignment).toMatchObject({ ok: true, value: { machineId: bId, state: "stopped", epoch: 9 } });
  const atB = await f.status();
  expect(atB).toMatchObject({ status: "stop-pending", reason: `Stopped on ${bId}. ${aId} may still be running.` });
  const startBeforeA = await f.start(bId, 9, "before-a");
  expect(startBeforeA.outcome).toBe("refused");
  expect(f.membership(bId)).toEqual({ state: "frozen", epoch: 9 });

  const receipts = await f.receive(aId, () => ({ ok: true, value: { version: 1, pending: true } }));
  expect(receipts).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 0, value: expect.objectContaining({ sha256: expect.any(String) }) }),
  ]));
  const statusAfterReceipt = await f.status();
  expect(statusAfterReceipt.status).toBe("stop-pending");
  await f.receive(aId, () => f.observation(old));
  const statusAfterOldRow = await f.status();
  expect(statusAfterOldRow.status).toBe("stop-pending");
  await f.receive(aId, home => f.observation(home, { kind: "pending", reason: "The owner is unverified.", blockers: [] }));
  const statusWithAUnknown = await f.status();
  expect(statusWithAUnknown.status).toBe("stop-pending");
  expect((await f.start(bId, 9, "a-unknown")).outcome).toBe("refused");
  expect(await f.runtime.homes.read(id)).toEqual(assignment.ok && assignment.value);
  f.confirming.add(aId);
  await f.receive(aId);
  const statusAfterA = await f.status();
  expect(statusAfterA.status).toBe("stopped");
  expect(f.membership(aId)).toEqual({ state: "frozen", epoch: 9 });
  expect(f.activationOrLaunch).toEqual([]);
});

it("does not clear a displaced machine with an unverified child from the previous Stop epoch", async () => {
  const f = fixture();
  await f.stopOnA();
  const old = await f.runtime.homes.read(id);
  if (old?.state !== "stopped") throw new Error("Expected the saved Stop on A");
  f.offline.delete(aId);
  await f.runtime.sync.sync(aId);
  expect(await f.agent(aId).homes.read(id)).toEqual(old);
  const { options } = f.agent(aId), bootId = "a-boot";
  const child = { pid: 82311, startIdentity: "child-birth", kind: "unclassified" };
  const lateOwner = { pid: 82312, startIdentity: "late-owner" };
  const lateChild = { pid: 82313, startIdentity: "late-child", command: "tool", ancestryVerified: false } as const;
  let childUnknown = true, lateOwnerLive = false, lateChildUnknown = true;
  const signal = vi.fn(async (pid: number) => {
    if (pid !== lateOwner.pid) throw new Error("An unverified child must not be signalled");
    lateOwnerLive = false;
  });
  const local = createLocalRuntime(options, { ...createLocalIO(options), bootId: async () => bootId,
    async inspect() {
      return lateOwnerLive ? { identity: lateOwner, bootId, pendingOperationId: null, pendingFile: null, pendingCoreId: null, operationId: null } : null;
    },
    async probe(pid) {
      if (pid === child.pid) return childUnknown ? { kind: "unknown" } : { kind: "live", startIdentity: "replacement-birth", pi: false };
      if (pid === lateOwner.pid && lateOwnerLive) return { kind: "live", startIdentity: lateOwner.startIdentity, pi: true };
      if (pid === lateChild.pid && lateChildUnknown) return { kind: "unknown" };
      return { kind: "absent" };
    },
    async tree() { return { groups: [], descendants: [lateChild] }; },
    signal,
  });
  // The old owner exited after capture. The child's identity remains unverified,
  // and it has no separate run row or detached-job journal.
  const pending = { kind: "pending", reason: "Local session work has not been verified absent.",
    blockers: [{ kind: "check", reason: `A captured process is still present or unverified (PID ${child.pid}).` }] } as const;
  writeLocal(options.globalDb, "relocate-stop-proof", id, { home: old, bootId, observedAt: options.clock.now(), evidence: pending,
    capture: { owner: { pid: 82310, startIdentity: "owner-birth", bootId }, terminal: null, children: [child] } });
  expect(await local.observeStopped(old)).toMatchObject({ evidence: pending });
  f.offline.add(aId);
  f.confirming.add(bId);
  expect(await f.force(bId)).toMatchObject({ ok: true, value: { state: "stopped", epoch: 9 } });
  const check = async (home: StoppedHome) => ({ ok: true, value: { version: 1, observation: await local.enforceStopped(home) } }) as const;
  await f.receive(aId, check);
  expect(await f.status()).toMatchObject({ status: "stop-pending", reason: expect.stringContaining(aId) });
  expect((await f.start(bId, 9, "previous-child-unknown")).outcome).toBe("refused");
  lateOwnerLive = true;
  await f.receive(aId, check); // A late owner has its own process tree.
  expect(signal.mock.calls).toEqual([[lateOwner.pid, "SIGTERM"]]);
  expect(await f.status()).toMatchObject({ status: "stop-pending" });

  f.offline.add(aId);
  f.confirming.add(cId);
  expect(await f.force(cId)).toMatchObject({ ok: true, value: { state: "stopped", epoch: 10 } });
  await f.receive(aId, check);
  const latest = await f.runtime.homes.read(id);
  if (latest?.state !== "stopped") throw new Error("Expected the saved force to C");
  expect((await local.observeStopped(latest)).evidence).toMatchObject({ kind: "pending", blockers: [
    { kind: "check", reason: `A captured process is still present or unverified (PID ${child.pid}).` },
    { kind: "check", reason: `A captured process is still present or unverified (PID ${lateChild.pid}).` },
  ] });
  expect(await f.status()).toMatchObject({ status: "stop-pending", reason: expect.stringContaining(aId) });
  lateChildUnknown = false;
  await f.receive(aId, check);
  expect(await f.status()).toMatchObject({ status: "stop-pending" });
  expect((await f.start(cId, 10, "earlier-child-unknown")).outcome).toBe("refused");
  childUnknown = false; // The first child's PID was reused with a different process birth identity.
  await f.receive(aId, check);
  expect(await f.status()).toMatchObject({ status: "stopped" });
  expect(signal.mock.calls).toEqual([[lateOwner.pid, "SIGTERM"]]);
});

it("a second force retains both unverified machines and cannot make the session runnable", async () => {
  const f = fixture();
  await f.stopOnA();
  expect(await f.force(bId)).toMatchObject({ ok: true, value: { state: "stopped", epoch: 9 } });
  expect(f.membership(bId)).toEqual({ state: "frozen", epoch: 7 });
  f.offline.add(bId);
  f.confirming.add(cId);
  const latest = await f.force(cId);
  expect(latest).toMatchObject({ ok: true, value: { state: "stopped", epoch: 10 } });
  const statusAfterSecondForce = await f.status();
  expect(statusAfterSecondForce.reason).toContain(aId);
  expect(statusAfterSecondForce.reason).toContain(bId);
  expect(f.store.current(id)).toMatchObject({ action: "force", mode: "graceful", displaced: [aId, bId], committed: { epoch: 10 } });
  expect((await f.start(cId, 10, "before-a-and-b")).outcome).toBe("refused");
  expect(await f.runtime.homes.read(id)).toEqual(latest.ok && latest.value);
  expect(f.activationOrLaunch).toEqual([]);
});

it("does not add the old home or carry forward a displacement that already proved exact exit", async () => {
  const f = fixture();
  await f.stopOnA();
  f.confirming.add(bId);
  expect(await f.force(bId)).toMatchObject({ ok: true, value: { state: "stopped" } });
  f.confirming.add(aId);
  await f.receive(aId);
  expect(await f.status()).toMatchObject({ status: "stopped" });
  f.offline.add(aId); f.offline.add(bId); f.confirming.add(cId);
  expect(await f.force(cId)).toMatchObject({ ok: true, value: { state: "stopped" } });
  expect(f.store.current(id)).toMatchObject({ action: "force", displaced: [] });
  expect(await f.status()).toMatchObject({ status: "stopped", machineId: cId });
});

it("does not hold the force lock while waiting for exit proof", async () => {
  const f = fixture();
  await f.stopOnA();
  const reached = deferred(), release = deferred();
  f.replies.set(bId, async () => { reached.resolve(); await release.promise; return { ok: true, value: { version: 1, pending: true } }; });
  const assignment = f.force(bId);
  try {
    const first = await Promise.race([reached.promise.then(() => "observing"), assignment.then(() => "finished")]);
    expect(first).toBe("observing");
    expect(await f.runtime.homes.read(id)).toMatchObject({ state: "stopped", machineId: bId, epoch: 9 });
    expect(f.store.current(id)).toMatchObject({ action: "force", committed: { state: "stopped", epoch: 9 }, displaced: [aId], observations: [] });
    expect((await f.start(bId, 9, "during-contact")).outcome).toBe("refused");
  } finally { release.resolve(); await assignment; }
});

it("rolls back the force CAS when the displacement record cannot be saved", async () => {
  const f = fixture();
  await f.stopOnA();
  const before = await f.runtime.homes.read(id), record = f.store.current(id);
  f.hub.db.exec(`CREATE TEMP TRIGGER fail_force_record BEFORE INSERT ON roam_cursors
    WHEN NEW.peer_machine = '' AND NEW.peer_stream LIKE 'spider-local:session-transition:%'
    BEGIN SELECT RAISE(ABORT, 'fixture cannot save force record'); END`);
  const reply = await f.force(bId);
  expect(await f.runtime.homes.read(id)).toEqual(before);
  expect(f.store.current(id)).toEqual(record);
  expect(reply).toMatchObject({ ok: false, refusal: { code: "home-unavailable" } });
  expect(f.activationOrLaunch).toEqual([]);
});

it("refuses a stopped placement when there is no atomic stopped commit port", async () => {
  const f = fixture(macSourceHome);
  expect(await setHome(request(bId), f.runtime.adapters.setHome, f.config)).toMatchObject({ ok: false, refusal: { code: "home-unavailable" } });
  expect(await f.runtime.homes.read(id)).toEqual(macSourceHome);
  expect(f.activationOrLaunch).toEqual([]);
});

it("checks Mac source writers before an away stopped assignment without publishing a fence", async () => {
  const f = fixture(macSourceHome);
  let localWriters = ["PID 912 (pi)"];
  vi.spyOn(processes, "locklessPiInCheckout").mockImplementation(async () => {
    expect((await inspectIdLock(join(f.hub.root, "herdr"), id))?.identity.pid).toBe(process.pid);
    return localWriters;
  });
  const refused = await f.force(bId);
  const homeWithWriters = await f.runtime.homes.read(id);
  expect(refused).toMatchObject({ ok: false, refusal: { code: "session-busy", nextStep: expect.stringContaining("set-home --force") } });
  expect(homeWithWriters).toEqual(macSourceHome);
  expect(await readAwayHomeFence(f.hub.root, id)).toBeNull();
  localWriters = [];
  f.confirming.add(bId);
  expect(await f.force(bId)).toMatchObject({ ok: true, value: { state: "stopped", epoch: 9 } });
  expect(await readAwayHomeFence(f.hub.root, id)).toBeNull();
});

it("leaves an existing away fence intact", async () => {
  const f = fixture();
  await withAwayHomeFenceLock(f.hub.root, id, () => publishAwayHomeFence(f.hub.root, id, { machineId: aId, epoch: 7, moveId }));
  const awayFenceBefore = await readAwayHomeFence(f.hub.root, id);
  expect(awayFenceBefore).toEqual({ machineId: aId, epoch: 7, moveId });
  await f.stopOnA();
  f.confirming.add(bId);
  const reassigned = await f.force(bId);
  const awayFenceAfter = await readAwayHomeFence(f.hub.root, id);
  expect(awayFenceAfter).toEqual(awayFenceBefore);
  expect(reassigned).toMatchObject({ ok: true, value: { state: "stopped", machineId: bId, epoch: 9 } });
});

it.each(["ahead", "equal"] as const)("refuses repeated stopped force while a durable fence is %s", async relation => {
  const f = fixture(moving);
  const firstForceMove = "v0-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as RelocateId;
  const recordedFence = { machineId: bId, epoch: 9, moveId: firstForceMove };
  f.hub.db.exec(`CREATE TEMP TRIGGER fail_running_force BEFORE UPDATE ON session_homes
    WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT, 'fixture interrupted first force'); END`);
  // Before stopped force, force on a moving home could publish a running fence before its CAS.
  await expect(f.runtime.homes.compareAndSwap(moving, { ...moving, ...recordedFence, destination: null, state: "running" }))
    .rejects.toThrow("fixture interrupted first force");
  if (relation === "equal") await f.runtime.homes.compareAndSwap(moving, { ...moving, state: "stopped", epoch: 9, destination: null });
  const before = await f.runtime.homes.read(id), fenceBefore = await readAwayHomeFence(f.hub.root, id);
  expect(fenceBefore).toEqual(recordedFence);
  const countChanges = () => f.hub.db.prepare("SELECT count(*) AS changes FROM roam_changes WHERE entity='session_homes'").get();
  const changes = countChanges();
  for (const machine of [macId, cId]) {
    const reply = await f.force(machine);
    expect(await f.runtime.homes.read(id)).toEqual(before);
    expect(reply).toEqual({ ok: false, refusal: { code: "home-unavailable", message: `The database cannot verify the away home on ${bId}.`,
      nextStep: "Restore spider.db or re-sync it from a peer. Then retry set-home --force on the Mac." } });
    expect(await readAwayHomeFence(f.hub.root, id)).toEqual(fenceBefore);
    expect(f.store.current(id)).toBeNull();
    expect(countChanges()).toEqual(changes);
  }
  expect(f.activationOrLaunch).toEqual([]);
});

it("recovers a moving home as stopped on the Mac without the disabled hub", async () => {
  const f = fixture(moving, false);
  // Production one-shot recovery opens spider.db and checks the private identity files.
  const runtimeRoot = mkdtempSync(join(resolve(".spider/scratch"), "sf-"));
  cleanup.push(() => rmSync(runtimeRoot, { force: true, recursive: true }));
  const roam = join(runtimeRoot, "roam");
  mkdirSync(roam, { mode: 0o700 });
  writeFileSync(join(roam, "config.json"), JSON.stringify(f.config), { mode: 0o600 });
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: macId }), { mode: 0o600 });
  const sqlite = join(runtimeRoot, "spider.db");
  f.hub.db.exec(`VACUUM INTO '${sqlite.replaceAll("'", "''")}'`);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", runtimeRoot);
  const out = vi.fn(), err = vi.fn();
  // The mapped checkout fixture has no Git metadata yet. The local stop check reads the real root.
  execFileSync("git", ["init", join(f.hub.root, "checkout")], { stdio: "ignore" });
  const code = await main(["roam", "set-home", id, "mac", "--force"], { out, err }, { v0: {
    catalog: [{ id, name: null }], confirmation: async () => request(macId).confirmation,
  } });
  const db = openDb(sqlite, { fileMustExist: true });
  try {
    const disabledMacHome = db.prepare("SELECT state,machine_id AS machineId,epoch FROM session_homes WHERE session_id=?").get(id);
    const disabledMacMembership = f.membership(macId);
    expect(disabledMacHome, err.mock.calls.flat().join("")).toMatchObject({ state: "stopped", machineId: macId, epoch: 9 });
    expect(disabledMacMembership).toMatchObject({ state: "frozen", epoch: 9 });
    expect(createSessionStopStore(db).current(id)).toMatchObject({ action: "force", mode: "graceful", displaced: [aId], observations: [
      { home: disabledMacHome, machineId: macId, evidence: { kind: "confirmed", owner: null } },
    ] });
  } finally { db.close(); }
  expect(code, err.mock.calls.flat().join("")).toBe(0);
  const output = out.mock.calls.flat().join("");
  expect(output).toBe(`Home assigned to ${macId}.\nCheck \`spider roam status\` for Stop confirmation. After confirmation, run \`spider roam start ${id}\`.\n`);
  expect(f.launched).toEqual([]);
});

it("returns a stopped assignment through the v0 hub socket without claiming exit", async () => {
  const f = fixture();
  await f.stopOnA();
  const root = mkdtempSync(join(resolve(".spider/scratch"), "sf-"));
  cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const control = await serveV0Control(root, f.runtime.services);
  cleanup.push(() => control.close());
  const result = await requestV0Services(root).setHome(request(bId));
  expect(result).toEqual({ ok: true, value: { sessionId: id, machineId: bId, epoch: 9, state: "stopped",
    destination: null, moveId: expect.stringMatching(/^v0-/), updatedAt: expect.any(Number) } });
  expect(await f.status()).toMatchObject({ status: "stop-pending" });
});
