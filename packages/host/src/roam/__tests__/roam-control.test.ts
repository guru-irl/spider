import { fixtureIntercom } from "./intercom-move-fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Home } from "@spider/db-core/roam/types";
import type { Operation } from "@spider/roam/contracts";
import { IntercomFenceError } from "@spider/roam/intercom-move";
import { openFreezeJournal } from "@spider/roam/journal";
import { requestSessionControl, sessionControlPath } from "@spider/roam/session-socket";
import { createDormantControl, serveSessionControl } from "../control.js";
import { controlSession, createBothLocks, type SessionControlPorts } from "@spider/roam/session-control";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createSessionLeases, type ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import type { FreezePorts } from "../freeze.js";
import type { AdmissionGate } from "../admission.js";

const MACHINE = "11111111-1111-4111-8111-111111111111";
const root = resolve(".spider/scratch/c43");
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

function fixture() {
  mkdirSync(root, { recursive: true });
  const store = createReplica("worktree", MACHINE); fixtures.push(store);
  const key = "worktree:fixture:workspace" as const, id = `session-${crypto.randomUUID()}`;
  store.db.prepare("UPDATE roam_meta SET store_key=?,capture_enabled=1 WHERE id=1").run(key);
  store.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,2,'active')").run(id);
  store.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run(id, MACHINE);
  const file = join(store.root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: store.root }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fixture" } }) + "\n");
  const home: Home = { sessionId: id, machineId: MACHINE, epoch: 2, moveId: null, updatedAt: 1 };
  let admitted = true, drains = 0, shutdowns = 0;
  const gate: AdmissionGate = { inspect: () => ({ kind: admitted ? "ordinary" : "control-only", home, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(), close: async () => { admitted = false; },
    freeze: async () => { admitted = false; }, unfreeze: async () => { admitted = true; } };
  const ports: FreezePorts & { shutdown(): Promise<void> } = { gate, journal: openFreezeJournal(join(store.root, "roam", "journal.db")),
    stores: [store.db], expectedStores: [key], intercom: fixtureIntercom(id), async drain() { drains++; }, async resume() {},
    async inspect() { return { blockers: [], file, cwd: store.root, leaf: "leaf-1", owner: { bootId: "boot", pid: process.pid, startTime: "fixture" } }; },
    async ingestThrough() {}, async authorizeAbort() { return { home, cancelledMoveId: "move-1" }; },
    onHubRestored() { return () => {}; }, async shutdown() { shutdowns++; } };
  const operation: Operation = { id: "inspect-1", kind: "session-inspect", machineId: MACHINE, expectedEpoch: 2,
    args: { sessionId: id, moveId: "move-1" } };
  return { ...store, id, file, ports, operation, drains: () => drains, shutdowns: () => shutdowns };
}

function raw(path: string, value: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let response = "";
    socket.on("error", reject); socket.on("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", bytes => { response += bytes; }); socket.on("end", () => resolve(JSON.parse(response)));
  });
}

it("control accepts only four verbs and matching operation epoch", async () => {
  const f = fixture(), server = await serveSessionControl({ sessionId: f.id, runtimeRoot: root, ports: f.ports });
  const path = sessionControlPath(root, f.id);
  try {
    expect(statSync(join(root, path.split("/").at(-2)!)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await requestSessionControl(root, f.operation)).toMatchObject({ code: 0, value: { file: f.file, leaf: "leaf-1" } });
    const badVerb = await raw(path, { op: "execute", operation: { ...f.operation, kind: "session-freeze" } });
    const wrongEpoch = await raw(path, { op: "freeze", operation: { ...f.operation, id: "wrong", kind: "session-freeze", expectedEpoch: 3 } });
    const wrongSession = await raw(path, { op: "freeze", operation: { ...f.operation, id: "other", kind: "session-freeze", args: { sessionId: "other", moveId: "move-1" } } });
    expect(badVerb.code).toBe(2); expect(wrongEpoch.code).not.toBe(0); expect(wrongSession.code).toBe(2);
    expect(f.drains()).toBe(0);
    expect(readSessionState(f.db, f.id)?.state).toBe("active");
  } finally { await server.close(); rmSync(join(root, path.split("/").at(-2)!), { recursive: true, force: true }); }
}, 10000);

it("freezes through the private socket and refuses shutdown for another move", async () => {
  const f = fixture(), server = await serveSessionControl({ sessionId: f.id, runtimeRoot: root, ports: f.ports });
  const path = sessionControlPath(root, f.id);
  try {
    const freeze = { ...f.operation, id: "freeze-1", kind: "session-freeze" };
    const ack = await requestSessionControl(root, freeze);
    expect(ack).toMatchObject({ code: 0, value: { sessionId: f.id, leaf: "leaf-1" } });
    expect(readSessionState(f.db, f.id)).toMatchObject({ state: "frozen", moveId: "move-1" });
    const wrong = await raw(path, { op: "shutdown", operation: { ...freeze, id: "retire-bad", kind: "session-retire", args: { sessionId: f.id, moveId: "move-2" } } });
    expect(wrong.code).not.toBe(0); expect(f.shutdowns()).toBe(0);
    const retire = await requestSessionControl(root, { ...freeze, id: "retire-1", kind: "session-retire" });
    expect(retire.code).toBe(0); expect(f.shutdowns()).toBe(1);
    expect(readSessionState(f.db, f.id)?.state).toBe("frozen");
  } finally { await server.close(); rmSync(join(root, path.split("/").at(-2)!), { recursive: true, force: true }); }
}, 10000);

it("keeps the original control failure in the reply and the pending move journal", async () => {
  const f = fixture();
  const operation = { ...f.operation, id: "freeze-failed", kind: "session-freeze" };
  f.ports.journal.begin({ ...operation, id: "move-1", kind: "move" });
  f.ports.gate.refreshInitialHome = async () => {
    throw Object.assign(new Error("fixture freeze failed, token=private-value"), { code: "FIXTURE_FREEZE", path: "/private/fixture", secret: "private-value" });
  };
  const server = await serveSessionControl({ sessionId: f.id, runtimeRoot: root, ports: f.ports });
  try {
    const diagnostic = { code: "FIXTURE_FREEZE", message: "fixture freeze failed, token=[redacted]" };
    const reply = await requestSessionControl(root, operation);
    expect(reply).toMatchObject({ code: 1, reason: "session-control-refused", value: { diagnostic } });
    expect(f.ports.journal.read("move-1")).toContainEqual({ action: "session-control-refused", result: { operationId: operation.id, diagnostic } });
    expect(JSON.stringify(reply) + JSON.stringify(f.ports.journal.read("move-1"))).not.toMatch(/private-value|\/private\/fixture|stack|secret/);
    expect(readSessionState(f.db, f.id)?.state).toBe("active");
  } finally { await server.close(); }
}, 5000);

it("keeps a transported machine cause in the move journal", async () => {
  const f = fixture(), operation = { ...f.operation, id: "transport-failed", kind: "session-freeze" };
  const diagnostic = { name: "FixtureFailure", code: "EIO", message: "fixture failure" };
  f.ports.journal.begin({ ...operation, id: "move-1", kind: "move" });
  f.ports.gate.refreshInitialHome = async () => { throw Object.assign(new Error("intercom-move-unavailable"), { code: "intercom-move-unavailable", diagnostic }); };
  const server = await serveSessionControl({ sessionId: f.id, runtimeRoot: root, ports: f.ports });
  try {
    expect(await requestSessionControl(root, operation)).toMatchObject({ code: 1, reason: "session-control-refused", value: { diagnostic } });
    expect(f.ports.journal.read("move-1")).toContainEqual({ action: "session-control-refused", result: { operationId: operation.id, diagnostic } });
  } finally { await server.close(); }
}, 5000);

it("keeps typed fence blockers in the move journal without changing the refusal", async () => {
  const f = fixture(), operation = { ...f.operation, id: "fence-failed", kind: "session-freeze" };
  const blockers = [{ kind: "intercom-owner-unknown", id: f.id, detail: "Cannot verify the intercom move fence." }];
  f.ports.journal.begin({ ...operation, id: "move-1", kind: "move" });
  f.ports.gate.refreshInitialHome = async () => { throw new IntercomFenceError(blockers); };
  const server = await serveSessionControl({ sessionId: f.id, runtimeRoot: root, ports: f.ports });
  try {
    expect(await requestSessionControl(root, operation)).toMatchObject({ code: 3, reason: "freeze-blocked", value: { blockers } });
    expect(f.ports.journal.read("move-1")).toContainEqual({ action: "session-control-refused", result: { operationId: operation.id,
      diagnostic: { name: "IntercomFenceError", code: null, message: "Cannot verify the intercom move fence", blockers } } });
  } finally { await server.close(); }
}, 5000);

it("dormant freeze holds both locks and uses the physical leaf; retirement needs committed-home proof", async () => {
  const f = fixture(), lockRoot = join(f.root, "ownership");
  appendFileSync(f.file, JSON.stringify({ type: "message", id: "physical-last", parentId: "leaf-1", timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "later" } }) + "\n");
  const identity = { pid: process.pid, startIdentity: "fixture-process" }, leases = createSessionLeases(lockRoot);
  const inventory: ProcessInventoryPorts = { presence: createProcessPresence(lockRoot), leases, processes: async () => [],
    probe: async pid => pid === process.pid ? { kind: "live", startIdentity: identity.startIdentity } : { kind: "absent" } };
  const locks = createBothLocks({ root: lockRoot, file: async () => f.file, inventory, identity, bootId: async () => "boot" });
  let witnessedLocks = false, committed = false, destination = "not-a-machine";
  const blockers = { sessionId: f.id, address: { sessionId: f.id, scopeId: null },
    activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false },
    broker: async () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }),
    bridge: () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }),
    localRoutes: async () => [], topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [] };
  const dormant = createDormantControl({ sessionId: f.id, file: f.file, cwd: f.root, home: f.ports.gate.inspect().home,
    journal: f.ports.journal, stores: f.ports.stores, expectedStores: f.ports.expectedStores, blockerPorts: blockers, intercom: f.ports.intercom,
    async ingestThrough() { witnessedLocks = !!await inspectIdLock(lockRoot, f.id) && !!await leases.get(f.file); },
    authorizeAbort: f.ports.authorizeAbort, onHubRestored: f.ports.onHubRestored, async retryAbort() {},
    async authorizeRetire() { return committed ? { sessionId: f.id, machineId: destination, epoch: 3, moveId: "move-1", updatedAt: 1 } : null; } });
  const routing = { journal: f.ports.journal, probe: async () => ({ kind: "absent" as const }), withBothLocks: locks,
    live: async () => { throw new Error("not live"); }, dormant };
  const operation = { ...f.operation, id: "dormant-freeze", kind: "session-freeze" };
  const ack = await controlSession(operation, routing);
  expect(ack).toMatchObject({ code: 0, value: { owner: null, leaf: "physical-last" } });
  expect(witnessedLocks).toBe(true);
  const retire = { ...operation, id: "dormant-retire", kind: "session-retire" };
  expect((await controlSession(retire, routing)).code).not.toBe(0);
  expect(readSessionState(f.db, f.id)?.state).toBe("frozen");
  committed = true;
  expect((await controlSession(retire, routing)).code).not.toBe(0);
  expect(readSessionState(f.db, f.id)?.state).toBe("frozen");
  destination = "22222222-2222-4222-8222-222222222222";
  expect(await controlSession(retire, routing)).toMatchObject({ code: 0, reason: "retired" });
  expect(readSessionState(f.db, f.id)?.state).toBe("retired");
  expect(f.ports.journal.readFreeze(f.id, "move-1")?.state).toBe("complete");
}, 10000);

it("retries a dormant abort through fresh absence and both locks after reconnect", async () => {
  const f = fixture(), lockRoot = join(f.root, "ownership");
  const identity = { pid: process.pid, startIdentity: "fixture-process" }, leases = createSessionLeases(lockRoot);
  const inventory: ProcessInventoryPorts = { presence: createProcessPresence(lockRoot), leases, processes: async () => [],
    probe: async pid => pid === process.pid ? { kind: "live", startIdentity: identity.startIdentity } : { kind: "absent" } };
  const locks = createBothLocks({ root: lockRoot, file: async () => f.file, inventory, identity, bootId: async () => "boot" });
  const blockers = { sessionId: f.id, address: { sessionId: f.id, scopeId: null },
    activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false },
    broker: async () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }),
    bridge: () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }),
    localRoutes: async () => [], topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [] };
  let hubAvailable = false, witnessedLocks = false, absenceChecks = 0;
  const listeners = new Set<() => void>();
  const routing: SessionControlPorts = { journal: f.ports.journal, probe: async () => { absenceChecks++; return { kind: "absent" as const }; }, withBothLocks: locks,
    live: async () => { throw new Error("not live"); }, dormant: async () => { throw new Error("uninitialized"); } };
  routing.dormant = createDormantControl({ sessionId: f.id, file: f.file, cwd: f.root, home: f.ports.gate.inspect().home,
    journal: f.ports.journal, stores: f.ports.stores, expectedStores: f.ports.expectedStores, blockerPorts: blockers, intercom: f.ports.intercom,
    ingestThrough: f.ports.ingestThrough, async authorizeAbort() {
      if (!hubAvailable) return null;
      witnessedLocks = !!await inspectIdLock(lockRoot, f.id) && !!await leases.get(f.file);
      return { home: f.ports.gate.inspect().home!, cancelledMoveId: "move-1" };
    }, async authorizeRetire() { return null; }, onHubRestored(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async retryAbort(operation) { const result = await controlSession(operation, routing); if (result.code !== 0) throw new Error(result.reason); } });
  const operation = { ...f.operation, id: "dormant-freeze-reconnect", kind: "session-freeze" };
  expect((await controlSession(operation, routing)).code).toBe(0);
  const abort = { ...operation, id: "dormant-abort-reconnect", kind: "session-unfreeze" };
  expect(await controlSession(abort, routing)).toMatchObject({ code: 3, reason: "waiting for the hub to confirm the cancelled move" });
  expect(readSessionState(f.db, f.id)?.state).toBe("frozen");
  hubAvailable = true; for (const listener of [...listeners]) listener();
  await vi.waitFor(() => expect(readSessionState(f.db, f.id)?.state).toBe("active"));
  await vi.waitFor(() => expect(listeners.size).toBe(0));
  expect(witnessedLocks).toBe(true); expect(absenceChecks).toBeGreaterThanOrEqual(6);
}, 10000);

it("refuses dormant freeze when the recorded home names another machine", async () => {
  const f = fixture();
  const blockers = { sessionId: f.id, address: { sessionId: f.id, scopeId: null },
    activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false },
    broker: async () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }),
    bridge: () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }),
    localRoutes: async () => [], topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [] };
  const dormant = createDormantControl({ sessionId: f.id, file: f.file, cwd: f.root,
    home: { ...f.ports.gate.inspect().home!, machineId: "22222222-2222-4222-8222-222222222222" },
    journal: f.ports.journal, stores: f.ports.stores, expectedStores: f.ports.expectedStores, blockerPorts: blockers, intercom: f.ports.intercom,
    ingestThrough: f.ports.ingestThrough, authorizeAbort: f.ports.authorizeAbort, authorizeRetire: async () => null,
    onHubRestored: f.ports.onHubRestored, retryAbort: async () => {} });
  expect((await dormant({ ...f.operation, id: "wrong-home", kind: "session-freeze" })).code).not.toBe(0);
  expect(readSessionState(f.db, f.id)?.state).toBe("active");
}, 5000);

it("rejects an overlong socket path rather than using TCP", async () => {
  const f = fixture(), longRoot = join(root, "x".repeat(80));
  await expect(serveSessionControl({ sessionId: f.id, runtimeRoot: longRoot, ports: f.ports })).rejects.toThrow(/socket.*long|long.*socket/i);
  expect(f.drains()).toBe(0);
}, 5000);
