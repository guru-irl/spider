import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeChildReporter } from "../child-reporter";
import { RunStore } from "../run-store";
import { freshDb } from "./helpers/testutil";
import { bus } from "@spider/db-core";
import { RunEventTailer } from "../event-tailer";
import { setupEscalationNotifier } from "../coordinators";
import { composeChildSystemPrompt } from "../pi-args";

describe("child escalation end-to-end", () => {
  const cleanups: Array<() => void> = [];
  
  beforeEach(() => {
    const listeners = (bus as any).listeners;
    if (listeners?.clear) {
      listeners.clear();
    }
  });
  
  afterEach(() => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch {}
    }
    cleanups.length = 0;
  });

  // THE CRITICAL E2E TEST - must fail before fix, pass after
  // Mutation: break escalation detection → must fail
  it("a child message with ESCALATION[blocked]: marker produces type='escalation' event and notifies orchestrator", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ 
      sessionId: "child-sess", 
      agent: "worker",
      task: "do something risky",
    });
    
    const sendMessage = vi.fn();
    const ctx = { db, pi: { sendMessage }, sessionId: "child-sess" };
    const tailer = new RunEventTailer(db);
    tailer.track(runId);
    
    // Create reporter and feed it realistic child text that follows the instruction
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onMessage("I need to analyze the logs first.\n\nESCALATION[blocked]: The task requires deleting production data without a backup. I cannot proceed safely without explicit approval.");
    
    // Verify: a run_events row with type='escalation' was created
    const events = db.prepare(`SELECT type, summary, payload FROM run_events WHERE run_id=? ORDER BY id`).all(runId) as any[];
    const escalationEvent = events.find((e) => e.type === "escalation");
    
    expect(escalationEvent, "Expected a type='escalation' event to be created").toBeTruthy();
    expect(escalationEvent.summary).toContain("deleting production data");
    
    const payload = JSON.parse(escalationEvent.payload);
    expect(payload.severity).toBe("blocked");
    
    // Set up notifier AFTER emission to test tailer path (appendRunEvent emits immediately,
    // so setting up before would count both the immediate emit and the tailer poll)
    const cleanup = setupEscalationNotifier(ctx, store);
    cleanups.push(cleanup, () => tailer.stop());
    
    // Poll the tailer to emit events to the bus
    tailer.poll();
    await new Promise((resolve) => setTimeout(resolve, 10));
    
    // Verify: the orchestrator was notified (once, via tailer)
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = sendMessage.mock.calls[0];
    expect(msg.customType).toBe("spider.escalation");
    expect(msg.content).toContain("blocked");
  });

  // Mutation: treat every message as escalation → must fail
  it("an ordinary child message (no marker) still produces type='message', NOT escalation", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ 
      sessionId: "child-sess", 
      agent: "worker",
    });
    
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onMessage("Analyzing the ui package now. I found three components to update.");
    
    const events = db.prepare(`SELECT type, summary FROM run_events WHERE run_id=? ORDER BY id`).all(runId) as any[];
    
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message");
    expect(events[0].summary).toContain("Analyzing the ui package");
    
    // No escalation event should exist
    const escalations = events.filter((e) => e.type === "escalation");
    expect(escalations).toHaveLength(0);
  });

  // Mutation: break severity parsing → must fail
  it("parses severity correctly for each supported value", () => {
    const db = freshDb();
    const store = new RunStore(db);
    
    const cases: Array<["blocked" | "question" | "warning", string]> = [
      ["blocked", "ESCALATION[blocked]: Cannot proceed without approval"],
      ["question", "ESCALATION[question]: Should I use approach A or B?"],
      ["warning", "ESCALATION[warning]: This will be slow on large repos"],
    ];
    
    for (const [expectedSeverity, text] of cases) {
      const { id: runId } = store.create({ sessionId: "s1", agent: "worker" });
      const rep = makeChildReporter(db, { runId, sessionId: "s1" });
      rep.onMessage(text);
      
      const event = db.prepare(`SELECT type, payload FROM run_events WHERE run_id=? AND type='escalation'`).get(runId) as any;
      expect(event, `Expected escalation event for severity=${expectedSeverity}`).toBeTruthy();
      
      const payload = JSON.parse(event.payload);
      expect(payload.severity).toBe(expectedSeverity);
    }
  });

  // Mutation: accept malformed markers → must fail
  it("a malformed or partial marker does NOT produce an escalation (no false positives)", () => {
    const db = freshDb();
    const store = new RunStore(db);
    
    const falsePositives = [
      "I need to handle the ESCALATION carefully",  // word in prose
      "ESCALATION without brackets",  // missing format
      "ESCALATION[]: empty severity",  // empty severity
      "ESCALATION[invalid]: unknown severity",  // unknown severity
      "  ESCALATION[blocked]: leading space",  // not at line start
    ];
    
    for (const text of falsePositives) {
      const { id: runId } = store.create({ sessionId: "s2", agent: "worker" });
      const rep = makeChildReporter(db, { runId, sessionId: "s2" });
      rep.onMessage(text);
      
      const events = db.prepare(`SELECT type FROM run_events WHERE run_id=?`).all(runId) as any[];
      const hasEscalation = events.some((e) => e.type === "escalation");
      expect(hasEscalation, `False positive: "${text}"`).toBe(false);
    }
  });

  // Mutation: delete the instruction from the prompt → must fail
  it("the composed child system prompt contains the ESCALATION marker instruction", () => {
    const prompt = composeChildSystemPrompt();
    
    // Must contain the exact marker format
    expect(prompt).toContain("ESCALATION[");
    expect(prompt).toContain("blocked");
    expect(prompt).toContain("question");
    expect(prompt).toContain("warning");
    
    // Must be unhedged (MUST)
    expect(prompt).toContain("MUST");
  });
});
