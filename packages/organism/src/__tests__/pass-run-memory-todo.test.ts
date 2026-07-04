import { describe, it, expect } from "vitest";
import { runMemoryTodoPass } from "../passes/run-memory-todo.js";
import type { DigestBundle, DigestModel } from "../types.js";

const bundle: DigestBundle = {
  sessionId: "s1", reason: "shutdown",
  runs: [{ id: "r1", sessionId: "s1", agent: "worker", status: "done", stepCount: 5, tokenCount: 99 } as any],
  runEvents: [{ id: 1, runId: "r1", ts: 1, type: "tool_result", tool: "bash", summary: "vitest needs --run in CI" }],
  events: [], todos: [], transcript: [],
};
const fakeModel = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });

describe("runMemoryTodoPass", () => {
  it("captures a durable tool-quirk + a follow-up todo", async () => {
    const r = await runMemoryTodoPass(bundle, fakeModel({
      memory: [{ category: "tool-quirk", content: "vitest needs --run in CI" }],
      todos: [{ text: "pin vitest --run in CI config" }], skills: [],
    }));
    expect(r.memory[0].content).toContain("vitest");
    expect(r.todos[0].text).toContain("vitest");
  });
  it("drops a negative-tool-claim via anti-poison guardrails", async () => {
    const r = await runMemoryTodoPass(bundle, fakeModel({
      memory: [{ category: "failure", content: "the bash tool does not work" }], todos: [], skills: [],
    }));
    expect(r.memory).toHaveLength(0);
  });
});
