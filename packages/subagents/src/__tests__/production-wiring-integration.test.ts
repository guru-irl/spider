/**
 * Integration tests for C4/C5/I1 production wiring fixes.
 * These tests MUST enter through the real production path, never calling
 * components directly (that would test the component, not the wiring).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeRunHandler } from "../actions/run";
import { MessageStore } from "../message-store";
import { RunStore } from "../run-store";
import { freshDb } from "./helpers/testutil";
import { bus, setGlobalDbPathForTests } from "@spider/db-core";
import { cleanupScratch, scratchDbPath } from "@spider/db-core/testutil";
import { teardownCoordinators } from "../coordinators";

describe("Production Wiring Integration Tests", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    setGlobalDbPathForTests(scratchDbPath("production-wiring-global"));
  });

  afterEach(() => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch {}
    }
    cleanups.length = 0;
    setGlobalDbPathForTests(null);
    cleanupScratch();
  });

  describe("C4: Escalation notifier reaches orchestrator through production", () => {
    it("escalations from child runs notify the orchestrator via production wiring", async () => {
      const db = freshDb();
      const sessionId = "test-escalation-sess";
      const sendMessage = vi.fn();
      
      const ctx = {
        db,
        pi: { sendMessage },
        sessionId,
        cwd: process.cwd(),
        project: { projectKey: process.cwd(), dbPath: ":memory:" },
        models: { catalog: () => [], pick: () => null },
      };

      // Enter through REAL production: makeRunHandler creates the coordinator
      const runHandler = makeRunHandler();
      
      // Trigger a run (which sets up the notifier through production)
      await runHandler({ agent: "worker", task: "test", async: true }, ctx);
      
      // Now inject an escalation event into the bus (simulating a child escalation)
      const store = new RunStore(db);
      const runs = db.prepare("SELECT id FROM runs WHERE session_id=?").all(sessionId) as any[];
      expect(runs.length).toBeGreaterThan(0);
      const runId = runs[0].id;
      
      // Emit escalation via bus (as the child reporter does)
      bus.emit({
        type: "escalation",
        runId,
        summary: "Test escalation",
        payload: { severity: "blocked" },
      } as any);

      // Give the notifier time to process
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify orchestrator was notified through production wiring
      expect(sendMessage).toHaveBeenCalled();
      const call = sendMessage.mock.calls.find(c => c[0]?.customType === "spider.escalation");
      expect(call, "Expected spider.escalation message through production wiring").toBeTruthy();
      if (call) {
        expect(call[0].content).toContain("blocked");
        expect(call[1]).toEqual({ triggerTurn: true });
      }

      cleanups.push(() => teardownCoordinators(sessionId));
    });
  });

  describe("C5: Polled messages actually delivered", () => {
    it("pollPendingMessages delivers via sendMessage, not dead event emit", async () => {
      const { openGlobal } = await import("@spider/db-core");
      const { pollPendingMessages } = await import("../intercom");
      
      const globalDb = openGlobal();
      const sessionId = "test-poll-sess";
      const sendMessage = vi.fn();
      const pi = { sendMessage };

      try {
        // Queue a message
        const store = new MessageStore(globalDb);
        const msgId = store.enqueue({
          fromSession: "other-sess",
          toSession: sessionId,
          kind: "test-msg",
          body: "hello via polling",
        });

        // Poll through production
        await pollPendingMessages(globalDb, sessionId, pi);

        // Verify delivery via sendMessage (user-visible)
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            customType: "spider.message_delivered",
            content: expect.stringContaining("hello via polling"),
          }),
          expect.objectContaining({ triggerTurn: true })
        );

        // Verify marked delivered
        const msg = globalDb.prepare("SELECT * FROM message_mirror WHERE id = ?").get(msgId) as any;
        expect(msg?.delivered_at).toBeTruthy();
      } finally {
        globalDb.close();
      }
    });

    it("failed delivery leaves message pending for retry", async () => {
      const { openGlobal } = await import("@spider/db-core");
      const { pollPendingMessages } = await import("../intercom");
      
      const globalDb = openGlobal();
      const sessionId = "test-retry-sess";
      const sendMessage = vi.fn(() => {
        throw new Error("Delivery failed");
      });
      const pi = { sendMessage };

      try {
        const store = new MessageStore(globalDb);
        const msgId = store.enqueue({
          fromSession: "other-sess",
          toSession: sessionId,
          kind: "retry",
          body: "should remain pending",
        });

        // Poll (will fail to deliver)
        await pollPendingMessages(globalDb, sessionId, pi).catch(() => {});

        // Verify NOT marked delivered (remains pending)
        const msg = globalDb.prepare("SELECT * FROM message_mirror WHERE id = ?").get(msgId) as any;
        expect(msg?.delivered_at).toBeNull();
      } finally {
        globalDb.close();
      }
    });
  });

});
