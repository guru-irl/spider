import { describe, it, expect } from "vitest";
import { parseCandidates } from "../aux-model.js";

describe("parseCandidates", () => {
  it("parses a fenced json block into candidates", () => {
    const raw = "sure:\n```json\n" + JSON.stringify({
      memory: [{ category: "convention", content: "uses conventional commits" }],
      todos: [{ text: "add CI" }],
      skills: [{ name: "release-flow", body: "# Release\n..." }],
      summary: "refactored auth", selfName: "auth-refactor",
    }) + "\n```";
    const r = parseCandidates(raw);
    expect(r.memory[0].content).toBe("uses conventional commits");
    expect(r.todos[0].text).toBe("add CI");
    expect(r.skills[0].name).toBe("release-flow");
    expect(r.summary).toBe("refactored auth");
    expect(r.selfName).toBe("auth-refactor");
  });
  it("returns empty on 'Nothing to save.'", () => {
    const r = parseCandidates("Nothing to save.");
    expect(r.memory).toEqual([]); expect(r.skills).toEqual([]);
  });
  it("drops malformed entries without throwing", () => {
    const r = parseCandidates(JSON.stringify({ memory: [{ nope: 1 }, { category: "preference", content: "dark" }], skills: [{ body: "no name" }] }));
    expect(r.memory).toHaveLength(1);
    expect(r.memory[0].content).toBe("dark");
    expect(r.skills).toHaveLength(0);
  });
});
