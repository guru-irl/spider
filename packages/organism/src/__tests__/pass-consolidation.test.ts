import { describe, it, expect } from "vitest";
import { consolidationPass } from "../passes/consolidation.js";
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
    { role: "user", content: "refactor the auth module" },
    { role: "assistant", content: "done" },
  ],
};

describe("consolidationPass", () => {
  it("returns a summary and a self-name, no memory", async () => {
    const r = await consolidationPass(
      bundle,
      model({ summary: "Refactored the auth module.", selfName: "auth-refactor" }),
    );
    expect(r.summary).toBe("Refactored the auth module.");
    expect(r.selfName).toBe("auth-refactor");
    expect(r.memory).toEqual([]);
    expect(r.todos).toEqual([]);
    expect(r.skills).toEqual([]);
  });

  it("slugifies a messy self-name", async () => {
    const r = await consolidationPass(
      bundle,
      model({ summary: "Did stuff.", selfName: "  Auth Refactor!! v2  " }),
    );
    expect(r.selfName).toBe("auth-refactor-v2");
  });

  it("short-circuits on empty transcript and no runs", async () => {
    const emptyBundle: DigestBundle = { ...bundle, transcript: [], runs: [] };
    const r = await consolidationPass(emptyBundle, model({ summary: "x", selfName: "y" }));
    expect(r).toEqual({ memory: [], todos: [], skills: [] });
  });
});
