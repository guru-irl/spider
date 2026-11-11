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
  ["gpt-6.1-terra", "default", 0, 1, 0.05, 1.25, 5],
  ["gpt-6.1-terra", "long-context", 272000, 2, 0.1, 2.5, 7.5],
  ["claude-haiku-4.5", "default", 0, 1, 0.1, 1.25, 5],
  ["claude-haiku-5.5", "default", 0, 0.1, 0.01, 0.125, 0.5],
  ["claude-haiku-5.5", "long-context", 100000, 0.5, 0.05, 0.625, 2.5],
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
  ["claude-fable-5.2", "default", 0, 8, 0.2, 10, 40],
  ["gemini-3.7-flash", "default", 0, 0.75, 0.075, 0, 3.75],
  ["gemini-3.8-flash", "default", 0, 0.75, 0.075, 0, 3.75],
  ["gemini-4-argon", "default", 0, 2, 0.1, 0, 10],
  ["gemini-4-carbon", "default", 0, 2, 0.1, 0, 10],
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
const NEW_RATES_FROM = Date.UTC(2026, 10, 11);
// The 2026-11-11 page changed one published value; every other row is unchanged.
const ROWS_2026_11_11 = PUBLIC_ROWS.map(row => row[0] === "claude-sonnet-5.5" ? [row[0], row[1], row[2], 2, 0.1, 2.5, 10] as const : row);
const rowsOf = (id: string) => {
  const version = COPILOT_RATE_VERSIONS.find(candidate => candidate.id === id);
  if (!version) throw new Error(`missing rate version ${id}`);
  return version.models.flatMap(model => model.tiers.map(tier => [
    model.id, tier.name, tier.abovePromptTokens,
    tier.usdPerMillion.input, tier.usdPerMillion.cacheRead,
    tier.usdPerMillion.cacheWrite, tier.usdPerMillion.output,
  ]));
};

describe("public Copilot rates", () => {
  // Catches omitted models, footnotes mistaken for IDs, wrong thresholds or any rate typo.
  it("covers every public model and tier", () => {
    expect(COPILOT_RATE_VERSIONS.map(version => version.id)).toEqual(["copilot-public-2026-10-04", "copilot-public-2026-11-11"]);
    const version = COPILOT_RATE_VERSIONS[0];
    expect(version.models).toHaveLength(36);
    expect(new Set(version.models.map(model => model.id)).size).toBe(36);
    const rows = rowsOf("copilot-public-2026-10-04");
    expect(rows).toHaveLength(50);
    expect(rows).toEqual(PUBLIC_ROWS);
  });

  it("records the 2026-11-11 Claude Sonnet 5.5 cached-input cut as a new version", () => {
    expect(COPILOT_RATE_VERSIONS[1]).toMatchObject({
      id: "copilot-public-2026-11-11",
      effectiveFrom: "2026-11-11T00:00:00.000Z",
      sourceAsOf: "2026-11-11",
      confidence: "estimated",
    });
    expect(COPILOT_RATE_VERSIONS[1].source).toContain("https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing");
    expect(rowsOf("copilot-public-2026-11-11")).toEqual(ROWS_2026_11_11);
    const sonnet = { provider: "github-copilot", id: "claude-sonnet-5.5" };
    const cached = { input: 0, cacheRead: 1000000, cacheWrite: 0, output: 0 };
    expect(priceCall(sonnet, cached, NEW_RATES_FROM - 1)).toMatchObject({ status: "priced", aic: 20, rateVersion: "copilot-public-2026-10-04" });
    expect(priceCall(sonnet, cached, NEW_RATES_FROM)).toMatchObject({ status: "priced", aic: 10, rateVersion: "copilot-public-2026-11-11" });
  });

  // GPT-6.1 Terra calls were unpriced, so the dashboard showed no credits for them.
  it("prices GPT-6.1 Terra calls made before and after the new version", () => {
    const terra = { provider: "github-copilot", id: "gpt-6.1-terra" };
    const tokens = { input: 1000000, cacheRead: 1000000, cacheWrite: 1000000, output: 1000000 };
    expect(priceCall(terra, tokens, Date.UTC(2026, 10, 5))).toMatchObject({ status: "priced", tier: "long-context", rateVersion: "copilot-public-2026-10-04" });
    const small = { input: 50000, cacheRead: 50000, cacheWrite: 50000, output: 50000 };
    expect(priceCall(terra, small, NEW_RATES_FROM)).toMatchObject({ status: "priced", tier: "default", aic: 36.5, rateVersion: "copilot-public-2026-11-11" });
  });

  it("preserves structural invariants for every version and model", () => {
    const canonicalAliases = new Map<string, string>();
    for (const version of COPILOT_RATE_VERSIONS) {
      expect(Number.isFinite(Date.parse(version.effectiveFrom))).toBe(true);
      const ids = version.models.map(model => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      const aliases = version.models.flatMap(model => model.aliases);
      expect(new Set(aliases).size).toBe(aliases.length);
      for (const model of version.models) {
        if (model.validUntil !== undefined) {
          expect(Number.isFinite(Date.parse(model.validUntil))).toBe(true);
          expect(Date.parse(model.validUntil)).toBeGreaterThan(Date.parse(version.effectiveFrom));
        }
        for (const alias of model.aliases) {
          expect(ids).not.toContain(alias);
          // canonicalModelId has no timestamp: public aliases must keep their identity.
          const prior = canonicalAliases.get(alias);
          if (prior !== undefined) expect(model.id).toBe(prior);
          canonicalAliases.set(alias, model.id);
        }
        const defaults = model.tiers.filter(tier => tier.abovePromptTokens === 0);
        expect(defaults).toHaveLength(1);
        let previousThreshold = -1;
        for (const tier of model.tiers) {
          expect(Number.isInteger(tier.abovePromptTokens)).toBe(true);
          expect(tier.abovePromptTokens).toBeGreaterThan(previousThreshold);
          previousThreshold = tier.abovePromptTokens;
          for (const bucket of ["input", "cacheRead", "cacheWrite", "output"] as const) {
            expect(Number.isFinite(tier.usdPerMillion[bucket])).toBe(true);
            expect(tier.usdPerMillion[bucket]).toBeGreaterThanOrEqual(defaults[0].usdPerMillion[bucket]);
            expect(tier.usdPerMillion[bucket]).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("retains the dated estimated source and explicit limitations", () => {
    expect(COPILOT_RATE_VERSIONS[0]).toMatchObject({
      id: "copilot-public-2026-10-04",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
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
