import { describe, it, expect } from "vitest";
import { latestRunOutput } from "../completion-output";
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
