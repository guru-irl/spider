import { afterEach, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { migrate, openDb, paths, setGlobalDbPathForTests } from "@spider/db-core";
import type { JsonObject } from "@spider/db-core/roam/types";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { DEFAULT_LIMITS, disabledIntercom, type Operation, type Outcome } from "@spider/roam/contracts";
import { piLaunchArgv } from "@spider/roam/relocate/launch-environment";
import type { OwnerGeneration } from "@spider/roam/relocate/session-stop-types";
import type { RelocateHome, SessionId } from "@spider/roam/relocate/types";
import { requestSessionControl, sessionControlPath, startSessionControlSocket } from "@spider/roam/session-socket";
import { createAdmissionPorts, registerAdmission } from "../roam/admission";
import * as placement from "../roam/relocate-admission";
import { serveRelocateShutdown } from "../roam/relocate-control";
import { createHostSessionFixture } from "./fixtures/pi-events";

const sessionId = "stop-fixture" as SessionId;
const machineId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const moveId = "v0-33333333-3333-4333-8333-333333333333" as NonNullable<RelocateHome["moveId"]>;
const stopped = { sessionId, machineId, epoch: 8, moveId, state: "stopped", destination: null, updatedAt: 8 } as const;
const running = { ...stopped, epoch: 9, state: "running", updatedAt: 9 } as const;
const identity = { pid: 12345, startIdentity: "birth-fixture", bootId: "boot-fixture" };
const markerKey = "SPIDER_ROAM_V0_LAUNCH";
const previousGlobalRoot = paths.globalRoot;
const roots: string[] = [];
afterEach(() => {
  paths.globalRoot = previousGlobalRoot;
  setGlobalDbPathForTests(null);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixtureRoot(): string {
  const scratch = resolve(".spider/scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "a"));
  roots.push(root);
  return root;
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, resolve: release };
}
function stoppedRequest(owner: OwnerGeneration = identity): Operation {
  return { id: "stop-8", kind: "session-shutdown", machineId, expectedEpoch: 8,
    args: { v0: true, homeState: "stopped", sessionId, homeMachineId: other, owner } };
}
function raw(root: string, operation: Operation, op = "shutdown"): Promise<Outcome<JsonObject>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sessionControlPath(root, sessionId));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ op, operation }) + "\n"));
    socket.on("data", bytes => { reply += bytes; });
    socket.on("end", () => {
      try { resolve(JSON.parse(reply)); } catch (error) { reject(error); }
    });
  });
}

it("acknowledges shutdown only for the admitted owner and stopped epoch", async () => {
  const root = fixtureRoot();
  const foreignStopped = { ...stopped, machineId: other };
  let home: RelocateHome = foreignStopped;
  let shutdowns = 0;
  const entered = latch(), finish = latch();
  const server = await serveRelocateShutdown({ sessionId, machineId, runtimeRoot: root, home: async () => home,
    admittedOwner: async () => identity, async shutdown() { shutdowns++; entered.resolve(); await finish.promise; } });
  const request = stoppedRequest();
  try {
    const wrongRequests = [];
    for (const wrong of [
      stoppedRequest({ ...identity, startIdentity: "other-birth" }),
      stoppedRequest({ ...identity, bootId: "other-boot" }),
      stoppedRequest({ ...identity, pid: identity.pid + 1 }),
      { ...request, args: { ...request.args, homeMachineId: machineId } },
      { ...request, expectedEpoch: 7 },
    ]) wrongRequests.push(await raw(root, wrong));
    home = { ...running, machineId: other };
    wrongRequests.push(await raw(root, request));
    const runningAtRequestedEpoch = await raw(root, { ...request, expectedEpoch: 9 });
    const wrongTarget = await raw(root, { ...request, machineId: other });
    await nextTurn();
    const shutdownsAfterWrongRequests = shutdowns;
    home = foreignStopped;
    const validReply = await raw(root, request);
    expect(validReply).toMatchObject({ code: 0, epoch: 8 });
    const replay = await requestSessionControl(root, request);
    await entered.promise;
    const shutdownsAfterReplay = shutdowns;
    expect(wrongRequests.map(x => x.code)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(runningAtRequestedEpoch.code).toBe(3);
    expect(wrongTarget.code).not.toBe(0);
    expect(shutdownsAfterWrongRequests).toBe(0);
    expect(replay.code).toBe(0);
    expect(shutdownsAfterReplay).toBe(1);
  } finally { finish.resolve(); await server.close(); }

  const moving = { ...stopped, state: "moving", destination: other } as const;
  const moveServer = await serveRelocateShutdown({ sessionId, machineId, runtimeRoot: root, home: async () => moving,
    async shutdown() { shutdowns++; } });
  try {
    const movingRequest = { ...request, id: "move-shutdown", args: { v0: true, sessionId, moveId } };
    expect((await requestSessionControl(root, { ...movingRequest, args: { ...movingRequest.args, moveId: "wrong" } })).code).toBe(3);
    const movingReply = await requestSessionControl(root, movingRequest);
    expect(movingReply.code).toBe(0);
    expect(shutdowns).toBe(2);
  } finally { await moveServer.close(); }
});

it.each(["home", "owner"] as const)("rechecks the %s before performing an acknowledged shutdown", async changed => {
  const root = fixtureRoot();
  const request = stoppedRequest();
  let home: RelocateHome = { ...stopped, machineId: other };
  let owner: OwnerGeneration | null = identity;
  const checking = latch(), finish = latch();
  let checks = 0, shutdowns = 0;
  const server = await serveRelocateShutdown({ sessionId, machineId, runtimeRoot: root, home: async () => home,
    async admittedOwner() {
      if (++checks === 2) { checking.resolve(); await finish.promise; }
      return owner;
    }, async shutdown() { shutdowns++; } });
  try {
    expect(await raw(root, request)).toMatchObject({ code: 0, epoch: 8 });
    await checking.promise;
    if (changed === "home") home = running;
    else owner = null;
    finish.resolve();
    await nextTurn();
    expect(shutdowns).toBe(0);
  } finally { finish.resolve(); await server.close(); }
});

it("does not route v0 owner control to the legacy socket handler", async () => {
  const root = fixtureRoot();
  const seen: Operation[] = [];
  const server = await startSessionControlSocket(root, sessionId, async ({ operation }) => {
    seen.push(operation);
    return { code: 0, reason: "accepted", operationId: operation.id, epoch: operation.expectedEpoch, value: null, home: null, repairCommand: null };
  });
  try {
    const request = stoppedRequest();
    const inspect = { ...request, kind: "session-inspect", args: { ...request.args, homeState: "running" } };
    const ambiguous = { ...request, args: { ...request.args, moveId } };
    expect((await raw(root, request)).code).toBe(2);
    expect((await raw(root, inspect, "inspect")).code).toBe(2);
    expect((await raw(root, ambiguous)).code).toBe(2);
    expect(seen).toEqual([]);
  } finally { await server.close(); }
});

function admissionFixture() {
  const root = fixtureRoot(), dbPath = join(root, "spider.db"), file = join(root, "session.jsonl");
  const config = { enabled: false, role: "box", machineId, hubMachineId: other, peers: [], discoveryRoots: [],
    coreUnit: "fixture.service", syncMs: 120_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }) + "\n", { mode: 0o600 });
  paths.globalRoot = root; setGlobalDbPathForTests(dbPath);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("HC_SOCKET", join(root, "fixture.sock"));
  vi.stubEnv("HC_SESSION", "stop-admission-fixture");
  // Use real lookup, locks and the socket. Placement is covered by the adapter tests.
  vi.spyOn(placement, "prepareRelocateAdmission").mockResolvedValue(undefined);
  const db = openDb(dbPath);
  migrate(db, "global", { machineId, globalRoot: root });
  db.prepare("UPDATE roam_meta SET store_key='global' WHERE id=1").run();
  const setHome = (home: RelocateHome | null) => {
    if (!home) db.prepare("DELETE FROM session_homes WHERE session_id=?").run(sessionId);
    else db.prepare(`INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET machine_id=excluded.machine_id,
      epoch=excluded.epoch,move_id=excluded.move_id,updated_at=excluded.updated_at,state=excluded.state,destination=excluded.destination`)
      .run(sessionId, home.machineId, home.epoch, home.moveId, home.updatedAt, home.state, home.destination);
  };
  function open(marker: string | undefined, whileReady?: () => Promise<void>) {
    vi.stubEnv(markerKey, marker);
    const ports = createAdmissionPorts({ bootId: async () => identity.bootId });
    // A missing managed row would otherwise be eligible for ordinary local work.
    ports.prepare = async () => {};
    ports.load = async () => ({ home: null, states: [], origin: null, participating: false, captureSafe: true,
      unfinishedFreeze: false, initialConflict: false });
    let setupError: unknown;
    const lockFile = ports.lock, ready = ports.v0Ready!;
    ports.lock = async (...args) => {
      try { return await lockFile(...args); } catch (error) { setupError = error; throw error; }
    };
    ports.v0Ready = async (...args) => {
      try { const socket = await ready(...args); await whileReady?.(); return socket; }
      catch (error) { setupError = error; throw error; }
    };
    const host = createHostSessionFixture({ cwd: root, sessionId, sessionFile: file });
    let shutdowns = 0;
    Object.assign(host.ctx, { shutdown() { shutdowns++; } });
    const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports);
    return { gate, async start() {
      for (const hook of host.hooks.get("session_start") ?? []) await hook({}, host.ctx);
      if (setupError) throw setupError;
    },
      async reload() {
        for (const hook of host.hooks.get("session_shutdown") ?? []) await hook({ reason: "reload" }, host.ctx);
      },
      async status() {
        return { admitted: gate.inspect().kind === "ordinary", shutdowns,
          idLockHeld: !!await inspectIdLock(join(root, "herdr"), sessionId),
          fileLeaseHeld: !!await createSessionLeases(join(root, "herdr")).get(file) };
      } };
  }
  const argv = (homeEpoch: number, target = machineId, id = sessionId) => {
    const launch = { sessionId: id, machineId: target, homeEpoch };
    return piLaunchArgv("/usr/bin/pi", file, { PATH: "/usr/bin", PI_CODING_AGENT_DIR: root, SPIDER_GLOBAL_ROOT: root,
      PI_SUBAGENT_CHILD: "0", [markerKey]: "do not inherit this marker" }, launch);
  };
  const marker = (...args: Parameters<typeof argv>) => argv(...args).find(arg => arg.startsWith(`${markerKey}=`))?.slice(markerKey.length + 1);
  return { root, file, db, setHome, open, marker };
}

it("late managed launches exit before admission", async () => {
  const f = admissionFixture();
  async function attempt(home: RelocateHome | null, marker: string | undefined, whileReady?: () => Promise<void>) {
    f.setHome(home);
    const activation = f.open(marker, whileReady);
    try { await activation.start(); return await activation.status(); }
    finally { await activation.gate.close(); }
  }
  try {
    const delayed = f.marker(7);
    const stoppedLaunch = await attempt(stopped, delayed);
    const staleLaunch = await attempt(running, delayed);
    expect(staleLaunch.admitted).toBe(false);
    expect(staleLaunch.shutdowns).toBe(1);
    expect(staleLaunch.idLockHeld).toBe(false);
    expect(stoppedLaunch).toEqual({ admitted: false, shutdowns: 1, idLockHeld: false, fileLeaseHeld: false });
    expect(staleLaunch.fileLeaseHeld).toBe(false);
    expect(JSON.parse(delayed!)).toEqual({ sessionId, machineId, homeEpoch: 7 });
    const refused = { admitted: false, shutdowns: 1, idLockHeld: false, fileLeaseHeld: false };
    const exact = f.marker(9);
    expect(await attempt(null, exact)).toEqual(refused);
    expect(await attempt(running, "not-json")).toEqual(refused);
    expect(await attempt(running, f.marker(9, other))).toEqual(refused);
    expect(await attempt(running, f.marker(9, machineId, "wrong-session" as SessionId))).toEqual(refused);
    const stoppedDuringReady = await attempt(running, exact, async () => {
      f.setHome({ ...stopped, epoch: 10, updatedAt: 10 });
    });
    expect(stoppedDuringReady).toEqual(refused);
    const exactLaunch = await attempt(running, exact);
    expect(exactLaunch.admitted).toBe(true);
    expect(exactLaunch).toEqual({ admitted: true, shutdowns: 0, idLockHeld: true, fileLeaseHeld: true });
    expect(process.env[markerKey]).toBeUndefined();
    expect(await attempt(stopped, undefined)).toMatchObject({ admitted: false, shutdowns: 0 });
    expect(await attempt(null, undefined)).toMatchObject({ admitted: true, shutdowns: 0 });
  } finally { f.db.close(); }
});

it("keeps the same owner epoch across reloads without re-admitting a stale launch", async () => {
  const f = admissionFixture(); f.setHome(running);
  const first = f.open(f.marker(9));
  let resumed: typeof first | undefined, stale: typeof first | undefined;
  try {
    await first.start();
    const lock = await inspectIdLock(join(f.root, "herdr"), sessionId);
    expect(lock).not.toBeNull();
    const owner = { ...lock!.identity, bootId: lock!.bootId };
    const operation: Operation = { id: "inspect-reload", kind: "session-inspect", machineId, expectedEpoch: 9,
      args: { v0: true, homeState: "running", sessionId, homeMachineId: machineId, owner } };
    const root = join(f.root, "roam", "s");
    expect(await raw(root, operation, "inspect")).toMatchObject({ code: 0, epoch: 9, value: { version: 1, sessionId, owner } });
    expect(process.env[markerKey]).toBeUndefined();
    await first.reload();
    resumed = f.open(undefined); await resumed.start();
    expect(await raw(root, operation, "inspect")).toMatchObject({ code: 0, epoch: 9, value: { version: 1, sessionId, owner } });
    await resumed.reload();
    f.setHome({ ...running, epoch: 11, updatedAt: 11 });
    stale = f.open(undefined); await stale.start();
    expect(await stale.status()).toMatchObject({ admitted: false, shutdowns: 1 });
  } finally { await stale?.gate.close(); await resumed?.gate.close(); await first.gate.close(); f.db.close(); }
});

it("inspects only the exact running admission while both ownership records are held", async () => {
  const f = admissionFixture(); f.setHome(running);
  const listening = latch(), ready = latch();
  const activation = f.open(f.marker(9), async () => { listening.resolve(); await ready.promise; });
  const started = activation.start();
  try {
    await Promise.race([listening.promise, started.then(() => { throw new Error("Admission never opened its socket"); })]);
    const lockRoot = join(f.root, "herdr"), runtimeRoot = join(f.root, "roam", "s");
    const lock = await inspectIdLock(lockRoot, sessionId);
    expect(lock).not.toBeNull();
    const owner = { ...lock!.identity, bootId: lock!.bootId };
    const inspect: Operation = { id: "inspect-9", kind: "session-inspect", machineId, expectedEpoch: 9,
      args: { v0: true, homeState: "running", sessionId, homeMachineId: machineId, owner } };
    const beforeAdmission = await raw(runtimeRoot, inspect, "inspect");
    ready.resolve(); await started;
    const afterAdmission = await raw(runtimeRoot, inspect, "inspect");
    expect(beforeAdmission.code).not.toBe(0);
    expect(afterAdmission.code).toBe(0);
    expect(afterAdmission.value).toMatchObject({ version: 1, sessionId, owner });
    f.setHome({ ...running, epoch: 11, updatedAt: 11 });
    expect((await requestSessionControl(runtimeRoot, { ...inspect, expectedEpoch: 11 })).code).toBe(3);
    f.setHome(running);
    const leases = createSessionLeases(lockRoot);
    const lease = await leases.get(f.file);
    expect(lease).not.toBeNull();
    await leases.release(f.file, lease!.token, { mode: "switch" });
    expect((await requestSessionControl(runtimeRoot, inspect)).code).toBe(3);
    expect((await activation.status()).shutdowns).toBe(0);
  } finally { ready.resolve(); await started; await activation.gate.close(); f.db.close(); }
});
