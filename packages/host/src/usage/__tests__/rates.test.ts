import { describe, expect, it } from "vitest";
import { COPILOT_RATE_VERSIONS } from "../rates.js";
import { priceCall } from "../price.js";

// Independently transcribed from the public GitHub Docs snapshot, 2026-10-04.
// Model, tier, strictly-above prompt threshold, input/read/write/output USD per million.
const PUBLIC_ROWS: readonly (readonly [string, string, number, number, number, number, number])[] = [
  ["gpt-5-mini", "default", 0, 0.25, 0.025, 0, 2],
  ["gpt-5.3-codex", "default", 0, 1.75, 0.175, 0, 14],
  ["gpt-5.4", "default", 0, 2.5, 0.25, 0, 15],
  ["gpt-5.4", "long-context", 272000, 5, 0.5, 0, 22.5],
  ["gpt-5.4-mini", "default", 0, 0.75, 0.075, 0, 4.5],
  ["gpt-5.4-nano", "default", 0, 0.2, 0.02, 0, 1.25],
  ["gpt-5.5", "default", 0, 5, 0.5, 0, 30],
  ["gpt-5.5", "long-context", 272000, 10, 1, 0, 45],
  ["gpt-5.6-luna", "default", 0, 0.2, 0.02, 0.25, 1.2],
  ["gpt-5.6-luna", "long-context", 200000, 0.4, 0.04, 0.5, 1.8],
  ["gpt-5.6-sol", "default", 0, 4, 0.4, 5, 20],
  ["gpt-5.6-sol", "long-context", 272000, 8, 0.8, 10, 30],
  ["gpt-5.6-terra", "default", 0, 2, 0.2, 2.5, 12],
  ["gpt-5.6-terra", "long-context", 272000, 4, 0.4, 5, 18],
  ["gpt-6-astra", "default", 0, 10, 1, 12.5, 50],
  ["gpt-6-astra", "long-context", 272000, 20, 2, 25, 75],
  ["gpt-6-luna", "default", 0, 0.1, 0.01, 0.125, 0.5],
  ["gpt-6-luna", "long-context", 272000, 0.2, 0.02, 0.25, 0.75],
  ["gpt-6-sol", "default", 0, 2, 0.2, 2.5, 10],
  ["gpt-6-sol", "long-context", 272000, 4, 0.4, 5, 15],
  ["gpt-6.1-sol", "default", 0, 2, 0.1, 2.5, 10],
  ["gpt-6.1-sol", "long-context", 272000, 4, 0.2, 5, 15],
  ["claude-haiku-4.5", "default", 0, 1, 0.1, 1.25, 5],
  ["claude-sonnet-4", "default", 0, 3, 0.3, 3.75, 15],
  ["claude-sonnet-4.6", "default", 0, 3, 0.3, 3.75, 15],
  ["claude-opus-4.8", "default", 0, 5, 0.5, 6.25, 25],
  ["claude-opus-5", "default", 0, 5, 0.5, 6.25, 25],
  ["claude-opus-5.5", "default", 0, 4, 0.2, 5, 20],
  ["claude-sonnet-5", "default", 0, 2, 0.2, 2.5, 10],
  ["claude-sonnet-5.5", "default", 0, 2, 0.2, 2.5, 10],
  ["claude-opus-4.8-fast", "default", 0, 10, 1, 12.5, 50],
  ["claude-fable-5", "default", 0, 10, 1, 12.5, 50],
  ["claude-fable-5.1", "default", 0, 10, 0.25, 12.5, 50],
  ["gemini-3.7-flash", "default", 0, 0.75, 0.075, 0, 3.75],
  ["gemini-3.8-flash", "default", 0, 0.75, 0.075, 0, 3.75],
  ["mai-code-1.1-flash", "default", 0, 0.2, 0.02, 0, 1.2],
  ["grok-4.5", "default", 0, 2, 0.5, 0, 6],
  ["grok-4.5", "long-context", 200000, 4, 1, 0, 12],
  ["grok-4.6", "default", 0, 2, 0.5, 0, 6],
  ["grok-4.6", "long-context", 200000, 4, 1, 0, 12],
  ["grok-4.7", "default", 0, 2, 0.5, 0, 6],
  ["grok-4.7", "long-context", 200000, 4, 1, 0, 12],
  ["kimi-k3", "default", 0, 3, 0.3, 0, 15],
];

const AT = Date.UTC(2026, 9, 2);

describe("public Copilot rates", () => {
  // Catches omitted models, footnotes mistaken for IDs, wrong thresholds or any rate typo.
  it("covers every public model and tier", () => {
    expect(COPILOT_RATE_VERSIONS).toHaveLength(1);
    const version = COPILOT_RATE_VERSIONS[0];
    expect(version.models).toHaveLength(31);
    expect(new Set(version.models.map(model => model.id)).size).toBe(31);
    const rows = version.models.flatMap(model => model.tiers.map(tier => [
      model.id, tier.name, tier.abovePromptTokens,
      tier.usdPerMillion.input, tier.usdPerMillion.cacheRead,
      tier.usdPerMillion.cacheWrite, tier.usdPerMillion.output,
    ]));
    expect(rows).toHaveLength(43);
    expect(rows).toEqual(PUBLIC_ROWS);
  });

  it("retains the dated estimated source and explicit limitations", () => {
    expect(COPILOT_RATE_VERSIONS[0]).toMatchObject({
      id: "copilot-public-2026-10-04",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      sourceAsOf: "2026-10-04",
      confidence: "estimated",
    });
    const source = COPILOT_RATE_VERSIONS[0].source;
    expect(source).toContain("https://docs.github.com/en/copilot/reference/ai-models/models-and-pricing");
    expect(source).toContain("Not applicable");
    expect(source).toContain("preview");
    expect(source).toContain("promotional");
    expect(source).toContain("2026-12-31");
  });

  // Exercises the consumer, not just the table: catches wrong bucket/rate/unit selection.
  it.each(PUBLIC_ROWS)("prices %s %s using all four public rates", (id, tier, threshold, input, read, write, output) => {
    const tokens = { input: threshold + 100, cacheRead: 100, cacheWrite: 100, output: 100 };
    const result = priceCall({ provider: "github-copilot", id }, tokens, AT);
    expect(result.status).toBe("priced");
    if (result.status !== "priced") throw new Error("expected a priced public row");
    expect(result).toMatchObject({ tier, rateVersion: "copilot-public-2026-10-04", confidence: "estimated" });
    expect(result.components.input).toBeCloseTo(tokens.input * input / 10000, 10);
    expect(result.components.cacheRead).toBeCloseTo(100 * read / 10000, 10);
    expect(result.components.cacheWrite).toBeCloseTo(100 * write / 10000, 10);
    expect(result.components.output).toBeCloseTo(100 * output / 10000, 10);
    expect(result.aic).toBeCloseTo((tokens.input * input + 100 * (read + write + output)) / 10000, 10);
  });
});
