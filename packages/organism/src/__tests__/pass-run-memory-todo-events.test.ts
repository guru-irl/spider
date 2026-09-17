import { describe, it, expect } from "vitest";
import { runMemoryTodoPass } from "../passes/run-memory-todo.js";
import type { DigestBundle, DigestModel, TrackEventRow } from "../types.js";

const bundle: DigestBundle = {
  sessionId: "s1",
  reason: "shutdown",
  runs: [],
  runEvents: [],
  events: [],
  todos: [],
  transcript: [],
};

describe("runMemoryTodoPass — bounded tracked-event activity input", () => {
  it("surfaces tracked tool events even with no subagent runs at all", async () => {
    const seen: unknown[][] = [];
    const model: DigestModel = {
      complete: async (_s, m) => {
        seen.push(m);
        return "Nothing to save.";
      },
    };
    const events: TrackEventRow[] = [{ id: 1, ts: 3, phase: "after", tool: "edit", description: "patched auth.ts" }];
    await runMemoryTodoPass({ ...bundle, runs: [], runEvents: [], events }, model);
    expect(seen).toHaveLength(1); // currently short-circuits at the runs/runEvents gate — never calls the model
    const content = seen[0].map((m: any) => m.content).join("\n");
    expect(content).toContain("patched auth.ts");
  });

  it("still short-circuits (no model call) when runs, runEvents, and events are all empty", async () => {
    let called = false;
    const model: DigestModel = { complete: async () => { called = true; return "Nothing to save."; } };
    await runMemoryTodoPass(bundle, model);
    expect(called).toBe(false);
  });

  it("bounds tracked-event activity input instead of dumping every raw tool payload", async () => {
    let content = "";
    const model: DigestModel = {
      complete: async (_s, m: any[]) => {
        content = m.map((x) => x.content).join("\n");
        return "Nothing to save.";
      },
    };
    const events: TrackEventRow[] = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      ts: i,
      phase: "after" as const,
      tool: "edit",
      description: `edit #${i}`,
      // an oversized raw payload that must NOT be duplicated verbatim into the prompt
      payload: { diff: "x".repeat(5000) },
    }));
    await runMemoryTodoPass({ ...bundle, runs: [], runEvents: [], events }, model);
    expect(content.length).toBeLessThan(20000); // bounded, not a full unbounded payload dump
    expect(content).not.toContain("xxxxxxxxxx"); // raw payload text never duplicated in
  });
});
