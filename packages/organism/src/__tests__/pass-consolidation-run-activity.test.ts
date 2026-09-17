import { describe, it, expect } from "vitest";
import { consolidationPass } from "../passes/consolidation.js";
import type { DigestBundle, DigestModel, RunEventRow, TrackEventRow } from "../types.js";
import type { RunRow } from "@spider/subagents";

const runRow = {
  id: "r1",
  session_id: "s1",
  parent_run_id: null,
  agent: "worker",
  role: "implementer",
  name: null,
  status: "done",
  phase: null,
  model: null,
  task: null,
  thinking: null,
  started_at: null,
  ended_at: null,
  step_count: 4,
  token_count: 500,
  result: null,
  pid: null,
  host_pid: null,
} as RunRow;

const trackedEvent: TrackEventRow = { id: 1, ts: 3, phase: "after", tool: "edit", description: "patched auth.ts" };
const runEvent: RunEventRow = { id: 1, runId: "r1", ts: 2, type: "tool_result", tool: "bash", summary: "ran tests" };

const bundle: DigestBundle = {
  sessionId: "s1",
  reason: "shutdown",
  runs: [],
  runEvents: [],
  events: [],
  todos: [],
  transcript: [],
};

describe("consolidationPass — F2-secondary: run activity must reach the prompt", () => {
  it("sends a non-empty conversation to the model for a no-transcript, runs-only session", async () => {
    const seen: unknown[][] = [];
    const model: DigestModel = {
      complete: async (_system, messages) => {
        seen.push(messages);
        return JSON.stringify({ summary: "did stuff", selfName: "some-project" });
      },
    };
    await consolidationPass({ ...bundle, transcript: [], runs: [runRow] }, model);
    const captured = seen[0];
    expect(captured.length).toBeGreaterThan(0); // currently [] — model gets an empty conversation
  });

  it("includes concrete run activity (agent/status), not just a blank placeholder", async () => {
    let capturedText = "";
    const model: DigestModel = {
      complete: async (_system, messages) => {
        capturedText = messages.map((m) => m.content).join("\n");
        return JSON.stringify({ summary: "s", selfName: "n" });
      },
    };
    await consolidationPass({ ...bundle, transcript: [], runs: [runRow] }, model);
    expect(capturedText).toContain("worker");
    expect(capturedText).toContain("done");
  });

  it("folds in bounded tracked events and the session label when present", async () => {
    let capturedText = "";
    const model: DigestModel = {
      complete: async (_system, messages) => {
        capturedText = messages.map((m) => m.content).join("\n");
        return JSON.stringify({ summary: "s", selfName: "n" });
      },
    };
    await consolidationPass(
      { ...bundle, transcript: [], runs: [runRow], events: [trackedEvent], runEvents: [runEvent], sessionName: "auth-refactor" },
      model,
    );
    expect(capturedText).toContain("patched auth.ts");
    expect(capturedText).toContain("auth-refactor");
  });

  it("still short-circuits (no model call) when both transcript and runs are empty", async () => {
    let called = false;
    const model: DigestModel = { complete: async () => { called = true; return "{}"; } };
    const r = await consolidationPass({ ...bundle, transcript: [], runs: [] }, model);
    expect(called).toBe(false);
    expect(r).toEqual({ memory: [], todos: [], skills: [] });
  });

  it("prefers the real transcript verbatim when one is present (no behavior change on the happy path)", async () => {
    let captured: unknown;
    const model: DigestModel = {
      complete: async (_s, m) => {
        captured = m;
        return JSON.stringify({ summary: "s", selfName: "n" });
      },
    };
    const transcript = [{ role: "user" as const, content: "refactor auth" }];
    await consolidationPass({ ...bundle, transcript, runs: [runRow] }, model);
    expect(captured).toEqual(transcript);
  });
});
