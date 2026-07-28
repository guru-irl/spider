import { describe, it, expect } from "vitest";
import { qualifyModelProvider, resolveRoleModel } from "../model-resolve";

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

// Precedence for a spawned subagent's model: explicit `model:` on the call -> the
// configured default for the agent's role (models.defaults[<role>]) -> inherit the
// parent session's model (last resort, so nothing regresses when no default is set).
// Before this, run.ts did `m ?? parentModel` with no role lookup at all — models.defaults
// was written by `control models set` and displayed by `control models`, but nothing ever
// read it back at spawn time.
describe("resolveRoleModel", () => {
  it("uses the role's configured default when no explicit model is given", () => {
    expect(resolveRoleModel(undefined, "reviewer", { reviewer: "github-copilot/claude-opus-5" }, "github-copilot/claude-opus-4.8"))
      .toBe("github-copilot/claude-opus-5");
  });

  it("prefers an explicit model over the configured role default", () => {
    expect(resolveRoleModel("explicit/model", "reviewer", { reviewer: "github-copilot/claude-opus-5" }, "github-copilot/claude-opus-4.8"))
      .toBe("explicit/model");
  });

  it("falls back to the parent model when no default is configured for the role (no regression)", () => {
    expect(resolveRoleModel(undefined, "worker", {}, "parent-model")).toBe("parent-model");
    expect(resolveRoleModel(undefined, "worker", undefined, "parent-model")).toBe("parent-model");
  });

  it("falls back to the parent model when no role is given at all", () => {
    expect(resolveRoleModel(undefined, undefined, { worker: "github-copilot/claude-sonnet-5" }, "parent-model")).toBe("parent-model");
  });

  it("is undefined end-to-end when nothing is configured anywhere", () => {
    expect(resolveRoleModel(undefined, "worker", undefined, undefined)).toBeUndefined();
  });
});
