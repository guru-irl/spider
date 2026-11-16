// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from "vitest";
import type { Home } from "@spider/db-core/roam/types";
import * as claim from "../claim";
import * as homes from "../homes";
import { BOX, HUB, OTHER, recoveryFixture } from "./recovery-fixture";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture(assigned = false) { const f = await recoveryFixture(assigned); cleanups.push(f.close); return f; }
const run = (f: Awaited<ReturnType<typeof fixture>>) => claim.claimInitialHome({ sessionId: "session-a", machineId: BOX }, f.ports);
function marker(f: Awaited<ReturnType<typeof fixture>>): Home {
  homes.markInitialConflict(f.global.db, "session-a", HUB);
  return f.global.db.prepare("SELECT session_id AS sessionId,machine_id AS machineId,epoch,move_id AS moveId,updated_at AS updatedAt FROM session_homes WHERE session_id='session-a'").get() as Home;
}

it("claim accepts only unassigned origins with every competing copy stopped", async () => {
  const f = await fixture(); f.copies([{ machineId: BOX, owner: { kind: "absent" } }, { machineId: OTHER, owner: { kind: "uncertain" } }]);
  expect((await run(f)).reason).toBe("claim-copies-not-stopped");
  expect(homes.sessionHome(f.global.db, "session-a")).toBeNull();
  f.copies([{ machineId: BOX, owner: { kind: "absent" } }, { machineId: OTHER, owner: { kind: "absent" } }]);
  const result = await run(f); expect(result.code).toBe(0); expect(result.home?.epoch).toBe(1); expect(result.home?.machineId).toBe(BOX);
  const assigned = await fixture(true), existingAssignedHomeBefore = homes.sessionHome(assigned.global.db, "session-a");
  expect((await run(assigned)).reason).toBe("claim-home-assigned");
  const existingAssignedHomeAfterClaimRefusal = homes.sessionHome(assigned.global.db, "session-a");
  expect(existingAssignedHomeAfterClaimRefusal).toEqual(existingAssignedHomeBefore);
}, 5000);

it("reachable uncertain or live competing process blocks claim", async () => {
  for (const owner of [{ kind: "uncertain" as const }, { kind: "live" as const, identity: { bootId: "fake", pid: 42, startTime: "fake" } }]) {
    const f = await fixture(); f.copies([{ machineId: BOX, owner: { kind: "absent" } }, { machineId: OTHER, owner }]);
    expect((await run(f)).reason).toBe("claim-copies-not-stopped"); expect(homes.sessionHome(f.global.db, "session-a")).toBeNull();
  }
}, 5000);

it("offline or unknown origin cannot be claimed", async () => {
  const f = await fixture(); f.ports.recovery.conflicts = async () => { throw new Error("offline"); };
  expect((await run(f)).code).toBe(1); expect(homes.sessionHome(f.global.db, "session-a")).toBeNull();
  f.copies([]); f.ports.recovery.conflicts = async () => [];
  expect((await run(f)).reason).toBe("claim-origin-missing");
}, 5000);

it("claim resolves the exact reserved conflict marker at epoch two", async () => {
  const f = await fixture(); marker(f);
  const result = await run(f); expect(result.code).toBe(0); expect(result.home?.epoch).toBe(2); expect(result.home?.machineId).toBe(BOX);
}, 5000);

it("move and forget CAS still refuse the initial conflict marker", async () => {
  const f = await fixture(), expected = marker(f);
  for (const operation of ["move-a", "forget-a"]) expect(() => homes.casHome(f.global.db, expected, BOX, operation, HUB)).toThrow("Invalid home arguments");
  expect(marker(f)).toEqual(expected);
}, 5000);

it("initial conflict resolver refuses every other shape and a changed row", async () => {
  const f = await fixture(), expected = marker(f);
  for (const invalid of [{ ...expected, epoch: 2 }, { ...expected, moveId: "move-a" }, { ...expected, machineId: BOX }]) {
    expect(() => homes.resolveInitialConflict(f.global.db, invalid, BOX, HUB)).toThrow();
  }
  f.global.db.prepare("UPDATE session_homes SET epoch=2 WHERE session_id='session-a'").run();
  expect(() => homes.resolveInitialConflict(f.global.db, expected, BOX, HUB)).toThrow();
}, 5000);

it("claim rechecks assigned home after asynchronous competing-copy inspection", async () => {
  const f = await fixture(); f.ports.recovery.conflicts = async () => {
    homes.assignInitialHome(f.global.db, "session-a", OTHER, HUB);
    return [{ machineId: BOX, owner: { kind: "absent" } }, { machineId: OTHER, owner: { kind: "absent" } }];
  };
  expect((await run(f)).reason).toBe("claim-home-assigned"); expect((homes.sessionHome(f.global.db, "session-a") as Home).machineId).toBe(OTHER);
}, 5000);

it("initial conflict resolver refuses a same-shape row with a changed timestamp", async () => {
  const f = await fixture(), expected = marker(f);
  f.global.db.prepare("UPDATE session_homes SET updated_at=updated_at+1 WHERE session_id='session-a'").run();
  expect(() => homes.resolveInitialConflict(f.global.db, expected, BOX, HUB)).toThrow("Initial conflict marker changed");
  expect(homes.sessionHome(f.global.db, "session-a")).toBeNull();
}, 5000);

it("claim refuses an active move reservation before inspecting competing copies", async () => {
  const f = await fixture(); marker(f);
  const { moveSessionSlot } = await import("../move");
  const slot = moveSessionSlot("session-a");
  f.ports.journal.begin({ id: slot, kind: "move-session", machineId: HUB, expectedEpoch: null, args: { sessionId: "session-a" } });
  f.ports.journal.record(slot, "reserved", { moveId: "move-a", destinationMachine: BOX });
  f.ports.recovery.conflicts = async () => { throw new Error("must not inspect"); };
  expect((await run(f)).reason).toBe("move-session-conflict");
  expect(homes.sessionHome(f.global.db, "session-a")).toBeNull();
}, 5000);

it("claim uses fresh absence evidence without a redundant stopped-copies assertion", async () => {
  const f = await fixture();
  expect(await claim.claimInitialHome({ sessionId: "session-a", machineId: BOX }, f.ports)).toMatchObject({ code: 0, home: { machineId: BOX, epoch: 1 } });
}, 5000);
