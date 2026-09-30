import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { learningPass, COMBINED_REVIEW_PROMPT } from "../passes/learning.js";
import type { DigestBundle, DigestModel } from "../types.js";

const bundle: DigestBundle = {
  sessionId: "s1",
  reason: "shutdown",
  runs: [],
  runEvents: [],
  events: [],
  todos: [],
  transcript: [
    { role: "user", content: "Please stop being so verbose in your answers to my questions." },
    { role: "assistant", content: "understood" },
  ],
};

describe("learningPass — F4 JSON output contract", () => {
  beforeEach(() => vi.stubEnv("PI_SUBAGENT_CHILD", ""));
  afterEach(() => vi.unstubAllEnvs());
  it("COMBINED_REVIEW_PROMPT explicitly states the candidate JSON output contract", () => {
    expect(COMBINED_REVIEW_PROMPT).toMatch(/JSON/);
    expect(COMBINED_REVIEW_PROMPT).toMatch(/"memory"/);
    expect(COMBINED_REVIEW_PROMPT).toMatch(/"skills"/);
    expect(COMBINED_REVIEW_PROMPT).toMatch(/"todos"/);
    // it must not still be telling a plain-text completion to call tools
    expect(COMBINED_REVIEW_PROMPT).not.toMatch(/memory tool/i);
    expect(COMBINED_REVIEW_PROMPT).not.toMatch(/write_file/i);
  });

  it("survives a prose-wrapped, unlabelled-fence reply (realistic model shape)", async () => {
    const reply =
      "I found one durable preference and one skill worth adding.\n\n```\n" +
      JSON.stringify({
        memory: [{ category: "preference", content: "user prefers terse answers", scope: "repo", justification: "Durable project preference useful to future agents.", evidence: 'User: "Please stop being so verbose in your answers to my questions."' }],
        skills: [{ name: "answer-style", body: "# Answer style\nBe terse." }],
        todos: [],
      }) +
      "\n```";
    const model: DigestModel = { complete: async () => reply };
    const r = await learningPass(bundle, model);
    expect(r.skills).toHaveLength(1);
    expect(r.memory).toHaveLength(1);
  });

  it("a wholly malformed (non-JSON, non-'Nothing to save.') reply throws rather than silently succeeding", async () => {
    const model: DigestModel = { complete: async () => "I'm not going to help with that." };
    await expect(learningPass(bundle, model)).rejects.toThrow();
  });

  it("does not auto-approve or fabricate tool calls — only returns candidates for staged review", async () => {
    const model: DigestModel = {
      complete: async () =>
        JSON.stringify({
          memory: [{ category: "preference", content: "x", scope: "repo", justification: "Durable project preference useful to future agents.", evidence: 'User: "Please stop being so verbose in your answers to my questions."' }],
          skills: [{ name: "answer-style", body: "y" }],
          todos: [],
        }),
    };
    const r = await learningPass(bundle, model);
    // The pass returns plain candidate data only — no approval/activation flag exists on the type.
    expect(r.memory[0]).not.toHaveProperty("approved");
    expect(r.skills[0]).not.toHaveProperty("approved");
  });
});
