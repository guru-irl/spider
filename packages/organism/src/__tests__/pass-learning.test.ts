import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    { role: "user", content: "Please stop being so verbose in your answers to my questions." },
    { role: "assistant", content: "ok" },
  ],
};

describe("learningPass (co-equal capture)", () => {
  beforeEach(() => vi.stubEnv("PI_SUBAGENT_CHILD", ""));
  afterEach(() => vi.unstubAllEnvs());
  it("emits BOTH a staged memory AND a staged skill from one turn", async () => {
    const r = await learningPass(
      bundle,
      model({
        memory: [{ category: "preference", content: "user prefers terse answers", scope: "repo", justification: "Durable project preference useful to future agents.", evidence: 'User: "Please stop being so verbose in your answers to my questions."' }],
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
      model({ memory: [{ category: "failure", content: "browser tools do not work", scope: "repo", justification: "A project tool constraint affecting future sessions.", evidence: "src/tools.ts:12" }], todos: [], skills: [] }),
    );
    expect(r.memory).toHaveLength(0);
  });
});
