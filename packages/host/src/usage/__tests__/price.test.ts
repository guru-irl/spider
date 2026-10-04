import { describe, expect, it } from "vitest";
import { canonicalModelId } from "../rates.js";
import { priceCall } from "../price.js";
import type { ModelRef, UsageTokens } from "../types.js";

const AT = Date.UTC(2026, 9, 2);
const MODEL: ModelRef = { provider: "github-copilot", id: "gpt-6.1-sol" };
const ZERO: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Literal independent oracle: ID, threshold, default four rates, long four rates.
const LONG_MODELS: readonly (readonly [string, number, readonly number[], readonly number[]])[] = [
  ["gpt-5.4", 272000, [2.5, 0.25, 0, 15], [5, 0.5, 0, 22.5]],
  ["gpt-5.5", 272000, [5, 0.5, 0, 30], [10, 1, 0, 45]],
  ["gpt-5.6-luna", 200000, [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]],
  ["gpt-5.6-sol", 272000, [4, 0.4, 5, 20], [8, 0.8, 10, 30]],
  ["gpt-5.6-terra", 272000, [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]],
  ["gpt-6-astra", 272000, [10, 1, 12.5, 50], [20, 2, 25, 75]],
  ["gpt-6-luna", 272000, [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
  ["gpt-6-sol", 272000, [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
  ["gpt-6.1-sol", 272000, [2, 0.1, 2.5, 10], [4, 0.2, 5, 15]],
  ["grok-4.5", 200000, [2, 0.5, 0, 6], [4, 1, 0, 12]],
  ["grok-4.6", 200000, [2, 0.5, 0, 6], [4, 1, 0, 12]],
  ["grok-4.7", 200000, [2, 0.5, 0, 6], [4, 1, 0, 12]],
];
const PROMPT_SHAPES = ["input", "cacheRead", "cacheWrite", "mixed"] as const;
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const;

describe("priceCall", () => {
  // Catches double billing of reasoning or 1h writes, wrong conversion or component swaps.
  it("bills output once including reasoning", () => {
    expect(priceCall(MODEL, {
      input: 1000000, cacheRead: 1000000, cacheWrite: 1000000, output: 1000000,
      reasoning: 600000, cacheWrite1h: 500000, totalTokens: 4000000,
    }, AT)).toEqual({
      status: "priced", aic: 2420,
      components: { input: 400, cacheRead: 20, cacheWrite: 500, output: 1500 },
      rateVersion: "copilot-public-2026-10-04", tier: "long-context", confidence: "estimated",
    });
  });

  // Catches >= in place of >, ignoring either cache bucket, or counting output as prompt.
  for (const [id, threshold, defaultRates, longRates] of LONG_MODELS) {
    for (const shape of PROMPT_SHAPES) {
      it.each([-1, 0, 1])(`uses strictly greater tier boundary for ${id} ${shape}, offset %i`, offset => {
        const prompt = threshold + offset;
        const usage: UsageTokens = { ...ZERO, output: 1000000 };
        if (shape === "mixed") {
          usage.input = 100000;
          usage.cacheRead = 50000;
          usage.cacheWrite = prompt - 150000;
        } else usage[shape] = prompt;
        const rates = offset === 1 ? longRates : defaultRates;
        const result = priceCall({ provider: "github-copilot", id }, usage, AT);
        expect(result.status).toBe("priced");
        if (result.status !== "priced") throw new Error("expected priced boundary");
        expect(result.tier).toBe(offset === 1 ? "long-context" : "default");
        const amounts = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
        const expected = amounts.map((amount, index) => amount * rates[index] / 10000);
        const actual = [result.components.input, result.components.cacheRead, result.components.cacheWrite, result.components.output];
        actual.forEach((amount, index) => expect(amount).toBeCloseTo(expected[index], 10));
        expect(result.aic).toBeCloseTo(expected.reduce((sum, amount) => sum + amount, 0), 10);
      });
    }
  }

  it("normalizes explicit response aliases", () => {
    expect(canonicalModelId("claude-opus-5-5")).toBe("claude-opus-5.5");
    expect(priceCall({ provider: "github-copilot", id: "claude-opus-5-5" }, {
      input: 1000000, cacheRead: 1000000, cacheWrite: 1000000, output: 1000000,
    }, AT)).toMatchObject({
      status: "priced", aic: 2920,
      components: { input: 400, cacheRead: 20, cacheWrite: 500, output: 2000 },
    });
  });

  it.each(["claude-opus-5-5-unknown", "CLAUDE-OPUS-5.5", "claude-opus-5.50", "gemini-3.7-flash1", "gpt-6.1-sol-latest", "gpt-6.1-sol "])(
    "does not fuzzy match %s", id => {
      expect(canonicalModelId(id)).toBe(id);
      expect(priceCall({ provider: "github-copilot", id }, ZERO, AT)).toEqual({ status: "unpriced", reason: "unknown-model" });
    },
  );

  it.each([
    ["before effective date", MODEL, Date.UTC(2026, 9, 1) - 1, "no-rate-at-time"],
    ["unknown model", { provider: "github-copilot", id: "unknown-model" }, AT, "unknown-model"],
    ["missing model", { provider: "github-copilot", id: null }, AT, "missing-attribution"],
    ["missing provider", { provider: null, id: "gpt-6.1-sol" }, AT, "missing-attribution"],
    ["empty model", { provider: "github-copilot", id: "" }, AT, "missing-attribution"],
    ["empty provider", { provider: "", id: "gpt-6.1-sol" }, AT, "missing-attribution"],
    ["foreign provider", { provider: "openai", id: "gpt-6.1-sol" }, AT, "unsupported-provider"],
    ["unknown provider", { provider: "github-copilot-other", id: "gpt-6.1-sol" }, AT, "unsupported-provider"],
  ] as const)("keeps historical and foreign models unpriced: %s", (_label, model, at, reason) => {
    expect(priceCall(model, { ...ZERO, input: 100 }, at)).toEqual({ status: "unpriced", reason });
  });

  it("prices from the effective date inclusively", () => {
    expect(priceCall(MODEL, { ...ZERO, input: 10000 }, Date.UTC(2026, 9, 1))).toMatchObject({ status: "priced", aic: 2 });
  });

  for (const field of TOKEN_FIELDS) {
    it.each([NaN, Infinity, -Infinity, -1])(`rejects invalid tokens: ${field} = %s`, value => {
      expect(priceCall(MODEL, { ...ZERO, [field]: value }, AT)).toEqual({ status: "unpriced", reason: "invalid-usage" });
    });
  }

  it("rejects cacheWrite1h exceeding cacheWrite", () => {
    expect(priceCall(MODEL, { ...ZERO, cacheWrite: 100, cacheWrite1h: 101 }, AT)).toEqual({ status: "unpriced", reason: "invalid-usage" });
  });

  it("accepts cacheWrite1h equal to cacheWrite without double billing", () => {
    expect(priceCall(MODEL, { ...ZERO, cacheWrite: 10000, cacheWrite1h: 10000 }, AT)).toMatchObject({
      status: "priced", aic: 2.5, components: { input: 0, cacheRead: 0, cacheWrite: 2.5, output: 0 },
    });
  });

  it("prices known zero usage without pretending unknown models are free", () => {
    expect(priceCall(MODEL, ZERO, AT)).toMatchObject({
      status: "priced", aic: 0, tier: "default", components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    expect(priceCall({ provider: "github-copilot", id: "unknown-model" }, ZERO, AT)).toEqual({ status: "unpriced", reason: "unknown-model" });
  });

  it.each([NaN, Infinity, -Infinity])("does not choose rates for an invalid timestamp %s", at => {
    expect(priceCall(MODEL, ZERO, at)).toEqual({ status: "unpriced", reason: "no-rate-at-time" });
  });

  it("rejects overflow rather than returning infinite credits", () => {
    expect(priceCall(MODEL, { ...ZERO, output: Number.MAX_VALUE }, AT)).toEqual({ status: "unpriced", reason: "invalid-usage" });
    expect(priceCall(MODEL, { ...ZERO, input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE }, AT)).toEqual({ status: "unpriced", reason: "invalid-usage" });
  });

  // Catches treating the promotional price as permanent or ending it a day early.
  for (const id of ["gemini-3.7-flash", "gemini-3.8-flash"]) {
    it(`does not silently extend promotional rates: ${id}`, () => {
      const model = { provider: "github-copilot", id };
      expect(priceCall(model, { ...ZERO, input: 1000000 }, Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toMatchObject({ status: "priced", aic: 75 });
      expect(priceCall(model, ZERO, Date.UTC(2027, 0, 1))).toEqual({ status: "unpriced", reason: "no-rate-at-time" });
      expect(priceCall(model, ZERO, Date.UTC(2027, 5, 1))).toEqual({ status: "unpriced", reason: "no-rate-at-time" });
      expect(priceCall(model, ZERO, Date.UTC(2027, 0, 1), { aggregate: true })).toEqual({ status: "unpriced", reason: "no-rate-at-time" });
    });
  }

  it("does not expire non-promotional models with the Gemini promotion", () => {
    expect(priceCall(MODEL, ZERO, Date.UTC(2027, 0, 1))).toMatchObject({ status: "priced", aic: 0 });
  });

  it("run aggregates do not invent long-context calls", () => {
    expect(priceCall(MODEL, { input: 1000000, cacheRead: 1000000, cacheWrite: 1000000, output: 1000000 }, AT, { aggregate: true })).toEqual({
      status: "priced", aic: 1460,
      components: { input: 200, cacheRead: 10, cacheWrite: 250, output: 1000 },
      tier: "aggregate-default-lower-bound", rateVersion: "copilot-public-2026-10-04", confidence: "estimated",
    });
  });

  it("aggregate mode retains uncertainty for a single-tier model", () => {
    expect(priceCall({ provider: "github-copilot", id: "claude-opus-5.5" }, { ...ZERO, output: 1000000 }, AT, { aggregate: true })).toMatchObject({
      status: "priced", aic: 2000, tier: "aggregate-default-lower-bound", confidence: "estimated",
    });
  });
});
