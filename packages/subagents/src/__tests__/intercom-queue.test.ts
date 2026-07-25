import { describe, it, expect, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths } from "@spider/db-core";
import { sendIntercom, SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../intercom";
import { makeMessageHandler } from "../actions/message";
import { MessageStore } from "../message-store";


let dbPath: string;
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

function freshGlobal() {
  dbPath = join(paths.scratch("global"), `g-${randomUUID()}.db`);
  return openDbAt(dbPath, "global");
}

function fakePiNoBroker() {
  // A pi double that does NOT auto-acknowledge delivery — simulates no broker present
  const handlers = new Map<string, Set<(p: any) => void>>();
  return {
    events: {
      on(event: string, fn: (p: any) => void) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
        return () => handlers.get(event)?.delete(fn);
      },
      emit(event: string, payload: any) {
        // Do NOT auto-ack — let the request timeout
        for (const fn of handlers.get(event) ?? []) fn(payload);
      },
    },
  };
}

function fakePiWithBroker() {
  // A pi double that DOES auto-acknowledge delivery
  const handlers = new Map<string, Set<(p: any) => void>>();
  return {
    events: {
      on(event: string, fn: (p: any) => void) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
        return () => handlers.get(event)?.delete(fn);
      },
      emit(event: string, payload: any) {
        if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
          // Auto-ack delivery
          for (const fn of handlers.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) {
            fn({ requestId: payload.requestId, delivered: true });
          }
        }
        for (const fn of handlers.get(event) ?? []) fn(payload);
      },
    },
  };
}

describe("Task 5: queue-first intercom durability", () => {
  describe("sendIntercom queue-first behavior", () => {
    it("enqueues the message EVEN WHEN the broker never acks (mutation: remove enqueue → MUST FAIL)", async () => {
      // This test catches: removing the enqueue call from sendIntercom
      const db = freshGlobal();
      const pi = fakePiNoBroker();
      const store = new MessageStore(db);

      // Before send, no messages
      expect(store.pending("target")).toHaveLength(0);

      // Send to a target with no broker responding
      await sendIntercom(pi, db, {
        to: "target",
        message: "important",
        fromSession: "sender",
        timeoutMs: 50,
      });

      // CRITICAL: message MUST be in the queue even though broker never acked
      const pending = store.pending("target");
      expect(pending).toHaveLength(1);
      expect(pending[0].body).toBe("important");
      expect(pending[0].toSession).toBe("target");
      expect(pending[0].deliveredAt).toBeNull(); // Not delivered by broker

      db.close();
    });

    it("marks a message as delivered in the DB when the broker acknowledges (assert the STORED row)", async () => {
      // This test catches: forgetting to call markDelivered on broker ack
      const db = freshGlobal();
      const pi = fakePiWithBroker();
      const store = new MessageStore(db);

      await sendIntercom(pi, db, {
        to: "target",
        message: "acked",
        fromSession: "sender",
        timeoutMs: 100,
      });

      // Message should be enqueued
      const all = db.prepare("SELECT * FROM message_mirror ORDER BY id DESC LIMIT 1").get() as any;
      expect(all.to_session).toBe("target");
      // CRITICAL: assert the STORED row's delivered_at is set (not just the return value)
      expect(all.delivered_at).not.toBeNull();

      // Also verify it doesn't appear in pending (delivered messages are excluded)
      expect(store.pending("target")).toHaveLength(0);

      db.close();
    });
  });

  describe("message action three-outcome result", () => {
    it("does NOT report isError for a queued-but-undelivered message (mutation: restore `isError: !delivered` → MUST FAIL)", async () => {
      // This test catches: returning isError: !res.delivered (the old buggy behavior)
      const db = freshGlobal();
      const pi = fakePiNoBroker();
      const handler = makeMessageHandler();
      const ctx: any = {
        pi,
        globalDb: db,
        sessionId: "sender",
      };

      const result: any = await handler(
        { to: "offline-peer", message: "queued message", timeoutMs: 50 },
        ctx
      );

      // CRITICAL: queued messages are NOT errors
      expect(result.isError).not.toBe(true);
      // Content should indicate queued/pending state
      expect(result.content).toMatch(/queued|pending|offline/i);

      db.close();
    });

    it("reports delivered (not error) when the broker acknowledges", async () => {
      const db = freshGlobal();
      const pi = fakePiWithBroker();
      const handler = makeMessageHandler();
      const ctx: any = {
        pi,
        globalDb: db,
        sessionId: "sender",
      };

      const result: any = await handler(
        { to: "online-peer", message: "live message", timeoutMs: 100 },
        ctx
      );

      expect(result.isError).not.toBe(true);
      expect(result.content).toMatch(/delivered/i);

      db.close();
    });
  });

  describe("poller drains pending messages", () => {
    it("delivers pending messages for the starting session and marks them delivered", async () => {
      // This test catches: forgetting to call the poller, or forgetting to mark delivered
      const db = freshGlobal();
      const store = new MessageStore(db);

      // Enqueue two messages for session "new-session"
      const id1 = store.enqueue({
        fromSession: "sender1",
        toSession: "new-session",
        body: "first",
      });
      const id2 = store.enqueue({
        fromSession: "sender2",
        toSession: "new-session",
        body: "second",
      });

      // Before poll, both are pending
      expect(store.pending("new-session")).toHaveLength(2);

      // Import and call the poller
      const { pollPendingMessages } = await import("../intercom");
      const pi = fakePiNoBroker(); // Broker presence doesn't matter for the poller
      await pollPendingMessages(db, "new-session", pi);

      // After poll, no pending messages for this session
      expect(store.pending("new-session")).toHaveLength(0);

      // Both messages should be marked delivered
      const row1 = db.prepare("SELECT delivered_at FROM message_mirror WHERE id = ?").get(id1) as any;
      const row2 = db.prepare("SELECT delivered_at FROM message_mirror WHERE id = ?").get(id2) as any;
      expect(row1.delivered_at).not.toBeNull();
      expect(row2.delivered_at).not.toBeNull();

      db.close();
    });

    it("LEAVES ALONE messages addressed to a DIFFERENT session (mutation: drop session filter → MUST FAIL)", async () => {
      // This test catches: polling all messages instead of just for the target session
      const db = freshGlobal();
      const store = new MessageStore(db);

      // Enqueue messages for two different sessions
      const idA = store.enqueue({
        fromSession: "sender",
        toSession: "session-a",
        body: "for A",
      });
      const idB = store.enqueue({
        fromSession: "sender",
        toSession: "session-b",
        body: "for B",
      });

      // Poll only for session-a
      const { pollPendingMessages } = await import("../intercom");
      const pi = fakePiNoBroker();
      await pollPendingMessages(db, "session-a", pi);

      // session-a's message should be delivered
      expect(store.pending("session-a")).toHaveLength(0);
      const rowA = db.prepare("SELECT delivered_at FROM message_mirror WHERE id = ?").get(idA) as any;
      expect(rowA.delivered_at).not.toBeNull();

      // CRITICAL: session-b's message should still be pending
      expect(store.pending("session-b")).toHaveLength(1);
      const rowB = db.prepare("SELECT delivered_at FROM message_mirror WHERE id = ?").get(idB) as any;
      expect(rowB.delivered_at).toBeNull();

      db.close();
    });
  });

  describe("boundary test: action handler contract", () => {
    it("makeMessageHandler returns a handler that accepts standard (args, ctx) and queues durably", async () => {
      // This test catches: handler not conforming to ActionHandler contract
      // A separate wiring test in packages/host verifies dispatch() registration
      const db = freshGlobal();
      const pi = fakePiNoBroker();

      // Get the handler (as dispatch() would)
      const handler = makeMessageHandler();

      const ctx: any = {
        db,
        globalDb: db,
        sessionId: "boundary-test",
        pi,
        project: { projectKey: "test", realPath: "/test", dbPath: "/test/db" },
        cwd: "/test",
        models: {} as any,
      };

      const args = { action: "message", to: "peer", message: "boundary test" };

      // Call the handler as dispatch() would
      const result: any = await handler(args, ctx);

      // Should succeed (queued, not error)
      expect(result.isError).not.toBe(true);

      // Verify message is in the queue
      const store = new MessageStore(db);
      const pending = store.pending("peer");
      expect(pending).toHaveLength(1);
      expect(pending[0].body).toBe("boundary test");

      db.close();
    });
  });

  describe("END-TO-END: durability without broker", () => {
    it("enqueues for session B with NO broker, runs B's poller, B receives it", async () => {
      // This is the whole point: durability must not depend on the broker
      const db = freshGlobal();
      const store = new MessageStore(db);
      const pi = fakePiNoBroker(); // NO broker present at all

      // Step 1: Session A sends to Session B (broker not present, will timeout)
      await sendIntercom(pi, db, {
        to: "session-b",
        message: "durable message",
        fromSession: "session-a",
        timeoutMs: 50,
      });

      // Step 2: Message should be queued (not lost)
      const pending = store.pending("session-b");
      expect(pending).toHaveLength(1);
      expect(pending[0].body).toBe("durable message");
      expect(pending[0].deliveredAt).toBeNull();

      // Step 3: Session B starts and runs its poller
      const { pollPendingMessages } = await import("../intercom");
      const delivered: any[] = [];
      const piB = {
        events: {
          on: vi.fn(),
          emit: vi.fn((event: string, payload: any) => {
            if (event === "spider.message_delivered") {
              delivered.push(payload);
            }
          }),
        },
      };
      await pollPendingMessages(db, "session-b", piB);

      // Step 4: Session B should have received the message
      expect(delivered).toHaveLength(1);
      expect(delivered[0].body).toBe("durable message");

      // Step 5: Message should be marked delivered in the DB
      const afterPoll = store.pending("session-b");
      expect(afterPoll).toHaveLength(0);
      const row = db.prepare("SELECT * FROM message_mirror ORDER BY id DESC LIMIT 1").get() as any;
      expect(row.delivered_at).not.toBeNull();

      db.close();
    });
  });
});
