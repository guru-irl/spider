// packages/subagents/src/__tests__/message-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDbAt } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { MessageStore } from "../message-store";

describe("MessageStore", () => {
  let db: Db;
  let store: MessageStore;
  const testDbPath = join(process.cwd(), ".spider/scratch/test-message-store.db");

  beforeEach(() => {
    // Clean up any previous test DB
    try {
      rmSync(testDbPath, { force: true });
    } catch {}
    mkdirSync(join(testDbPath, ".."), { recursive: true });
    
    // Open a global-scope DB
    db = openDbAt(testDbPath, "global");
    store = new MessageStore(db);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(testDbPath, { force: true });
      // Clean up WAL files
      rmSync(testDbPath + "-shm", { force: true });
      rmSync(testDbPath + "-wal", { force: true });
    } catch {}
  });

  it("enqueue → pending round-trip returns the row with the right fields", () => {
    // Mutation: would catch if enqueue didn't actually insert the row
    const id = store.enqueue({
      fromSession: "sess-a",
      toSession: "sess-b",
      kind: "test",
      body: "test message",
    });

    expect(id).toBeGreaterThan(0);

    const pending = store.pending("sess-b");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id,
      fromSession: "sess-a",
      toSession: "sess-b",
      kind: "test",
      body: "test message",
      deliveredAt: null,
      readAt: null,
    });
    expect(pending[0].createdAt).toBeGreaterThan(0);

    // Assert on what is actually STORED - read directly from DB
    const row = db.prepare("SELECT * FROM message_mirror WHERE id = ?").get(id) as any;
    expect(row).toBeDefined();
    expect(row.from_session).toBe("sess-a");
    expect(row.to_session).toBe("sess-b");
    expect(row.kind).toBe("test");
    expect(row.body).toBe("test message");
    expect(row.delivered_at).toBeNull();
    expect(row.read_at).toBeNull();
  });

  it("pending EXCLUDES delivered messages", () => {
    // Mutation: drop `AND delivered_at IS NULL` from pending → must fail
    const id1 = store.enqueue({ toSession: "sess-x", body: "msg1" });
    const id2 = store.enqueue({ toSession: "sess-x", body: "msg2" });

    // Mark first one delivered
    store.markDelivered(id1);

    const pending = store.pending("sess-x");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id2);

    // Verify by reading directly from DB
    const delivered = db.prepare("SELECT delivered_at FROM message_mirror WHERE id = ?").get(id1) as any;
    expect(delivered.delivered_at).not.toBeNull();
  });

  it("pending returns only messages for the requested session, not others", () => {
    // Mutation: drop the to_session filter → must fail
    store.enqueue({ toSession: "sess-a", body: "for-a" });
    store.enqueue({ toSession: "sess-b", body: "for-b" });
    store.enqueue({ toSession: "sess-c", body: "for-c" });

    const pendingA = store.pending("sess-a");
    expect(pendingA).toHaveLength(1);
    expect(pendingA[0].toSession).toBe("sess-a");

    const pendingB = store.pending("sess-b");
    expect(pendingB).toHaveLength(1);
    expect(pendingB[0].toSession).toBe("sess-b");
  });

  it("markDelivered returns true first time and false second time, timestamp unchanged on second call", () => {
    // Mutation: remove the `AND delivered_at IS NULL` guard → must fail
    const id = store.enqueue({ toSession: "sess-y", body: "test" });

    const firstMark = store.markDelivered(id);
    expect(firstMark).toBe(true);

    // Read the timestamp directly from DB
    const row1 = db.prepare("SELECT delivered_at FROM message_mirror WHERE id = ?").get(id) as any;
    expect(row1.delivered_at).not.toBeNull();
    const firstTimestamp = row1.delivered_at;

    // Wait a bit to ensure timestamp would differ if updated
    const wait = Date.now();
    while (Date.now() - wait < 5) {}

    const secondMark = store.markDelivered(id, Date.now());
    expect(secondMark).toBe(false);

    // Verify timestamp unchanged
    const row2 = db.prepare("SELECT delivered_at FROM message_mirror WHERE id = ?").get(id) as any;
    expect(row2.delivered_at).toBe(firstTimestamp);
  });

  it("markRead returns true first time and false second time, timestamp unchanged on second call", () => {
    // Mutation: remove the `AND read_at IS NULL` guard → must fail
    const id = store.enqueue({ toSession: "sess-z", body: "test" });

    const firstMark = store.markRead(id);
    expect(firstMark).toBe(true);

    // Read the timestamp directly from DB
    const row1 = db.prepare("SELECT read_at FROM message_mirror WHERE id = ?").get(id) as any;
    expect(row1.read_at).not.toBeNull();
    const firstTimestamp = row1.read_at;

    // Wait a bit
    const wait = Date.now();
    while (Date.now() - wait < 5) {}

    const secondMark = store.markRead(id, Date.now());
    expect(secondMark).toBe(false);

    // Verify timestamp unchanged
    const row2 = db.prepare("SELECT read_at FROM message_mirror WHERE id = ?").get(id) as any;
    expect(row2.read_at).toBe(firstTimestamp);
  });

  it("ordering is oldest-first", () => {
    // Mutation: flip the ORDER BY → must fail
    const wait = Date.now();
    while (Date.now() - wait < 2) {}
    const id1 = store.enqueue({ toSession: "sess-order", body: "first" });
    
    while (Date.now() - wait < 4) {}
    const id2 = store.enqueue({ toSession: "sess-order", body: "second" });
    
    while (Date.now() - wait < 6) {}
    const id3 = store.enqueue({ toSession: "sess-order", body: "third" });

    const pending = store.pending("sess-order");
    expect(pending).toHaveLength(3);
    expect(pending[0].id).toBe(id1);
    expect(pending[1].id).toBe(id2);
    expect(pending[2].id).toBe(id3);

    // Verify by checking created_at ordering in DB
    const rows = db.prepare(
      "SELECT id, created_at FROM message_mirror WHERE to_session = ? ORDER BY created_at"
    ).all("sess-order") as any[];
    expect(rows[0].id).toBe(id1);
    expect(rows[1].id).toBe(id2);
    expect(rows[2].id).toBe(id3);
    expect(rows[0].created_at).toBeLessThan(rows[1].created_at);
    expect(rows[1].created_at).toBeLessThan(rows[2].created_at);
  });

  it("pending respects limit parameter", () => {
    store.enqueue({ toSession: "sess-limit", body: "1" });
    store.enqueue({ toSession: "sess-limit", body: "2" });
    store.enqueue({ toSession: "sess-limit", body: "3" });

    const pending = store.pending("sess-limit", 2);
    expect(pending).toHaveLength(2);
  });
});
