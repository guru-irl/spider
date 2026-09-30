import { describe, it, expect } from "vitest";
import { todoMemoryPass } from "../passes/todo-memory.js";
import type { DigestBundle, DigestModel } from "../types.js";

const model = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });

describe("todoMemoryPass", () => {
  it("distills completed todos into a convention", async () => {
    const bundle: DigestBundle = {
      sessionId: "s1",
      reason: "shutdown",
      runs: [],
      runEvents: [],
      events: [],
      todos: [{ seq: 1, text: "run npm test before commit", done: true }],
      transcript: [],
    };
    const r = await todoMemoryPass(
      bundle,
      model({ memory: [{ category: "convention", content: "run npm test before every commit", scope: "repo", justification: "Standing repository check for future commits", evidence: "src/ci.ts:4" }], todos: [], skills: [] }),
    );
    expect(r.memory[0].category).toBe("convention");
    expect(r.todos).toHaveLength(0);
    expect(r.skills).toHaveLength(0);
  });

  it("caps supported todo memories after metadata and guardrail rejection", async () => {
    const bundle: DigestBundle = { sessionId: "s1", reason: "shutdown", runs: [], runEvents: [], events: [],
      todos: [{ seq: 1, text: "Review project checks", done: true }], transcript: [] };
    const valid = { category: "convention", content: "Run project checks before review", scope: "repo",
      justification: "Standing repo process for future changes", evidence: "src/checks.ts:4" };
    const r = await todoMemoryPass(bundle, model({ memory: [
      { ...valid, content: "Missing scope", scope: "" },
      { ...valid, category: "failure", content: "browser tools do not work" },
      valid,
      { ...valid, content: "Use a review checklist for each change" },
    ], todos: [], skills: [] }), 1);
    expect(r.memory.map(m => m.content)).toEqual([valid.content]);
    expect(r.capDropped).toBe(1);
  });

  it("no completed todos → no model call, empty result", async () => {
    const bundle: DigestBundle = {
      sessionId: "s1",
      reason: "shutdown",
      runs: [],
      runEvents: [],
      events: [],
      todos: [{ seq: 1, text: "open todo", done: false }],
      transcript: [],
    };
    let called = false;
    const r = await todoMemoryPass(bundle, {
      complete: async () => {
        called = true;
        return "{}";
      },
    });
    expect(called).toBe(false);
    expect(r.memory).toHaveLength(0);
  });
});
