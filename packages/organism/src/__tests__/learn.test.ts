import { describe, it, expect } from "vitest";
import { buildLearnPrompt, AUTHORING_STANDARDS } from "../learn.js";

describe("buildLearnPrompt", () => {
  it("embeds the authoring standards and the request", () => {
    const p = buildLearnPrompt("turn our release steps into a skill");
    expect(p).toContain("turn our release steps into a skill");
    expect(p).toContain(AUTHORING_STANDARDS.slice(0, 40));
    expect(p).toMatch(/<=?\s*60/); // the ≤60-char description rule survives the port
  });
  it("empty request falls back to 'the workflow we just went through'", () => {
    expect(buildLearnPrompt("")).toContain("workflow we just went through");
  });
  it("frames tools as spider verbs, not Hermes tool names", () => {
    const p = buildLearnPrompt("x");
    expect(p).not.toContain("read_file");
    expect(p).toContain("spider skill");
  });
});
