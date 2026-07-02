// packages/models/src/__tests__/pick.test.ts
import { describe, it, expect } from "vitest";
import { pick, catalog } from "../index.js";
const entries = catalog(() => [
  { provider: "github-copilot", id: "gpt-5.4-nano", available: true },
  { provider: "github-copilot", id: "claude-sonnet-4.5", available: true },
  { provider: "github-copilot", id: "claude-opus-4.8", available: true },
  { provider: "github-copilot", id: "gpt-5.3-codex", available: false, reasoning: true },
]);
describe("pick", () => {
  it("explicit model override wins when available", () => {
    expect(pick(entries, { model: "github-copilot/claude-opus-4.8" }).id).toBe("claude-opus-4.8");
  });
  it("config default applies for a role", () => {
    const got = pick(entries, { role: "reviewer" }, { defaults: { reviewer: "github-copilot/claude-opus-4.8" } });
    expect(got.id).toBe("claude-opus-4.8");
  });
  it("cheap budget picks the fastest available tier", () => {
    expect(pick(entries, { budget: "cheap" }).tier).toBe("nano");
  });
  it("degrades a tier when the target is unavailable", () => {
    // wants reasoning but codex is unavailable → falls to the best available (capable)
    expect(pick(entries, { needsReasoning: true }).available).toBe(true);
  });
});
