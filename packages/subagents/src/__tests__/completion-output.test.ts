import { describe, it, expect } from "vitest";
import { latestRunOutput, genuineCompletion, NO_DELIVERABLE_RESULT } from "../completion-output";
import { appendRunEvent } from "@spider/db-core";
import { freshDb } from "./helpers/testutil";

describe("latestRunOutput", () => {
  it("returns the newest assistant message summary for a run", () => {
    const db = freshDb();
    const ctx = { runId: "r1", sessionId: "s" };
    appendRunEvent(db, { ...ctx, ts: 1, type: "message", summary: "first pass notes" });
    appendRunEvent(db, { ...ctx, ts: 2, type: "tool_intent", tool: "read", summary: "read x" });
    appendRunEvent(db, { ...ctx, ts: 3, type: "message", summary: "FINAL: 3 TODOs found" });
    expect(latestRunOutput(db, "r1")).toBe("FINAL: 3 TODOs found");
  });
  it("falls back to the provided result when no message events exist", () => {
    const db = freshDb();
    expect(latestRunOutput(db, "missing", "fallback text")).toBe("fallback text");
    expect(latestRunOutput(db, "missing")).toBe("");
  });
  it("breaks ts ties by id (newest inserted wins)", () => {
    const db = freshDb();
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 5, type: "message", summary: "older same-ts" });
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 5, type: "message", summary: "newer same-ts" });
    expect(latestRunOutput(db, "r1")).toBe("newer same-ts");
  });
});

// C1's root cause: the production spawner never returns a `result`, and the child never
// self-finalizes with one either — the real deliverable lives ONLY in `run_events`. This
// is the single helper both the child-first (child-reporter.onShutdown) and parent-first
// (runner.decideOutcome) finalization paths defer to.
describe("genuineCompletion", () => {
  it("a real final message IS the deliverable", () => {
    const db = freshDb();
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "message", summary: "FINAL: 3 TODOs found" });
    expect(genuineCompletion(db, "r1")).toEqual({ done: true, result: "FINAL: 3 TODOs found" });
  });

  it("no message/escalation events at all → not done (nothing was ever delivered)", () => {
    const db = freshDb();
    expect(genuineCompletion(db, "missing")).toEqual({ done: false, result: "" });
  });

  it("an unresolved BLOCKED escalation with no later message → not done, regardless of clean exit", () => {
    const db = freshDb();
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "message", summary: "progress note" });
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 2, type: "escalation", summary: "need approval", payload: { severity: "blocked" } });
    expect(genuineCompletion(db, "r1").done).toBe(false);
  });

  it("an unresolved QUESTION escalation with no later message → not done", () => {
    const db = freshDb();
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "escalation", summary: "which target?", payload: { severity: "question" } });
    expect(genuineCompletion(db, "r1").done).toBe(false);
  });

  it("a WARNING escalation never blocks completion — the real message right before it still counts", () => {
    const db = freshDb();
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "message", summary: "FINAL: shipped" });
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 2, type: "escalation", summary: "minor nit", payload: { severity: "warning" } });
    expect(genuineCompletion(db, "r1")).toEqual({ done: true, result: "FINAL: shipped" });
  });

  it("a BLOCKED escalation followed by a genuine later message is resolved by that message", () => {
    const db = freshDb();
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "escalation", summary: "stuck", payload: { severity: "blocked" } });
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 2, type: "message", summary: "actually finished it" });
    expect(genuineCompletion(db, "r1")).toEqual({ done: true, result: "actually finished it" });
  });

  it("NO_DELIVERABLE_RESULT carries no incident-specific wording", () => {
    expect(NO_DELIVERABLE_RESULT).not.toMatch(/c99fadd0|run [0-9a-f]{8}/i);
    expect(NO_DELIVERABLE_RESULT).toMatch(/no result/i);
  });
});
