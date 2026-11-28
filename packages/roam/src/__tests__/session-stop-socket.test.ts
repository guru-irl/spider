import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { testTmpDir } from "@spider/intercom/test-support";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "../contracts";
import { createV0Runtime } from "../relocate/runtime";
import { createStartCommand } from "../relocate/session-start";
import { requestV0Services, serveV0Control } from "../relocate/service";
import * as stopStore from "../relocate/session-stop-store";
import type { StopRequest } from "../relocate/session-stop-types";
import type { SessionId } from "../relocate/types";
import { deferred } from "./relocate-fakes";

const mac = "11111111-1111-4111-8111-111111111111";
const id = "session-1" as SessionId;
const stop: StopRequest = { operationId: "stop-1", sessionId: id, machineId: mac, homeEpoch: 7, mode: "graceful" };
const frame = (kind: string, request: unknown) => JSON.stringify({ version: 1, kind, request }) + "\n";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
function raw(file: string, data: string): Promise<Record<string, any>> {
  return new Promise((done, reject) => {
    const socket = createConnection(file); let reply = "";
    socket.on("connect", () => socket.write(data));
    socket.on("data", bytes => { reply += String(bytes); });
    socket.on("end", () => { try { done(JSON.parse(reply)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}
function rootFixture() {
  const root = mkdtempSync(join(testTmpDir(), "s11-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("HC_SOCKET", join(root, "hc.sock"));
  vi.stubEnv("HC_SESSION", "stop-socket-fixture");
  return root;
}
async function fixture() {
  const root = rootFixture(), file = join(root, "spider.db");
  const db = openDb(file);
  migrate(db, "global", { machineId: mac, globalRoot: root });
  db.exec("UPDATE roam_meta SET store_key='global', capture_enabled=1");
  db.prepare("INSERT INTO session_homes (session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,7,NULL,100,'running',NULL)").run(id, mac);
  const reader = openDb(file);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac, peers: [], discoveryRoots: [],
    coreUnit: "fixture", syncMs: 120_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const peerCalls: string[] = [];
  const unused = async () => { peerCalls.push("unexpected"); throw new Error("unexpected peer call"); };
  const initialConfig = { ...config };
  const runtime = createV0Runtime(root, { liveHub: true, readConfig: () => config,
    openCore: () => ({ config: initialConfig, db, root, close: () => db.close() }),
    transport: { resolve: unused, bootstrapProbe: unused, exec: unused, read: unused, write: unused, run: unused } });
  cleanups.push(() => reader.close(), () => runtime.close());
  const server = await serveV0Control(root, runtime.services as any);
  cleanups.push(() => server.close());
  return { root, file: join(root, "roam", "relocate.sock"), db, reader, config, runtime, peerCalls };
}

it("rejects invalid Stop frames before dispatch", async () => {
  const f = await fixture();
  const swap = vi.spyOn(f.runtime.homes, "compareAndSwap");
  const dispatch = vi.spyOn(f.runtime.services, "stop");
  const invalid = [
    frame("stop", { ...stop, extra: true }), frame("stop", { ...stop, sessionId: "../bad" }),
    frame("stop", { ...stop, operationId: "bad\nname" }), frame("stop", { ...stop, operationId: "\ud800" }),
    frame("stop", { ...stop, machineId: "not-a-uuid" }),
    frame("stop", { ...stop, homeEpoch: 0 }), frame("stop", { ...stop, homeEpoch: 1.5 }),
    frame("stop", { ...stop, homeEpoch: Number.MAX_SAFE_INTEGER + 1 }), frame("stop", { ...stop, mode: "urgent" }),
    JSON.stringify({ version: 2, kind: "stop", request: stop }) + "\n",
    frame("stop", { ...stop, extra: "x".repeat(32 * 1024) }),
  ];
  for (const input of invalid) expect(await raw(f.file, input)).toMatchObject({ error: "invalid-arguments" });
  expect(dispatch).not.toHaveBeenCalled();
  f.config.enabled = false;
  const disabled = await raw(f.file, frame("stop", stop));
  expect(disabled.result).toMatchObject({ outcome: "refused", reason: "roaming-disabled" });
  expect(swap).not.toHaveBeenCalled();
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});

it.each(["queued", "after CAS"] as const)("the saved request outlives a lost reply %s", async when => {
  const f = await fixture(), release = deferred(), entered = deferred(), committed = deferred();
  const held = when === "queued" ? f.runtime.operations.enqueue(id, () => release.promise) : Promise.resolve();
  const originalStop = f.runtime.services.stop;
  vi.spyOn(f.runtime.services, "stop").mockImplementation(request => {
    const result = originalStop(request);
    entered.resolve();
    return result;
  });
  const socket = createConnection(f.file);
  socket.on("error", () => {});
  const original = f.runtime.homes.compareAndSwap;
  vi.spyOn(f.runtime.homes, "compareAndSwap").mockImplementation(async (...args) => {
    const result = await original(...args);
    expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "stopped", epoch: 8 });
    if (when === "after CAS") socket.destroy();
    committed.resolve();
    return result;
  });
  await new Promise<void>(done => socket.once("connect", () => { socket.write(frame("stop", stop)); done(); }));
  await entered.promise;
  if (when === "queued") {
    const following = f.runtime.operations.enqueue(id, async () => {});
    socket.destroy();
    await new Promise<void>(done => socket.once("close", () => done()));
    expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
    release.resolve();
    await held; await following;
  } else {
    await committed.promise;
  }
  const later = await requestV0Services(f.root).sessionStatus({ sessionId: id });
  expect(later).toMatchObject({ homeState: "stopped", homeEpoch: 8 });
  expect(f.peerCalls).toEqual([]);
});

it("reads managed status from cached data and does not invent unmanaged evidence", async () => {
  const f = await fixture();
  const read = (stopStore as any).readCachedSessionStatus;
  expect(read(f.reader, id, 1000)).toMatchObject({ homeState: "running", homeEpoch: 7, status: null });
  expect(read(f.reader, "ordinary" as SessionId, 1000)).toMatchObject({ reason: "unmanaged-session" });
  writeLocal(f.db, "relocate-managed", "missing-managed", { sessionId: "missing-managed" });
  expect(read(f.reader, "missing-managed" as SessionId, 1000).reason).not.toBe("unmanaged-session");
  writeLocal(f.db, "session-transition", "broken", { bad: true });
  expect(() => read(f.reader, "broken" as SessionId, 1000)).toThrow();
  f.db.exec("UPDATE session_homes SET state='moving', move_id=NULL");
  expect(() => read(f.reader, id, 1000)).toThrow();
  expect(f.peerCalls).toEqual([]);
});

it("rejects an unsafe socket inode before submitting a mutation", async () => {
  const root = rootFixture(); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const target = join(root, "target.sock");
  let accepted = 0;
  const server = createServer(socket => { accepted++; socket.destroy(); });
  await new Promise<void>(done => server.listen(target, done)); chmodSync(target, 0o600);
  cleanups.push(() => new Promise<void>(done => server.close(() => done())));
  symlinkSync(target, join(root, "roam", "relocate.sock"));
  await expect(requestV0Services(root).stop(stop)).rejects.toMatchObject({ submission: "not-sent" });
  expect(accepted).toBe(0);
});

it.each(["wrong-id", "oversized"] as const)("rejects a %s reply after submission as unknown", async kind => {
  const root = rootFixture(), dir = join(root, "roam"), file = join(dir, "relocate.sock");
  mkdirSync(dir, { mode: 0o700 });
  let accepted = 0;
  const server = createServer((socket: Socket) => socket.once("data", () => {
    accepted++;
    socket.end(kind === "oversized" ? "x".repeat(1024 * 1024 + 1) : JSON.stringify({ version: 1, kind: "stop", result: {
      sessionId: id, operationId: "wrong", machineId: mac, homeEpoch: 8, homeState: "stopped",
      status: "stopped", outcome: "complete", reason: null, observedAt: 123,
    } }) + "\n");
  }));
  await new Promise<void>(done => server.listen(file, done)); chmodSync(file, 0o600);
  cleanups.push(() => new Promise<void>(done => server.close(() => done())));
  await expect(requestV0Services(root).stop(stop)).rejects.toMatchObject({ submission: "unknown" });
  expect(accepted).toBe(1);
});


it("exposes Start and status without falling back when handlers are absent", async () => {
  const f = await fixture();
  const calls: unknown[] = [];
  const starting = { sessionId: id, operationId: "start-1", machineId: mac, homeEpoch: 9, homeState: "running",
    status: "starting", outcome: "pending", reason: null, observedAt: null } as const;
  const start = { operationId: "start-1", sessionId: id, machineId: mac, homeEpoch: 8 };
  vi.spyOn(f.runtime.services, "start").mockImplementation(async request => { calls.push(request); return starting; });
  expect(await requestV0Services(f.root).start(start)).toEqual(starting);
  expect(calls).toEqual([start]);
  expect(await requestV0Services(f.root).sessionStatus({ sessionId: id })).toMatchObject({ homeState: "running", homeEpoch: 7 });
  for (const input of [frame("start", { ...start, mode: "hard" }), frame("start", { ...start, homeEpoch: -1 }),
    frame("session-status", { sessionId: id, extra: true }), frame("session-status", { sessionId: "../bad" })]) {
    expect(await raw(f.file, input)).toMatchObject({ error: "invalid-arguments" });
  }
  expect(calls).toEqual([start]);
  const root = rootFixture();
  const old = { sync: async () => { throw new Error("legacy sync"); }, relocate: async () => { throw new Error("legacy relocate"); },
    setHome: async () => { throw new Error("legacy set-home"); } };
  const server = await serveV0Control(root, old);
  cleanups.push(() => server.close());
  expect(await raw(join(root, "roam", "relocate.sock"), frame("stop", stop))).toMatchObject({ error: "unsupported-control" });
});

it("refuses a failed commit with a stable reason and leaves the home unchanged", async () => {
  const f = await fixture();
  vi.spyOn(f.runtime.homes, "compareAndSwap").mockRejectedValue(new Error("private database details"));
  const result = await requestV0Services(f.root).stop(stop);
  expect(result).toMatchObject({ outcome: "refused", reason: "session-commit-failed", operationId: stop.operationId });
  expect(JSON.stringify(result)).not.toContain("private database details");
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});

it.each(["wrong-session", "wrong-home", "wrong-outcome", "unverified-timestamp", "unterminated"] as const)(
  "rejects an inconsistent %s reply after submission", async kind => {
    const root = rootFixture(), dir = join(root, "roam"), file = join(dir, "relocate.sock");
    mkdirSync(dir, { mode: 0o700 });
    const result = { sessionId: id, operationId: stop.operationId, machineId: mac, homeEpoch: 8, homeState: "stopped",
      status: "stopped", outcome: "complete", reason: null, observedAt: 123 };
    if (kind === "wrong-session") result.sessionId = "other" as SessionId;
    if (kind === "wrong-home") result.homeState = "running";
    if (kind === "wrong-outcome") result.status = "stop-pending";
    if (kind === "unverified-timestamp") { result.homeState = "running"; result.status = "starting"; result.outcome = "pending"; }
    const server = createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ version: 1, kind: "stop", result }) + (kind === "unterminated" ? "" : "\n"))));
    await new Promise<void>(done => server.listen(file, done)); chmodSync(file, 0o600);
    cleanups.push(() => new Promise<void>(done => server.close(() => done())));
    await expect(requestV0Services(root).stop(stop)).rejects.toMatchObject({ submission: "unknown" });
  },
);

it("marks a missing hub as not sent", async () => {
  const root = rootFixture();
  await expect(requestV0Services(root).start({ operationId: "start-1", sessionId: id, machineId: mac, homeEpoch: 8 }))
    .rejects.toMatchObject({ submission: "not-sent" });
});


it("accepts a long cached blocker reason within the reply budget", async () => {
  const root = rootFixture(), dir = join(root, "roam"), file = join(dir, "relocate.sock");
  mkdirSync(dir, { mode: 0o700 });
  const reason = "unverified job ".repeat(500);
  const result = { sessionId: id, operationId: stop.operationId, machineId: mac, homeEpoch: 8, homeState: "stopped",
    status: "stop-pending", outcome: "pending", reason, observedAt: 123 };
  const server = createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ version: 1, kind: "stop", result }) + "\n")));
  await new Promise<void>(done => server.listen(file, done)); chmodSync(file, 0o600);
  cleanups.push(() => new Promise<void>(done => server.close(() => done())));
  expect(await requestV0Services(root).stop(stop)).toEqual(result);
});


it("refuses an operation-lock failure without returning private error text", async () => {
  const f = await fixture();
  vi.spyOn(f.runtime.operations, "enqueue").mockImplementationOnce(async () => { throw new Error("lock-timeout private path"); });
  const result = await requestV0Services(f.root).stop(stop);
  expect(result).toMatchObject({ outcome: "refused", reason: "session-commit-failed" });
  expect(JSON.stringify(result)).not.toContain("private path");
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});

it("reads the durable binding if a commit throws after the transaction", async () => {
  const f = await fixture(), original = f.runtime.homes.compareAndSwap;
  vi.spyOn(f.runtime.homes, "compareAndSwap").mockImplementation(async (...args) => {
    await original(...args);
    throw new Error("reply lost after transaction");
  });
  const result = await requestV0Services(f.root).stop(stop);
  expect(result).toMatchObject({ outcome: "pending", homeState: "stopped", homeEpoch: 8, operationId: stop.operationId });
  expect((await requestV0Services(f.root).sessionStatus({ sessionId: id })).homeState).toBe("stopped");
});


it("rechecks the live enabled flag under the operation lock", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const held = f.runtime.operations.enqueue(id, () => release.promise);
  const originalStop = f.runtime.services.stop;
  vi.spyOn(f.runtime.services, "stop").mockImplementation(request => {
    const result = originalStop(request); entered.resolve(); return result;
  });
  const request = requestV0Services(f.root).stop(stop);
  await entered.promise;
  f.config.enabled = false;
  release.resolve(); await held;
  expect(await request).toMatchObject({ outcome: "refused", reason: "roaming-disabled" });
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});


it("does not label a missing home unmanaged when an operation binding survives", async () => {
  const f = await fixture();
  const expected = { sessionId: id, machineId: mac, epoch: 7, state: "running", destination: null, moveId: null, updatedAt: 100 } as const;
  const committed = { ...expected, state: "stopped", epoch: 8, updatedAt: 200 } as const;
  stopStore.createSessionStopStore(f.db).write({ action: "stop", operationId: stop.operationId, expected, committed,
    mode: "graceful", displaced: [], observations: [], contactReason: null }, { action: "stop", request: stop, committed });
  writeLocal(f.db, "session-transition", id, undefined);
  f.db.prepare("DELETE FROM session_homes WHERE session_id=?").run(id);
  expect(stopStore.readCachedSessionStatus(f.reader, id, 1000).reason).not.toBe("unmanaged-session");
});


it("refuses Start when the operation lock fails without leaking the failure", async () => {
  const f = await fixture();
  vi.spyOn(f.runtime.operations, "enqueue").mockImplementationOnce(async () => { throw new Error("lock-timeout private path"); });
  const start = { operationId: "start-1", sessionId: id, machineId: mac, homeEpoch: 7 };
  const result = await requestV0Services(f.root).start(start);
  expect(result).toMatchObject({ outcome: "refused", reason: "The session could not be authorized to start." });
  expect(JSON.stringify(result)).not.toContain("private path");
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});

it("checks that the live machine is still the Mac hub under the operation lock", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const held = f.runtime.operations.enqueue(id, () => release.promise);
  const originalStop = f.runtime.services.stop;
  vi.spyOn(f.runtime.services, "stop").mockImplementation(request => { const result = originalStop(request); entered.resolve(); return result; });
  const request = requestV0Services(f.root).stop(stop);
  await entered.promise;
  f.config.role = "box";
  release.resolve(); await held;
  expect(await request).toMatchObject({ outcome: "refused", reason: "roaming-disabled" });
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});


it("does not classify a damaged legacy home as unmanaged", async () => {
  const f = await fixture();
  f.db.exec("UPDATE session_homes SET state=NULL, destination=NULL");
  expect(stopStore.readCachedSessionStatus(f.reader, id, 1000).reason).toBe("unmanaged-session");
  f.db.prepare("UPDATE session_homes SET machine_id='broken' WHERE session_id=?").run(id);
  expect(() => stopStore.readCachedSessionStatus(f.reader, id, 1000)).toThrow();
});


it("reads a pre-v0 legacy home without changing its schema", () => {
  const root = rootFixture(), db = openDb(join(root, "old.db"));
  cleanups.push(() => db.close());
  db.exec(`CREATE TABLE session_homes (session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    move_id TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE roam_cursors (peer_machine TEXT NOT NULL, peer_stream TEXT NOT NULL, last_seq INTEGER NOT NULL,
      PRIMARY KEY (peer_machine, peer_stream));`);
  db.prepare("INSERT INTO session_homes VALUES (?, ?, 7, 'legacy-move', 100)").run(id, mac);
  expect(stopStore.readCachedSessionStatus(db, id, 1000)).toMatchObject({ reason: "unmanaged-session", homeState: null });
  expect(db.prepare("PRAGMA table_info(session_homes)").all()).toHaveLength(5);
});

it("does not report unmanaged when cached storage is unavailable", async () => {
  const f = await fixture();
  f.db.exec("DROP TABLE roam_cursors");
  expect(() => stopStore.readCachedSessionStatus(f.reader, "unknown" as SessionId, 1000)).toThrow();
});


it("reports Start unknown when intake cannot rule out an earlier commit", async () => {
  const f = await fixture(), prepare = f.db.prepare.bind(f.db);
  const broken = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (sql.includes("SELECT peer_stream FROM roam_cursors")) throw new Error("private database failure");
    return prepare(sql);
  });
  const start = { operationId: "start-storage", sessionId: id, machineId: mac, homeEpoch: 7 };
  try {
    expect(await requestV0Services(f.root).start(start)).toMatchObject({ outcome: "pending", reason: "session-commit-unknown" });
  } finally { broken.mockRestore(); }
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});


it.each(["lost CAS result", "post-commit read"] as const)("does not report Start refused after %s with an unreadable binding", async failure => {
  const f = await fixture(), store = stopStore.createSessionStopStore(f.db);
  const running = await f.runtime.homes.read(id);
  if (!running || running.state !== "running") throw new Error("expected running home");
  const stopped = { ...running, state: "stopped", epoch: 8, updatedAt: 200 } as const;
  const proof = { sessionId: id, machineId: mac, home: stopped, bootId: "fixture-boot", observedAt: 200,
    evidence: { kind: "confirmed", owner: null } } as const;
  await f.runtime.homes.compareAndSwap(running, stopped, undefined, () => store.write({ action: "stop", operationId: "old-stop",
    expected: running, committed: stopped, mode: "graceful", displaced: [], observations: [proof], contactReason: null }));
  const placement = { sessionId: id, machineId: mac, repoKey: "fixture", workspaceId: "fixture", repository: f.root,
    cwd: f.root, file: join(f.root, "session"), stores: [], historyMachine: mac };
  const unused = async () => { throw new Error("unexpected Start effect"); };
  const command = createStartCommand({ operations: f.runtime.operations, store, homes: f.runtime.homes,
    withSession: f.runtime.adapters.ports.withSession, enabled: () => true, localMachineId: mac,
    clock: { now: Date.now, later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } },
    readyMs: DEFAULT_LIMITS.readyMs, checkStart: async () => ({ ok: true, value: placement }),
    observe: async () => ({ ok: true, value: proof }), locate: unused, publishHome: unused, activate: unused,
    start: unused, ownerFree: unused, confirm: unused });
  cleanups.push(() => command.close());
  vi.spyOn(f.runtime.services, "start").mockImplementation(command);
  let unavailable = false;
  const prepare = f.db.prepare.bind(f.db), compare = f.runtime.homes.compareAndSwap;
  const broken = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (unavailable && sql.includes("SELECT peer_stream FROM roam_cursors")) throw new Error("private database failure");
    return prepare(sql);
  });
  const swapped = vi.spyOn(f.runtime.homes, "compareAndSwap").mockImplementation(async (...args) => {
    const result = await compare(...args); unavailable = true;
    if (failure === "lost CAS result") throw new Error("commit reply lost");
    return result;
  });
  const request = { operationId: "start-after-cas", sessionId: id, machineId: mac, homeEpoch: 8 };
  try {
    const result = await requestV0Services(f.root).start(request);
    expect(result).toMatchObject({ outcome: "pending", reason: "session-commit-unknown" });
  } finally { broken.mockRestore(); }
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 9 });
  expect(stopStore.createSessionStopStore(f.reader).operation(request.operationId)).toMatchObject({ action: "start", request, committed: { epoch: 9 } });
  expect(await requestV0Services(f.root).start(request)).toMatchObject({ outcome: "pending", homeState: "running", homeEpoch: 9 });
  expect(swapped).toHaveBeenCalledTimes(1);
});


it("reports Stop pending when cached status becomes unreadable immediately after commit", async () => {
  const f = await fixture(), compare = f.runtime.homes.compareAndSwap, prepare = f.db.prepare.bind(f.db);
  let unavailable = false;
  const broken = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (unavailable && sql.includes("SELECT peer_stream FROM roam_cursors")) throw new Error("private database failure");
    return prepare(sql);
  });
  const swapped = vi.spyOn(f.runtime.homes, "compareAndSwap").mockImplementation(async (...args) => {
    const result = await compare(...args); unavailable = true; return result;
  });
  try {
    const result = await requestV0Services(f.root).stop(stop);
    expect(result).toMatchObject({ outcome: "pending", reason: "session-commit-unknown" });
  } finally { broken.mockRestore(); }
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "stopped", epoch: 8 });
  expect(await requestV0Services(f.root).stop(stop)).toMatchObject({ outcome: "pending", homeEpoch: 8 });
  expect(swapped).toHaveBeenCalledTimes(1);
});


it("does not report a replayed Stop refused when its binding store is unavailable", async () => {
  const f = await fixture();
  expect(await requestV0Services(f.root).stop(stop)).toMatchObject({ outcome: "pending", homeEpoch: 8 });
  const prepare = f.db.prepare.bind(f.db);
  const broken = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (sql.includes("SELECT peer_stream FROM roam_cursors")) throw new Error("private database failure");
    return prepare(sql);
  });
  try { expect(await requestV0Services(f.root).stop(stop)).toMatchObject({ outcome: "pending", reason: "session-commit-unknown" }); }
  finally { broken.mockRestore(); }
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "stopped", epoch: 8 });
});

it("does not report a replayed Start refused when its binding store is unavailable", async () => {
  const f = await fixture(), store = stopStore.createSessionStopStore(f.db);
  const expected = { sessionId: id, machineId: mac, epoch: 8, state: "stopped", destination: null, moveId: null, updatedAt: 200 } as const;
  const committed = { ...expected, state: "running", epoch: 9, updatedAt: 300 } as const;
  const request = { operationId: "saved-start", sessionId: id, machineId: mac, homeEpoch: 8 };
  f.db.prepare("UPDATE session_homes SET epoch=9, updated_at=300 WHERE session_id=?").run(id);
  store.write({ action: "start", operationId: request.operationId, expected, committed, observedAt: null, contactReason: null },
    { action: "start", request, committed });
  const prepare = f.db.prepare.bind(f.db);
  const broken = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (sql.includes("SELECT peer_stream FROM roam_cursors")) throw new Error("private database failure");
    return prepare(sql);
  });
  try { expect(await requestV0Services(f.root).start(request)).toMatchObject({ outcome: "pending", reason: "session-commit-unknown" }); }
  finally { broken.mockRestore(); }
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 9 });
});


it("refuses Stop when a proven new request fails before its first write", async () => {
  const f = await fixture(), prepare = f.db.prepare.bind(f.db);
  let unavailable = false;
  const broken = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (unavailable && sql.includes("SELECT peer_stream FROM roam_cursors")) throw new Error("private database failure");
    return prepare(sql);
  });
  vi.spyOn(f.runtime.homes, "read").mockImplementation(async () => { unavailable = true; throw new Error("home read failure"); });
  try { expect(await requestV0Services(f.root).stop(stop)).toMatchObject({ outcome: "refused", reason: "session-commit-failed" }); }
  finally { broken.mockRestore(); }
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});

it("refuses Start when a proven new request fails before its first write", async () => {
  const f = await fixture(), store = stopStore.createSessionStopStore(f.db), prepare = f.db.prepare.bind(f.db);
  let unavailable = false;
  const broken = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (unavailable && sql.includes("SELECT peer_stream FROM roam_cursors")) throw new Error("private database failure");
    return prepare(sql);
  });
  const unused = async () => { throw new Error("unexpected Start effect"); };
  const command = createStartCommand({ operations: f.runtime.operations, store, homes: f.runtime.homes,
    withSession: f.runtime.adapters.ports.withSession, enabled: () => true, localMachineId: mac,
    clock: { now: Date.now, later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } },
    readyMs: DEFAULT_LIMITS.readyMs, checkStart: async () => { unavailable = true; throw new Error("preflight failed"); },
    observe: unused, locate: unused, publishHome: unused, activate: unused, start: unused, ownerFree: unused, confirm: unused });
  cleanups.push(() => command.close());
  vi.spyOn(f.runtime.services, "start").mockImplementation(command);
  try {
    const request = { operationId: "new-start", sessionId: id, machineId: mac, homeEpoch: 7 };
    expect(await requestV0Services(f.root).start(request)).toMatchObject({ outcome: "refused", reason: "session-commit-failed" });
  } finally { broken.mockRestore(); }
  expect(f.reader.prepare("SELECT state,epoch FROM session_homes WHERE session_id=?").get(id)).toEqual({ state: "running", epoch: 7 });
});


it("keeps Start pending when a concurrent binding appears during preflight and its reread fails", async () => {
  const f = await fixture(), store = stopStore.createSessionStopStore(f.db);
  const home = await f.runtime.homes.read(id);
  if (!home || home.state !== "running") throw new Error("expected running home");
  const request = { operationId: "concurrent-start", sessionId: id, machineId: mac, homeEpoch: 7 };
  const placement = { sessionId: id, machineId: mac, repoKey: "fixture", workspaceId: "fixture", repository: f.root,
    cwd: f.root, file: join(f.root, "session"), stores: [], historyMachine: mac };
  let sawBinding = false;
  const operation = store.operation.bind(store), current = store.current.bind(store);
  vi.spyOn(store, "operation").mockImplementation(key => {
    if (sawBinding) throw new Error("private database failure");
    const binding = operation(key); if (binding) sawBinding = true; return binding;
  });
  vi.spyOn(store, "current").mockImplementation(key => {
    if (sawBinding) throw new Error("private database failure");
    return current(key);
  });
  const unused = async () => { throw new Error("unexpected Start effect"); };
  const command = createStartCommand({ operations: f.runtime.operations, store, homes: f.runtime.homes,
    withSession: f.runtime.adapters.ports.withSession, enabled: () => true, localMachineId: mac,
    clock: { now: Date.now, later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } },
    readyMs: DEFAULT_LIMITS.readyMs, checkStart: async () => {
      store.write({ action: "start", operationId: request.operationId, expected: home, committed: home, observedAt: null, contactReason: null },
        { action: "start", request, committed: home });
      return { ok: true, value: placement };
    }, observe: unused, locate: unused, publishHome: unused, activate: unused, start: unused, ownerFree: unused, confirm: unused });
  cleanups.push(() => command.close());
  vi.spyOn(f.runtime.services, "start").mockImplementation(command);
  expect(await requestV0Services(f.root).start(request)).toMatchObject({ outcome: "pending", reason: "session-commit-unknown" });
  expect(stopStore.createSessionStopStore(f.reader).operation(request.operationId)).toMatchObject({ action: "start", committed: { epoch: 7 } });
});
