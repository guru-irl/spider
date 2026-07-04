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
      model({ memory: [{ category: "convention", content: "run npm test before every commit" }], todos: [], skills: [] }),
    );
    expect(r.memory[0].category).toBe("convention");
    expect(r.todos).toHaveLength(0);
    expect(r.skills).toHaveLength(0);
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
