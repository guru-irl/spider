import { describe, it, expect } from "vitest";
import { learningPass } from "../passes/learning.js";
import type { DigestBundle, DigestModel } from "../types.js";

const model = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });
const bundle: DigestBundle = {
  sessionId: "s1",
  reason: "shutdown",
  runs: [],
  runEvents: [],
  events: [],
  todos: [],
  transcript: [
    { role: "user", content: "stop being so verbose" },
    { role: "assistant", content: "ok" },
  ],
};

describe("learningPass (co-equal capture)", () => {
  it("emits BOTH a staged memory AND a staged skill from one turn", async () => {
    const r = await learningPass(
      bundle,
      model({
        memory: [{ category: "preference", content: "user prefers terse answers" }],
        todos: [],
        skills: [{ name: "answer-style", category: "communication", body: "# Answer style\nBe terse." }],
      }),
    );
    expect(r.memory).toHaveLength(1);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe("answer-style");
  });

  it("rejects a session-artifact skill name (not class-level)", async () => {
    const r = await learningPass(
      bundle,
      model({ memory: [], todos: [], skills: [{ name: "fix-pr-1234-today", body: "..." }] }),
    );
    expect(r.skills).toHaveLength(0);
  });

  it("guardrails still drop negative memory even in combined pass", async () => {
    const r = await learningPass(
      bundle,
      model({ memory: [{ category: "failure", content: "browser tools do not work" }], todos: [], skills: [] }),
    );
    expect(r.memory).toHaveLength(0);
  });
});
