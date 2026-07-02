import { describe, it, expect } from "vitest";
import { pick, catalog } from "../index.js";

const entries = catalog(() => [
  { provider: "github-copilot", id: "mai-code-1-flash-picker", available: true },
  { provider: "github-copilot", id: "claude-haiku-4.5", available: true, vision: true },
  { provider: "github-copilot", id: "claude-sonnet-5", available: true, vision: true },
  { provider: "github-copilot", id: "claude-sonnet-4.6", available: true, vision: true },
  { provider: "github-copilot", id: "claude-opus-4.8", available: true, vision: true },
]);

describe("pick (A8: tier + thinking levers)", () => {
  it("explicit model wins", () => {
    expect(pick(entries, { model: "github-copilot/claude-opus-4.8" }).entry.id).toBe("claude-opus-4.8");
  });
  it("role default applies", () => {
    const r = pick(entries, { role: "reviewer" }, { defaults: { reviewer: "github-copilot/claude-sonnet-5" } });
    expect(r.entry.id).toBe("claude-sonnet-5");
  });
  it("standard tier prefers sonnet-5 first, at medium thinking", () => {
    const r = pick(entries, { tier: "standard" });
    expect(r.entry.id).toBe("claude-sonnet-5");
    expect(r.thinkingLevel).toBe("medium");
  });
  it("preference order: falls to next available when sonnet-5 absent", () => {
    const noS5 = entries.filter((e) => e.id !== "claude-sonnet-5");
    expect(pick(noS5, { tier: "standard" }).entry.id).toBe("claude-sonnet-4.6");
  });
  it("heavy tier -> opus at LOW thinking by default", () => {
    const r = pick(entries, { tier: "heavy" });
    expect(r.entry.id).toBe("claude-opus-4.8");
    expect(r.thinkingLevel).toBe("low");
  });
  it("light tier -> mai-code first (cheap budget)", () => {
    expect(pick(entries, { budget: "cheap" }).entry.id).toBe("mai-code-1-flash-picker");
  });
  it("explicit thinkingLevel overrides the tier default", () => {
    expect(pick(entries, { tier: "heavy", thinkingLevel: "xhigh" }).thinkingLevel).toBe("xhigh");
  });
  it("needsVision filters out mai-code (no vision) in light", () => {
    const r = pick(entries, { tier: "light", needsVision: true });
    expect(r.entry.vision).toBe(true);
    expect(r.entry.id).not.toBe("mai-code-1-flash-picker");
  });
  it("degrades when the target tier is unavailable", () => {
    const lightOnly = entries.filter((e) => e.tier === "light");
    const r = pick(lightOnly, { tier: "heavy" });
    expect(r.entry.available).toBe(true);
  });
});
