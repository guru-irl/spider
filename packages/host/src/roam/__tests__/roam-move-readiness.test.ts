import { expect, it, vi } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { join } from "node:path";
import { openFreezeJournal } from "@spider/roam/journal";
import { createRunningIntentAuthority, readReadiness } from "@spider/roam/session-control";
import { publishOwnedMoveReadiness, readOwnedLaunchReadiness, type OwnedMoveReadinessInput } from "../move-readiness";
const HUB = "00000000-0000-4000-8000-000000000001";
it("proved live readmit publishes readiness for an originally untracked held lock without launching or releasing it", async () => {
  const f = createReplica("global", HUB), journal = openFreezeJournal(join(f.root, "journal.db"));
  try {
    const file = join(f.root, "session.jsonl"), home = { sessionId: "session-a", machineId: HUB, epoch: 4, moveId: "rollback-a", updatedAt: 1 };
    await createRunningIntentAuthority(f.db).set({ sessionId: "session-a", file, cwd: f.root, epoch: 4, desired: "running", suspended: null, moveId: "rollback-a" }, "readmit-a", { kind: "hub-return", machineId: HUB, moveId: "move-a" });
    journal.begin({ id: "readmit-a", machineId: HUB, kind: "move-readmit", expectedEpoch: 4, args: {} });
    const lock = { identity: { pid: 42, startIdentity: "owned-start" }, bootId: "boot-a", operationId: null, pendingOperationId: null, pendingCoreId: null, pendingFile: null };
    const caller = vi.fn(async () => ({ coreId: "core-a", address: "terminal-a" }));
    const input: OwnedMoveReadinessInput = { db: f.db, journal, sessionId: "session-a", machineId: HUB, file, cwd: f.root, epoch: 4, home,
      owner: async () => ({ pid: 42, startTime: "owned-start" }), lock: async () => lock, caller };
    await expect(publishOwnedMoveReadiness(input)).rejects.toThrow("participant-launch-provenance-unavailable");
    expect(caller).not.toHaveBeenCalled();
    const ready = await publishOwnedMoveReadiness({ ...input, readmitOperationId: "readmit-a" });
    expect(ready).toMatchObject({ opId: "readmit-a", epoch: 4, file, cwd: f.root, terminal: "terminal-a" });
    expect(readReadiness(journal, "readmit-a")).toEqual(ready);
    expect(lock.operationId).toBeNull(); expect(caller).toHaveBeenCalledOnce();
    await expect(publishOwnedMoveReadiness({ ...input, readmitOperationId: "readmit-a", lock: async () => ({ ...lock, identity: { pid: 43, startIdentity: "foreign" } }) })).rejects.toThrow("participant-launch-provenance-unavailable");
    expect(caller).toHaveBeenCalledOnce();
  } finally { f.close(); }
});


async function launchReadinessFixture() {
  const f = createReplica("global", HUB), journal = openFreezeJournal(join(f.root, "journal.db"));
  const file = join(f.root, "session.jsonl"), home = { sessionId: "session-a", machineId: HUB, epoch: 4, moveId: "move-a", updatedAt: 1 };
  f.db.prepare("INSERT INTO session_homes VALUES(?,?,?,?,?)").run(home.sessionId, HUB, home.epoch, home.moveId, home.updatedAt);
  await createRunningIntentAuthority(f.db).set({ sessionId: home.sessionId, file, cwd: f.root, epoch: home.epoch, desired: "running", suspended: null, moveId: home.moveId },
    "intent-a", { kind: "hub-return", machineId: HUB, moveId: "move-a" });
  for (const id of ["intent-a", "launch-a", "launch-b"]) journal.begin({ id, machineId: HUB, kind: id === "intent-a" ? "session-start" : "exact-session-launch", expectedEpoch: home.epoch, args: { sessionId: home.sessionId } });
  const lock = { identity: { pid: 42, startIdentity: "owned-start" }, bootId: "boot-a", operationId: "launch-a", pendingOperationId: null, pendingCoreId: null, pendingFile: null };
  const input: OwnedMoveReadinessInput = { db: f.db, journal, sessionId: home.sessionId, machineId: HUB, file, cwd: f.root, epoch: home.epoch, home,
    owner: async () => ({ pid: 42, startTime: "owned-start" }), lock: async () => lock, caller: async () => ({ coreId: "core-a", address: "terminal-a" }) };
  const wait = (query = { sessionId: home.sessionId, launchId: "launch-a", epoch: home.epoch }) => readOwnedLaunchReadiness({ db: f.db, journal, machineId: HUB,
    lock: async () => lock, probe: async () => ({ kind: "live", identity: { bootId: "boot-a", pid: 42, startTime: "owned-start" } }) }, query);
  return { ...f, journal, input, lock, wait };
}

it("the exact launch readiness completes the launcher's tuple wait and records the intent only as audit", async () => {
  const f = await launchReadinessFixture();
  try {
    const ready = await publishOwnedMoveReadiness(f.input);
    expect(ready).toMatchObject({ sessionId: "session-a", opId: "launch-a", epoch: 4 });
    expect(await f.wait()).toEqual(ready);
    expect(readReadiness(f.journal, "intent-a")).toBeNull();
    expect(f.journal.read("launch-a").find(row => row.action === "readiness-intent")?.result).toEqual({ sessionId: "session-a", epoch: 4, intentOperationId: "intent-a" });
    await publishOwnedMoveReadiness(f.input);
    expect(f.journal.read("launch-a").filter(row => row.action === "readiness-intent")).toHaveLength(1);
  } finally { f.close(); }
}, 5000);

it("another launch for the same intent cannot complete the awaited launch", async () => {
  const f = await launchReadinessFixture();
  try {
    f.lock.operationId = "launch-b";
    const other = await publishOwnedMoveReadiness(f.input);
    expect(other?.opId).toBe("launch-b");
    expect(await f.wait()).toBeNull();
    f.lock.operationId = "launch-a";
    const ready = await publishOwnedMoveReadiness(f.input);
    expect(await f.wait()).toEqual(ready);
    expect(await f.wait({ sessionId: "different-session", launchId: "launch-a", epoch: 4 })).toBeNull();
    expect(await f.wait({ sessionId: "session-a", launchId: "launch-a", epoch: 5 })).toBeNull();
    f.lock.operationId = "launch-b";
    expect(await f.wait()).toBeNull();
  } finally { f.close(); }
}, 5000);

it.each(["valid", "other-intent", "older-epoch", "unrecorded"] as const)("restart readiness follows only the recorded same-intent chain: %s", async mode => {
  const f = await launchReadinessFixture();
  try {
    const launchId = "launch-a-restart-1";
    f.journal.begin({ id: "launch-a-restarts", kind: "participant-restarts", machineId: HUB, expectedEpoch: mode === "older-epoch" ? 3 : 4,
      args: { sessionId: "session-a", operationId: mode === "other-intent" ? "intent-other" : "intent-a", file: f.input.file, cwd: f.input.cwd, moveId: "move-a" } });
    if (mode !== "unrecorded") f.journal.record("launch-a-restarts", "restart", { sequence: 1, previousLaunchId: "launch-a" });
    f.journal.begin({ id: launchId, kind: "exact-session-launch", machineId: HUB, expectedEpoch: 4, args: { sessionId: "session-a" } });
    f.lock.operationId = launchId;
    const ready = await publishOwnedMoveReadiness(f.input);
    expect(await f.wait()).toEqual(mode === "valid" ? ready : null);
  } finally { f.close(); }
}, 5000);
