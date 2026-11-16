import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { unfinishedFreeze } from "../participant-supervisor.js";
import * as journal from "../journal.js";

const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture() {
  const replica = createReplica("global", "11111111-1111-4111-8111-111111111111");
  fixtures.push(replica);
  return { ...replica, file: join(replica.root, "roam", "journal.db") };
}

it("records freeze progress in the journal read by admission and supervision", () => {
  const f = fixture();
  expect(journal.openFreezeJournal).toBeTypeOf("function");
  const durable = journal.openFreezeJournal(f.file);
  expect(unfinishedFreeze(f.root, "session-1")).toBe(false);
  expect(durable.beginFreeze("session-1", "move-1", 2)).toEqual({ sessionId: "session-1", moveId: "move-1", epoch: 2, state: "freezing" });
  expect(unfinishedFreeze(f.root, "session-1")).toBe(true);
  const reopened = journal.openFreezeJournal(f.file);
  expect(reopened.readFreeze("session-1", "move-1")).toEqual({ sessionId: "session-1", moveId: "move-1", epoch: 2, state: "freezing" });
  reopened.advanceFreeze("session-1", "move-1", 2, "frozen");
  expect(unfinishedFreeze(f.root, "session-1")).toBe(true);
  expect(reopened.readFreeze("session-1", "move-1")?.state).toBe("frozen");
}, 5000);

it("keeps cancellation durable and rejects a delayed freeze for the cancelled move", () => {
  const f = fixture();
  expect(journal.openFreezeJournal).toBeTypeOf("function");
  const durable = journal.openFreezeJournal(f.file);
  durable.beginFreeze("session-1", "move-1", 2);
  durable.advanceFreeze("session-1", "move-1", 2, "aborting");
  expect(unfinishedFreeze(f.root, "session-1")).toBe(true);
  durable.advanceFreeze("session-1", "move-1", 2, "aborted");
  expect(unfinishedFreeze(f.root, "session-1")).toBe(false);
  const reopened = journal.openFreezeJournal(f.file);
  expect(reopened.readFreeze("session-1", "move-1")?.state).toBe("aborted");
  expect(() => reopened.beginFreeze("session-1", "move-1", 2)).toThrow(/cancel|abort/i);
  expect(() => reopened.advanceFreeze("session-1", "move-1", 2, "frozen")).toThrow();
  expect(reopened.beginFreeze("session-1", "move-2", 2).state).toBe("freezing");
}, 5000);

it("refuses overlapping moves, stale epochs, and invalid progress transitions", () => {
  const f = fixture();
  expect(journal.openFreezeJournal).toBeTypeOf("function");
  const durable = journal.openFreezeJournal(f.file);
  durable.beginFreeze("session-1", "move-1", 3);
  expect(() => durable.beginFreeze("session-1", "move-2", 3)).toThrow();
  expect(() => durable.beginFreeze("session-1", "move-1", 2)).toThrow();
  expect(() => durable.advanceFreeze("session-1", "move-1", 3, "aborted")).toThrow();
  durable.advanceFreeze("session-1", "move-1", 3, "aborting");
  durable.advanceFreeze("session-1", "move-1", 3, "aborted");
  expect(() => durable.beginFreeze("session-1", "move-2", 2)).toThrow();
  expect(durable.readFreeze("session-1", "move-1")?.state).toBe("aborted");
}, 5000);
