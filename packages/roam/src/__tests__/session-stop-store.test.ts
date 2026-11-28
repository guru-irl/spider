import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { MachineId } from "@spider/db-core/roam/types";
import { cleanupScratch, scratchDbPath } from "@spider/db-core/testutil";
import { createHomeStore, readManagedHome } from "../relocate/home";
import { createSessionStopStore, projectSessionStatus } from "../relocate/session-stop-store";
import type { OperationBinding, SessionTransition, StopObservation } from "../relocate/session-stop-types";
import type { RelocateId, RunningHome, SessionId, StoppedHome } from "../relocate/types";

const hub = "11111111-1111-4111-8111-111111111111" as MachineId;
const box = "22222222-2222-4222-8222-222222222222" as MachineId;
const other = "33333333-3333-4333-8333-333333333333" as MachineId;
const id = "session-1" as SessionId;
const moveId = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId;
const running: RunningHome = { sessionId: id, machineId: hub, epoch: 7, state: "running", destination: null, moveId, updatedAt: 100 };
const stopped: StoppedHome = { ...running, epoch: 8, state: "stopped", updatedAt: 200 };
const stop: SessionTransition = { action: "stop", operationId: "stop-1", expected: running, committed: stopped,
  mode: "graceful", displaced: [], observations: [], contactReason: null };
const binding: OperationBinding = { action: "stop", request: { operationId: "stop-1", sessionId: id, machineId: hub,
  homeEpoch: 7, mode: "graceful" }, committed: stopped };
const started: RunningHome = { ...running, epoch: 9, updatedAt: 300 };
const start: SessionTransition = { action: "start", operationId: "start-1", expected: stopped, committed: started,
  observedAt: null, contactReason: null };
const bootId = "fixture-boot";
const checking: StopObservation = { sessionId: id, machineId: hub, home: stopped, bootId, observedAt: 1_000,
  evidence: { kind: "checking" } };
const confirmed: StopObservation = { ...checking, observedAt: 11_000, evidence: { kind: "confirmed", owner: null } };

const connections = new Set<Db>();
function connect(file: string): Db {
  const db = openDb(file);
  connections.add(db);
  return db;
}
function close(db: Db): void {
  db.close();
  connections.delete(db);
}
afterEach(() => {
  for (const db of connections) close(db);
  cleanupScratch();
});
function fixture() {
  const file = scratchDbPath("session-stop");
  const writer = connect(file);
  migrate(writer, "global", { machineId: hub, globalRoot: dirname(file) });
  writer.exec("UPDATE roam_meta SET store_key='global', capture_enabled=1");
  writer.prepare(`INSERT INTO session_homes (session_id, machine_id, epoch, move_id, updated_at, state, destination)
    VALUES (?, ?, 7, ?, 100, 'running', NULL)`).run(id, hub, moveId);
  return { file, writer, reader: connect(file), store: createSessionStopStore(writer) };
}
function homes(db: Db) {
  return createHomeStore({ db, hubMachineId: hub, localMachineId: hub });
}

// A hook outside the transaction leaves the home or request committed on throw.
describe("hub session transition store", () => {
  it("writes the request only with the home CAS", async () => {
    const { file, writer, reader, store } = fixture();
    expect(await homes(reader).read(id)).toEqual(running);
    const failure = new Error("after request insert");
    await expect(homes(writer).compareAndSwap(running, stopped, undefined, home => {
      if (home.state !== "stopped") throw new Error("expected a stopped home");
      store.write({ ...stop, committed: home }, binding);
      throw failure;
    })).rejects.toBe(failure);
    close(reader);
    close(writer);

    const reopened = connect(file);
    const reopenedHome = readManagedHome(reopened, id);
    const reopenedStore = createSessionStopStore(reopened);
    expect(reopenedHome).toMatchObject({ state: "running", epoch: 7 });
    expect(reopenedStore.current(id)).toBeNull();
    expect(reopenedStore.operation(binding.request.operationId)).toBeNull();
    expect(reopenedStore.list()).toEqual([]);
    expect(reopened.prepare("SELECT count(*) AS count FROM roam_changes WHERE entity='session_homes'").get())
      .toEqual({ count: 1 });
  });

  // Running a conflict or already-applied hook would admit a different operation.
  it("writes the request only with the home CAS (not on conflict or replay)", async () => {
    const { writer, reader, store: writerStore } = fixture();
    const writerHomes = homes(writer);
    const readerHomes = homes(reader);
    const readerStore = createSessionStopStore(reader);
    writer.exec("UPDATE session_homes SET epoch=6, updated_at=99");
    const stale = await readerHomes.read(id);
    if (stale?.state !== "running") throw new Error("expected a running home");
    expect(await writerHomes.compareAndSwap(stale, running)).toMatchObject({ kind: "applied" });

    const staleTarget = { ...stopped, epoch: 7 };
    const lostBinding: OperationBinding = { ...binding, committed: staleTarget,
      request: { ...binding.request, homeEpoch: 6, operationId: "stale-stop" } };
    const conflict = await readerHomes.compareAndSwap(stale, staleTarget, undefined, () =>
      readerStore.write({ ...stop, operationId: "stale-stop", expected: stale, committed: staleTarget }, lostBinding));
    const bindingAfterConflict = writerStore.operation("stale-stop");
    expect(conflict).toMatchObject({ kind: "conflict", home: running });
    expect(bindingAfterConflict).toBeNull();
    expect(writerStore.current(id)).toBeNull();
    expect(await writerHomes.compareAndSwap(running, stopped, undefined, home => {
      if (home.state !== "stopped") throw new Error("expected a stopped home");
      return writerStore.write({ ...stop, committed: home }, binding);
    })).toMatchObject({ kind: "applied" });
    const appliedHome = readManagedHome(reader, id);
    const appliedRecord = readerStore.current(id);
    expect(appliedHome).toMatchObject({ state: "stopped", epoch: 8, moveId });
    expect(appliedRecord?.committed).toEqual(appliedHome);
    expect(readerStore.operation("stop-1")).toEqual(binding);

    const noOp = await readerHomes.compareAndSwap(running, stopped, undefined, () =>
      readerStore.write({ ...stop, operationId: "stale-stop" }, { ...lostBinding, committed: stopped }));
    expect(noOp.kind).toBe("already-applied");
    expect(createSessionStopStore(writer).operation("stale-stop")).toBeNull();
    expect(readerStore.current(id)).toEqual(appliedRecord);
  });

  it("rolls back both records when the binding insert fails without a CAS", () => {
    const { writer, reader, store } = fixture();
    writer.exec(`CREATE TRIGGER reject_binding BEFORE INSERT ON roam_cursors
      WHEN NEW.peer_stream LIKE 'spider-local:session-transition-operation:%'
      BEGIN SELECT RAISE(ABORT, 'fixture binding write failed'); END`);
    expect(() => store.write(stop, binding)).toThrow("fixture binding write failed");
    const readerStore = createSessionStopStore(reader);
    expect(readerStore.list()).toEqual([]);
    expect(readerStore.operation("stop-1")).toBeNull();
  });

  it("keeps a standalone Stop write out of the replication log", async () => {
    const { writer, reader, store } = fixture();
    expect(await homes(writer).compareAndSwap(running, stopped)).toEqual({ kind: "applied", home: stopped });
    const changes = reader.prepare("SELECT count(*) AS count FROM roam_changes");
    const before = changes.get();

    store.write(stop, binding);

    expect(changes.get()).toEqual(before);
    const readerStore = createSessionStopStore(reader);
    expect(readerStore.current(id)).toEqual(stop);
    expect(readerStore.operation(binding.request.operationId)).toEqual(binding);
  });

  it("retains the original binding when the current transition advances", () => {
    const { store, reader } = fixture();
    const readerStore = createSessionStopStore(reader);
    store.write(stop, binding);
    store.write({ ...stop, mode: "hard" });
    expect(readerStore.current(id)).toMatchObject({ mode: "hard" });
    const rebound: OperationBinding = { ...binding, request: { ...binding.request, mode: "hard" } };
    expect(() => store.write(stop, rebound)).toThrow();
    expect(readerStore.current(id)).toMatchObject({ mode: "hard" });
    store.write(start);
    expect(readerStore.list()).toEqual([start]);
    expect(readerStore.operation("stop-1")).toEqual(binding);
    expect(readerStore.operation("start-1")).toBeNull();
  });

  it("retains an unverified observer when a force returns the home to that machine", async () => {
    const { writer, reader, store } = fixture();
    const fromBox: StoppedHome = { ...running, machineId: box, state: "stopped" };
    writer.prepare("UPDATE session_homes SET machine_id=?, state='stopped'").run(box);
    const placement: SessionTransition = { ...stop, action: "force", operationId: "force-back", expected: fromBox,
      displaced: [hub, other] };
    expect(await homes(writer).compareAndSwap(fromBox, stopped, undefined, () => store.write(placement)))
      .toEqual({ kind: "applied", home: stopped });
    const cache = createSessionStopStore(reader);
    expect(cache.operation("force-back")).toBeNull();
    expect(cache.current(id)).toMatchObject({ displaced: [hub, other] });
    expect(projectSessionStatus(readManagedHome(reader, id), cache.current(id), id, 11_000).reason).toContain(hub);
    store.write({ ...placement, observations: [confirmed] });
    const pending = projectSessionStatus(readManagedHome(reader, id), cache.current(id), id, 11_000);
    expect(pending.reason).toBe(`Stopped on ${hub}. ${other} may still be running.`);
  });

  it("rejects corrupted transitions and bindings on read", () => {
    const { writer, store } = fixture();
    writeLocal(writer, "session-transition", id, { ...stop, committed: running });
    expect(() => store.current(id)).toThrow();
    expect(() => store.list()).toThrow();
    writeLocal(writer, "session-transition", id, { ...stop, observations: [{ ...confirmed, observedAt: "yesterday" }] });
    expect(() => store.current(id)).toThrow();
    writeLocal(writer, "session-transition-operation", "stop-1", { ...binding, request: { ...binding.request, operationId: "wrong-key" } });
    expect(() => store.operation("stop-1")).toThrow();
  });
});

describe("managed home read", () => {
  it("distinguishes a missing or legacy home from an invalid managed home", () => {
    const { writer, reader } = fixture();
    expect(readManagedHome(reader, "nonexistent" as SessionId)).toBeNull();
    writer.exec("UPDATE session_homes SET state=NULL, move_id='legacy-move'");
    expect(readManagedHome(reader, id)).toBeNull();
    writer.exec("UPDATE session_homes SET state='moving', move_id=NULL");
    expect(() => readManagedHome(reader, id)).toThrow();
    writer.exec("UPDATE session_homes SET state=NULL, destination=machine_id");
    expect(() => readManagedHome(reader, id)).toThrow();
  });

  it("reads a pre-v0 home as legacy without changing the table", () => {
    const db = connect(scratchDbPath("old-home"));
    db.exec(`CREATE TABLE session_homes (session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
      epoch INTEGER NOT NULL, move_id TEXT, updated_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO session_homes VALUES (?, ?, 7, 'legacy-move', 100)").run(id, hub);
    expect(readManagedHome(db, id)).toBeNull();
    expect(db.prepare("PRAGMA table_info(session_homes)").all()).toHaveLength(5);
  });
});

describe("cached session status", () => {
  it("uses the check time instead of the read time", () => {
    const { writer, reader, store } = fixture();
    writer.exec("UPDATE session_homes SET state='stopped', epoch=8, updated_at=200");
    const read = createSessionStopStore(reader);
    const status = (now: number) => projectSessionStatus(readManagedHome(reader, id), read.current(id), id, now);
    store.write({ ...stop, observations: [checking] });
    expect(status(999)).toMatchObject({ status: "stop-pending", observedAt: 1_000 });
    expect(status(1_000)).toMatchObject({ status: "stopping", observedAt: 1_000 });
    expect(status(10_999)).toMatchObject({ status: "stopping", observedAt: 1_000 });
    expect(status(11_000)).toMatchObject({ status: "stop-pending", observedAt: 1_000 });
    store.write({ ...stop, observations: [confirmed] });
    expect(status(11_000)).toMatchObject({ status: "stopped", observedAt: 11_000 });
    expect(status(200_000)).toMatchObject({ status: "stopped", observedAt: 11_000 });
  });

  it("does not mistake a home row or an older home record for observed status", () => {
    expect(projectSessionStatus(null, stop, id, 11_000)).toMatchObject({ machineId: null, homeEpoch: null, homeState: null, status: null, observedAt: null });
    expect(projectSessionStatus(running, null, id, 11_000).status).toBeNull();
    expect(projectSessionStatus(stopped, null, id, 11_000)).toMatchObject({ status: "stop-pending", observedAt: null });
    const record = { ...stop, observations: [confirmed] };
    expect(projectSessionStatus({ ...stopped, updatedAt: 201 }, record, id, 11_000))
      .toMatchObject({ status: "stop-pending", observedAt: null });
    expect(projectSessionStatus({ ...stopped, epoch: 9, state: "moving", destination: box, moveId }, record, id, 11_000))
      .toMatchObject({ status: "moving", observedAt: null });
  });

  it("projects only an exact observed Start as running", () => {
    expect(projectSessionStatus(started, start, id, 11_000)).toMatchObject({ status: "starting", observedAt: null });
    expect(projectSessionStatus(started, { ...start, observedAt: 10_000 }, id, 200_000))
      .toMatchObject({ status: "running", observedAt: 10_000 });
    expect(projectSessionStatus({ ...started, epoch: 10 }, { ...start, observedAt: 10_000 }, id, 200_000))
      .toMatchObject({ status: null, observedAt: null });
  });

  it("lists job blockers and only their eligible owning-session cancel hints", () => {
    const blocker: StopObservation = { ...checking, evidence: { kind: "pending", reason: "failed at /private/process/path",
      blockers: [{ kind: "job", id: "manifest-job", cancelFromOwner: false }, { kind: "job", id: "owned-job", cancelFromOwner: true },
        { kind: "check", reason: "peer error /private/check/path" }] } };
    const blockedInsideWindow = projectSessionStatus(stopped, { ...stop, observations: [blocker] }, id, 1_001);
    expect(blockedInsideWindow).toMatchObject({ status: "stop-pending", observedAt: 1_000 });
    expect(blockedInsideWindow.reason).toContain("manifest-job");
    expect(blockedInsideWindow.reason).toContain('spider kill id:"owned-job"');
    expect(blockedInsideWindow.reason).toContain("owning session");
    expect(blockedInsideWindow.reason).not.toContain('spider kill id:"manifest-job"');
    expect(blockedInsideWindow.reason).not.toContain("/private/");
  });

  it("retains every displacement until its own exact exit proof arrives", () => {
    const force: SessionTransition = { ...stop, action: "force", displaced: [box, other], observations: [confirmed] };
    const wrongRow = { ...confirmed, machineId: box, home: running };
    const unknownBoot = { ...confirmed, machineId: other, bootId: null };
    const waiting = projectSessionStatus(stopped, { ...force, observations: [confirmed, wrongRow, unknownBoot] }, id, 12_000);
    expect(waiting).toMatchObject({ status: "stop-pending", observedAt: 11_000 });
    expect(waiting.reason).toContain(box);
    expect(waiting.reason).toContain(other);
    expect(projectSessionStatus(stopped, { ...force, observations: [confirmed, { ...confirmed, machineId: box }, { ...confirmed, machineId: other }] }, id, 200_000))
      .toMatchObject({ status: "stopped", reason: null, observedAt: 11_000 });
  });

  it("keeps exact confirmation across contact failure but loses it on a missing replica", () => {
    const contactReason = "Stop pending: the box is unreachable and may still be running";
    expect(projectSessionStatus(stopped, { ...stop, contactReason }, id, 12_000))
      .toMatchObject({ status: "stop-pending", reason: contactReason, observedAt: null });
    expect(projectSessionStatus(stopped, { ...stop, contactReason, observations: [confirmed] }, id, 12_000))
      .toMatchObject({ status: "stopped", reason: null, observedAt: 11_000 });
    expect(projectSessionStatus(stopped, { ...stop, observations: [{ ...confirmed, home: null, observedAt: 12_000,
      evidence: { kind: "pending", reason: "missing replica", blockers: [] } }] }, id, 12_001))
      .toMatchObject({ status: "stop-pending", reason: expect.stringMatching(/replica/i), observedAt: 12_000 });
  });
});
