import { describe, it, expect } from "vitest";
import { deriveTier, catalog } from "../index.js";

describe("deriveTier (A8: 3 tiers)", () => {
  it("maps model families to light|standard|heavy", () => {
    expect(deriveTier("claude-opus-4.8")).toBe("heavy");
    expect(deriveTier("claude-sonnet-5")).toBe("standard");
    expect(deriveTier("claude-haiku-4.5")).toBe("light");
    expect(deriveTier("mai-code-1-flash-picker")).toBe("light");
    expect(deriveTier("gpt-5.4-nano")).toBe("light");
    expect(deriveTier("gpt-5-mini")).toBe("light");
    expect(deriveTier("gpt-5.5")).toBe("heavy");
    expect(deriveTier("gpt-5.4")).toBe("standard");
  });
});

describe("catalog", () => {
  it("enriches enumerated models (thinking field) and respects overrides", () => {
    const out = catalog(
      () => [
        { provider: "github-copilot", id: "claude-opus-4.8", available: true, reasoning: true },
        { provider: "github-copilot", id: "mai-code-1-flash-picker", available: false },
      ],
      { "github-copilot/mai-code-1-flash-picker": { costHint: 0.05 } },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "claude-opus-4.8", tier: "heavy", thinking: true, available: true });
    expect(out[1]).toMatchObject({ id: "mai-code-1-flash-picker", tier: "light", available: false, costHint: 0.05 });
  });
});
