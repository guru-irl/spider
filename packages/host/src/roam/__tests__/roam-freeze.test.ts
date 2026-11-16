import { fixtureIntercom } from "./intercom-move-fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Home } from "@spider/db-core/roam/types";
import type { Operation } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { unfinishedFreeze } from "@spider/roam/participant-supervisor";
import type { FreezePorts } from "../freeze.js";
import type { AdmissionGate } from "../admission.js";
const freeze = await import("../freeze.js").catch(() => ({} as typeof import("../freeze.js")));

const MACHINE = "11111111-1111-4111-8111-111111111111";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

function fixture() {
  const first = createReplica("worktree", MACHINE), second = createReplica("worktree", MACHINE);
  fixtures.push(first, second);
  for (const [index, store] of [first, second].entries()) {
    store.db.prepare("UPDATE roam_meta SET store_key=?,capture_enabled=1 WHERE id=1").run(`worktree:fixture:workspace-${index}`);
    store.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('session-1',2,'active')").run();
    store.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('session-1',1,?)").run(MACHINE);
  }
  const stores = [first.db, second.db];
  const file = join(first.root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: first.root }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fixture", timestamp: 1 } }) + "\n");
  const journal = openFreezeJournal(join(first.root, "roam", "journal.db"));
  const home: Home = { sessionId: "session-1", machineId: MACHINE, epoch: 2, moveId: null, updatedAt: 1 };
  const operation: Operation = { id: "freeze-1", kind: "session-freeze", machineId: MACHINE, expectedEpoch: 2, args: { sessionId: "session-1", moveId: "move-1" } };
  const abort: Operation = { ...operation, id: "abort-1", kind: "session-unfreeze" };
  const order: string[] = [], listeners = new Set<() => void>();
  let admitted = true, resumes = 0;
  let authorization: { home: Home; cancelledMoveId: string } | null = { home, cancelledMoveId: "move-1" };
  let blockers: Array<{ kind: string; id: string; detail: string }> = [];
  let onResume: (() => void) | undefined;
  const gate: AdmissionGate = {
    inspect: () => ({ kind: admitted ? "ordinary" : "control-only", home, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(), close: async () => { admitted = false; },
    freeze: async () => { admitted = false; order.push("close-gates"); },
    unfreeze: async () => { admitted = true; },
  };
  const ports: FreezePorts = {
    gate, journal, stores, intercom: fixtureIntercom("session-1"), expectedStores: ["worktree:fixture:workspace-0", "worktree:fixture:workspace-1"],
    async drain() { order.push("drain"); },
    async resume() { resumes++; onResume?.(); },
    async inspect() { order.push("recheck"); return { blockers, file, cwd: first.root, leaf: "leaf-1", owner: null }; },
    async ingestThrough(source, size) {
      expect(source).toBe(file); expect(size).toBe(readFileSync(file).length);
      expect(stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["frozen", "frozen"]);
      order.push("freeze-all");
    },
    async authorizeAbort() { return authorization; },
    onHubRestored(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { first, second, stores, file, journal, home, operation, abort, order, ports,
    admitted: () => admitted, resumes: () => resumes,
    setAuthorization(value: typeof authorization) { authorization = value; },
    setBlockers(value: typeof blockers) { blockers = value; },
    restored() { for (const listener of [...listeners]) listener(); },
    listeners: () => listeners.size,
    whenResumed() { return new Promise<void>(resolve => { onResume = resolve; }); },
  };
}

it("freeze stops all producers before durable acknowledgement", async () => {
  const f = fixture();
  expect(freeze.freezeParticipant).toBeTypeOf("function");
  const bytes = readFileSync(f.file);
  const ack = await freeze.freezeParticipant(f.operation, f.ports);
  f.order.push("ack");
  expect(f.order).toEqual(["close-gates", "drain", "recheck", "freeze-all", "ack"]);
  expect(ack).toMatchObject({ operationId: "freeze-1", sessionId: "session-1", epoch: 2, owner: null,
    file: f.file, cwd: f.first.root, leaf: "leaf-1", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  expect(ack.barriers).toHaveLength(f.stores.length);
  expect(f.stores.map(db => readSessionState(db, "session-1"))).toEqual(ack.barriers.map(barrier =>
    ({ sessionId: "session-1", epoch: 2, state: "frozen", moveId: "move-1", freezeSeq: barrier.through })));
  let ordinaryWritesAfterAck = 0;
  for (const db of f.stores) {
    try { db.prepare("UPDATE sessions SET name='late' WHERE id='session-1'").run(); ordinaryWritesAfterAck++; } catch { /* The SQL fence refuses the write. */ }
  }
  expect(ordinaryWritesAfterAck).toBe(0);
  expect(unfinishedFreeze(f.first.root, "session-1")).toBe(true);
  expect(f.admitted()).toBe(false);
}, 5000);

it("does not acknowledge an incomplete discovered store roster", async () => {
  const f = fixture();
  f.ports.stores = [f.first.db];
  f.ports.ingestThrough = async () => {};
  await expect(freeze.freezeParticipant(f.operation, f.ports)).rejects.toThrow(/roster/i);
  expect(f.journal.read("freeze-1").some(row => row.action === "done")).toBe(false);
  expect(f.admitted()).toBe(false);
}, 5000);

it("does not reactivate a store without current participant ownership", async () => {
  const f = fixture();
  await freeze.freezeParticipant(f.operation, f.ports);
  f.ports.gate.freeze = async () => { throw new Error("ownership unavailable"); };
  await expect(freeze.unfreezeParticipant(f.abort, f.ports)).rejects.toThrow(/ownership/);
  expect(f.stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["frozen", "frozen"]);
}, 5000);

it("does not reactivate only a subset when the recovered roster changes", async () => {
  const f = fixture();
  await freeze.freezeParticipant(f.operation, f.ports);
  f.ports.stores = [f.first.db];
  f.ports.expectedStores = ["worktree:fixture:workspace-0"];
  await expect(freeze.unfreezeParticipant(f.abort, f.ports)).rejects.toThrow(/roster/i);
  expect(f.stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["frozen", "frozen"]);
}, 5000);

it("does not replay an acknowledgement after a store stops matching it", async () => {
  const f = fixture();
  await freeze.freezeParticipant(f.operation, f.ports);
  f.second.db.prepare("UPDATE roam_sessions SET state='active',move_id=NULL,freeze_seq=NULL WHERE session_id='session-1'").run();
  await expect(freeze.freezeParticipant(f.operation, f.ports)).rejects.toThrow(/frozen|barrier/i);
}, 5000);

it("partial multi-store freeze reconciles before unfreeze and double resume", async () => {
  const f = fixture();
  expect(freeze.freezeParticipant).toBeTypeOf("function");
  f.second.db.exec("CREATE TRIGGER freeze_fault BEFORE UPDATE ON roam_sessions WHEN NEW.state='frozen' BEGIN SELECT RAISE(FAIL,'fixture freeze failure'); END");
  await expect(freeze.freezeParticipant(f.operation, f.ports)).rejects.toThrow("fixture freeze failure");
  expect(f.stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["frozen", "active"]);
  expect(unfinishedFreeze(f.first.root, "session-1")).toBe(true);
  await freeze.unfreezeParticipant(f.abort, f.ports);
  expect(f.stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["active", "active"]);
  expect(f.journal.readFreeze("session-1", "move-1")?.state).toBe("aborted");
  expect(f.admitted()).toBe(true);
  await freeze.unfreezeParticipant(f.abort, f.ports);
  expect(f.resumes()).toBe(1);
  expect(unfinishedFreeze(f.first.root, "session-1")).toBe(false);
  await expect(freeze.freezeParticipant(f.operation, f.ports)).rejects.toThrow(/cancel|abort/i);
}, 5000);

it("returns exact blockers without cancelling work after producer drain", async () => {
  const f = fixture(), cancelledWork: string[] = [];
  expect(freeze.freezeParticipant).toBeTypeOf("function");
  f.setBlockers([{ kind: "intercom-ask-inbound", id: "ask-1", detail: "waiting" }, { kind: "run", id: "run-1", detail: "running" }]);
  try { await freeze.freezeParticipant(f.operation, f.ports); throw new Error("freeze unexpectedly succeeded"); }
  catch (error) {
    expect((error as { blockers?: readonly { id: string }[] }).blockers?.map(item => item.id)).toEqual(["ask-1", "run-1"]);
  }
  expect(cancelledWork).toEqual([]);
  expect(f.stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["active", "active"]);
  expect(f.admitted()).toBe(false);
  expect(unfinishedFreeze(f.first.root, "session-1")).toBe(true);
}, 5000);

it.each(["unreachable", "wrong epoch", "commit not cancelled"] as const)("keeps a frozen source closed when abort proof is %s", async failure => {
  const f = fixture();
  expect(freeze.freezeParticipant).toBeTypeOf("function");
  await freeze.freezeParticipant(f.operation, f.ports);
  f.setAuthorization(failure === "unreachable" ? null : failure === "wrong epoch"
    ? { home: { ...f.home, epoch: 3 }, cancelledMoveId: "move-1" }
    : { home: f.home, cancelledMoveId: "other-move" });
  await expect(freeze.unfreezeParticipant(f.abort, f.ports)).rejects.toMatchObject({ code: "abort-authorization-pending", message: "waiting for the hub to confirm the cancelled move" });
  expect(f.stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["frozen", "frozen"]);
  expect(f.admitted()).toBe(false);
  expect(f.resumes()).toBe(0);
  expect(unfinishedFreeze(f.first.root, "session-1")).toBe(true);
}, 5000);

it("automatically retries a pending abort when the hub link returns", async () => {
  const f = fixture();
  expect(freeze.freezeParticipant).toBeTypeOf("function");
  await freeze.freezeParticipant(f.operation, f.ports);
  f.setAuthorization(null);
  await expect(freeze.unfreezeParticipant(f.abort, f.ports)).rejects.toMatchObject({ code: "abort-authorization-pending" });
  const resumed = f.whenResumed();
  f.setAuthorization({ home: f.home, cancelledMoveId: "move-1" });
  f.restored(); await resumed;
  expect(f.stores.map(db => readSessionState(db, "session-1")?.state)).toEqual(["active", "active"]);
  expect(f.admitted()).toBe(true);
  expect(f.resumes()).toBe(1);
}, 5000);

it("a guarded reconnect retry releases the original watcher after success", async () => {
  const f = fixture();
  await freeze.freezeParticipant(f.operation, f.ports);
  f.setAuthorization(null);
  const guarded = { ...f.ports, retryAbort: undefined };
  let hubAvailable = false;
  f.ports.retryAbort = async operation => { if (!hubAvailable) throw new Error("hub unavailable"); await freeze.unfreezeParticipant(operation, guarded); };
  await expect(freeze.unfreezeParticipant(f.abort, f.ports)).rejects.toMatchObject({ code: "abort-authorization-pending" });
  expect(f.listeners()).toBe(1);
  const resumed = f.whenResumed();
  f.setAuthorization({ home: f.home, cancelledMoveId: "move-1" }); hubAvailable = true;
  f.restored(); await resumed;
  await vi.waitFor(() => expect(f.listeners()).toBe(0));
}, 5000);

it.each(["wrong session", "partial tail"] as const)("refuses an invalid frozen transcript: %s", async failure => {
  const f = fixture();
  expect(freeze.freezeParticipant).toBeTypeOf("function");
  if (failure === "wrong session") writeFileSync(f.file, JSON.stringify({ type: "session", version: 3, id: "other", cwd: f.first.root }) + "\n");
  else appendFileSync(f.file, "{partial");
  await expect(freeze.freezeParticipant(f.operation, f.ports)).rejects.toThrow();
  expect(f.admitted()).toBe(false);
  expect(unfinishedFreeze(f.first.root, "session-1")).toBe(true);
  expect(f.journal.read("freeze-1").some(row => row.action === "done")).toBe(false);
}, 5000);

it("dormant freeze uses the last physical leaf, not an earlier branch", async () => {
  const f = fixture();
  appendFileSync(f.file, JSON.stringify({ type: "message", id: "later", parentId: "leaf-1", timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "later" } }) + "\n");
  expect(await freeze.inspectDormantTranscript(f.file, "session-1")).toMatchObject({ leaf: "later", cwd: f.first.root });
  await expect(freeze.freezeParticipant(f.operation, f.ports)).rejects.toThrow(/physical leaf/i);
  expect(f.journal.read("freeze-1").some(row => row.action === "done")).toBe(false);
}, 5000);

it("live freeze preserves an older selected leaf even if a later branch exists", async () => {
  const f = fixture();
  appendFileSync(f.file, JSON.stringify({ type: "message", id: "later", parentId: "leaf-1", timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "later" } }) + "\n");
  f.ports.inspect = async () => ({ blockers: [], file: f.file, cwd: f.first.root, leaf: "leaf-1", owner: { bootId: "boot", pid: process.pid, startTime: "fixture" } });
  expect(await freeze.freezeParticipant(f.operation, f.ports)).toMatchObject({ leaf: "leaf-1" });
}, 5000);

it.each(["duplicate", "missing parent"] as const)("refuses a dormant session with %s", async failure => {
  const f = fixture();
  const entry = { type: "message", id: failure === "duplicate" ? "leaf-1" : "new", parentId: failure === "duplicate" ? null : "missing",
    timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "fixture" } };
  appendFileSync(f.file, JSON.stringify(entry) + "\n");
  await expect(freeze.inspectDormantTranscript(f.file, "session-1")).rejects.toThrow();
}, 5000);

it("does not acknowledge a transcript that changes during usage ingest", async () => {
  const f = fixture();
  expect(freeze.freezeParticipant).toBeTypeOf("function");
  f.ports.ingestThrough = async () => { appendFileSync(f.file, "{}\n"); };
  await expect(freeze.freezeParticipant(f.operation, f.ports)).rejects.toThrow(/changed/i);
  expect(f.admitted()).toBe(false);
  expect(unfinishedFreeze(f.first.root, "session-1")).toBe(true);
  expect(f.journal.read("freeze-1").some(row => row.action === "done")).toBe(false);
}, 5000);
