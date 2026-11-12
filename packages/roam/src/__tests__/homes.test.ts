import { afterEach, expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { assignInitialHome, casHome, cancelHomeAction, markInitialConflict } from "../homes";
const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: Array<{ close(): void }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = createReplica("global", HUB); fixtures.push(f); f.db.prepare("UPDATE roam_meta SET capture_enabled=1").run(); return f; }
it("initial assignment is insert-if-absent at epoch one", () => {
  const { db } = fixture();
  const firstHome = assignInitialHome(db, "session-a", BOX, HUB);
  expect(firstHome).not.toBe("conflict"); if (firstHome === "conflict") throw new Error("unexpected conflict");
  expect(firstHome.epoch).toBe(1);
  expect(assignInitialHome(db, "session-a", HUB, HUB)).toEqual(firstHome);
  markInitialConflict(db, "session-a", HUB);
  expect(assignInitialHome(db, "session-a", BOX, HUB)).toEqual(firstHome);
  expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 1 });
}, 5000);
it("conflicting unassigned origins replicate a blocking marker", () => {
  const { db } = fixture(); markInitialConflict(db, "session-a", HUB); markInitialConflict(db, "session-a", HUB);
  const conflictMarker = db.prepare("SELECT machine_id,epoch,move_id FROM session_homes").get() as { machine_id: string };
  expect(conflictMarker.machine_id).toBe("");
  expect(conflictMarker).toEqual({ machine_id: "", epoch: 1, move_id: null });
  expect(assignInitialHome(db, "session-a", BOX, HUB)).toBe("conflict");
  expect(db.prepare("SELECT origin_machine FROM roam_changes").all()).toEqual([{ origin_machine: HUB }]);
}, 5000);
it("CAS increments every forward and rollback epoch", () => {
  const { db } = fixture(); const firstHome = assignInitialHome(db, "session-a", HUB, HUB);
  if (firstHome === "conflict") throw new Error("unexpected conflict");
  const nextHome = casHome(db, firstHome, BOX, "move-a", HUB);
  expect(nextHome.epoch).toBe(firstHome.epoch + 1);
  expect(casHome(db, firstHome, BOX, "move-a", HUB)).toEqual(nextHome);
  const rollback = casHome(db, nextHome, HUB, "rollback-a", HUB);
  expect(rollback).toMatchObject({ machineId: HUB, epoch: 3, moveId: "rollback-a" });
  expect(db.prepare("SELECT count(*) AS n FROM roam_home_actions WHERE committed_home_json IS NOT NULL").get()).toEqual({ n: 2 });
}, 5000);
it("equal epoch cannot change owner or move ID", () => {
  const { db } = fixture(); const home = assignInitialHome(db, "session-a", HUB, HUB); if (home === "conflict") throw new Error("unexpected conflict");
  casHome(db, home, BOX, "move-a", HUB);
  expect(() => casHome(db, home, HUB, "other", HUB)).toThrow(/compare|epoch/i);
  expect(() => casHome(db, home, HUB, "move-a", HUB)).toThrow(/argument|conflict/i);
  expect(db.prepare("SELECT machine_id,epoch,move_id FROM session_homes").get()).toEqual({ machine_id: BOX, epoch: 2, move_id: "move-a" });
}, 5000);
it("cancelled action cannot commit later", () => {
  const { db } = fixture(); const home = assignInitialHome(db, "session-a", HUB, HUB); if (home === "conflict") throw new Error("unexpected conflict");
  cancelHomeAction(db, home, BOX, "move-a", HUB);
  expect(() => casHome(db, home, BOX, "move-a", HUB)).toThrow(/cancelled/i);
  expect(db.prepare("SELECT epoch FROM session_homes").get()).toEqual({ epoch: 1 });
  expect(db.prepare("SELECT cancelled,committed_home_json FROM roam_home_actions").get()).toEqual({ cancelled: 1, committed_home_json: null });
}, 5000);
it("a box cannot assign or change homes and a failed receipt rolls back the home", () => {
  const { db } = fixture(); expect(() => assignInitialHome(db, "session-a", BOX, BOX)).toThrow(/hub/i);
  const home = assignInitialHome(db, "session-a", HUB, HUB); if (home === "conflict") throw new Error("unexpected conflict");
  db.exec("CREATE TRIGGER reject_home_receipt BEFORE INSERT ON roam_home_actions BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  expect(() => casHome(db, home, BOX, "move-a", HUB)).toThrow(/fixture failure/);
  expect(db.prepare("SELECT epoch FROM session_homes").get()).toEqual({ epoch: 1 });
}, 5000);
