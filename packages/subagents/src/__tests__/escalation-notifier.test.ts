import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bus } from "@spider/db-core";
import { freshDb } from "./helpers/testutil";
import { emitEscalation } from "../run-events";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { setupEscalationNotifier } from "../coordinators";

describe("escalation notifier", () => {
  const cleanups: Array<() => void> = [];
  
  beforeEach(() => {
    // Clear all bus listeners before each test to ensure isolation
    const listeners = (bus as any).listeners;
    if (listeners?.clear) {
      listeners.clear();
    }
  });
  
  afterEach(() => {
    // Clean up all listeners and tailers
    for (const cleanup of cleanups) {
      try { cleanup(); } catch {}
    }
    cleanups.length = 0;
  });

  // Mutation: remove the `type === "escalation"` recognition → must fail
  it("an escalation row causes a notification", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const runId = store.create({
      sessionId: "s1",
      agent: "worker",
      task: "blocked task",
    }).id;

    const sendMessage = vi.fn();
    const ctx = { db, pi: { sendMessage }, sessionId: "s1" };
    
    // Set up the real tailer
    const tailer = new RunEventTailer(db);
    tailer.track(runId);

    // Emit an escalation (this writes to run_events AND emits on bus immediately)
    emitEscalation(db, {
      runId,
      sessionId: "s1",
      severity: "blocked",
      summary: "Need approval for destructive operation",
    });

    // Set up notifier AFTER emission to avoid counting the immediate bus.emit() 
    // from appendRunEvent — we want to test the tailer path specifically
    const cleanup = setupEscalationNotifier(ctx, store);
    cleanups.push(cleanup, () => tailer.stop());

    // Manually poll once to emit the event via the tailer
    tailer.poll();
    
    // Small delay for async notification handling
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = sendMessage.mock.calls[0];
    expect(msg.customType).toBe("spider.escalation");
    expect(msg.content).toContain("blocked");
    expect(msg.content).toContain("Need approval for destructive operation");
  });

  // Mutation: notify on every type → must fail
  it("a non-escalation row does NOT notify", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const runId = store.create({
      sessionId: "s2",
      agent: "worker",
      task: "normal task",
    }).id;

    const sendMessage = vi.fn();
    const ctx = { db, pi: { sendMessage }, sessionId: "s2" };
    
    const tailer = new RunEventTailer(db);
    tailer.track(runId);

    // Emit a tool_result (not an escalation)
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, "s2", Date.now(), "tool_result", "Completed");

    // Set up notifier after emission
    const cleanup = setupEscalationNotifier(ctx, store);
    cleanups.push(cleanup, () => tailer.stop());

    tailer.poll();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  // Mutation: drop the cancelled check → must fail
  it("an escalation on a CANCELLED run does NOT notify", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const runId = store.create({
      sessionId: "s3",
      agent: "worker",
      task: "task to be cancelled",
    }).id;

    // Mark the run as cancelled
    store.cancel(runId, "user killed it");

    const sendMessage = vi.fn();
    const ctx = { db, pi: { sendMessage }, sessionId: "s3" };
    
    const tailer = new RunEventTailer(db);
    tailer.track(runId);

    // Emit an escalation after cancellation
    emitEscalation(db, {
      runId,
      sessionId: "s3",
      severity: "blocked",
      summary: "Late escalation from cancelled run",
    });

    // Set up notifier after emission
    const cleanup = setupEscalationNotifier(ctx, store);
    cleanups.push(cleanup, () => tailer.stop());

    tailer.poll();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
