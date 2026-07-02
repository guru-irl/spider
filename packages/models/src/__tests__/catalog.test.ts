// packages/models/src/__tests__/catalog.test.ts
import { describe, it, expect } from "vitest";
import { deriveTier, catalog } from "../index.js";

describe("deriveTier", () => {
  it("maps ids + flags to tiers (heuristic, not hardcoded list)", () => {
    expect(deriveTier("gpt-5.4-nano")).toBe("nano");
    expect(deriveTier("gpt-5-mini")).toBe("mini");
    expect(deriveTier("claude-haiku-4.5")).toBe("mini");
    expect(deriveTier("claude-sonnet-4.5")).toBe("standard");
    expect(deriveTier("claude-opus-4.8")).toBe("capable");
    expect(deriveTier("gpt-5.3-codex", { reasoning: true })).toBe("reasoning");
  });
});

describe("catalog", () => {
  it("enriches enumerated models and respects overrides", () => {
    const out = catalog(
      () => [
        { provider: "github-copilot", id: "claude-opus-4.8", available: true },
        { provider: "github-copilot", id: "gpt-5-mini", available: false },
      ],
      { "github-copilot/gpt-5-mini": { costHint: 0.1 } },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "claude-opus-4.8", tier: "capable", available: true });
    expect(out[1]).toMatchObject({ id: "gpt-5-mini", tier: "mini", available: false, costHint: 0.1 });
  });
});
