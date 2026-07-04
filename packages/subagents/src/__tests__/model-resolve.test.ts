import { describe, it, expect } from "vitest";
import { qualifyModelProvider } from "../model-resolve";

const list = [
  { provider: "anthropic", id: "claude-sonnet-5", available: false },
  { provider: "github-copilot", id: "claude-sonnet-5", available: true },
  { provider: "github-copilot", id: "claude-opus-4.8", available: true },
];

describe("qualifyModelProvider", () => {
  it("qualifies a bare model id with the available provider", () => {
    expect(qualifyModelProvider("claude-sonnet-5", list)).toBe("github-copilot/claude-sonnet-5");
    expect(qualifyModelProvider("claude-opus-4.8", list)).toBe("github-copilot/claude-opus-4.8");
  });
  it("leaves an already provider-qualified ref untouched", () => {
    expect(qualifyModelProvider("github-copilot/claude-sonnet-5", list)).toBe("github-copilot/claude-sonnet-5");
    expect(qualifyModelProvider("anthropic/claude-sonnet-5", list)).toBe("anthropic/claude-sonnet-5");
  });
  it("prefers an available provider over an unavailable one", () => {
    expect(qualifyModelProvider("claude-sonnet-5", [
      { provider: "anthropic", id: "claude-sonnet-5", available: false },
      { provider: "github-copilot", id: "claude-sonnet-5", available: true },
    ])).toBe("github-copilot/claude-sonnet-5");
  });
  it("returns the bare id unchanged when no provider matches", () => {
    expect(qualifyModelProvider("mystery-model", list)).toBe("mystery-model");
  });
  it("passes through undefined / empty", () => {
    expect(qualifyModelProvider(undefined, list)).toBeUndefined();
    expect(qualifyModelProvider("", list)).toBe("");
  });
  it("accepts a list whose ids are already provider-qualified", () => {
    expect(qualifyModelProvider("claude-sonnet-5", [{ id: "github-copilot/claude-sonnet-5", available: true }]))
      .toBe("github-copilot/claude-sonnet-5");
  });
  it("supports providerId as the provider field and degrades on a throwing/empty list", () => {
    expect(qualifyModelProvider("claude-sonnet-5", [{ providerId: "github-copilot", id: "claude-sonnet-5" }]))
      .toBe("github-copilot/claude-sonnet-5");
    expect(qualifyModelProvider("claude-sonnet-5", [])).toBe("claude-sonnet-5");
  });
});
