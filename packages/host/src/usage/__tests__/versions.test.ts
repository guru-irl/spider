import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateVersion } from "../types.js";

// Only the table is replaced: the real priceCall selects and prices these versions.
const fixture = vi.hoisted(() => {
  const versions: RateVersion[] = [
    {
      id: "v2", effectiveFrom: "2027-01-01T00:00:00.000Z", sourceAsOf: "2027-01-01",
      source: "synthetic test rates", confidence: "verified",
      models: [
        { id: "renewed", aliases: ["moving-alias", "new-alias"], tiers: [
          { name: "default", abovePromptTokens: 0, usdPerMillion: { input: 4, cacheRead: 1, cacheWrite: 5, output: 10 } },
          { name: "long", abovePromptTokens: 100, usdPerMillion: { input: 8, cacheRead: 2, cacheWrite: 10, output: 20 } },
        ] },
        { id: "other", aliases: [], tiers: [
          { name: "default", abovePromptTokens: 0, usdPerMillion: { input: 9, cacheRead: 1, cacheWrite: 5, output: 10 } },
        ] },
      ],
    },
    {
      id: "v1", effectiveFrom: "2026-10-01T00:00:00.000Z", sourceAsOf: "2026-10-01",
      source: "synthetic test rates", confidence: "estimated",
      models: [
        { id: "renewed", aliases: ["old-alias"], validUntil: "2026-12-15T00:00:00.000Z", tiers: [
          { name: "default", abovePromptTokens: 0, usdPerMillion: { input: 2, cacheRead: 0.5, cacheWrite: 2.5, output: 5 } },
        ] },
        { id: "other", aliases: ["moving-alias"], tiers: [
          { name: "default", abovePromptTokens: 0, usdPerMillion: { input: 3, cacheRead: 0.5, cacheWrite: 2.5, output: 5 } },
        ] },
      ],
    },
  ];
  return { versions, original: [...versions] };
});
vi.mock("../rates.js", () => ({ COPILOT_RATE_VERSIONS: fixture.versions }));
import { priceCall } from "../price.js";

const USAGE = { input: 10000, cacheRead: 0, cacheWrite: 0, output: 0 };
const MODEL = { provider: "github-copilot", id: "renewed" };
const DEC = Date.UTC(2026, 11, 1);
const FEB = Date.UTC(2027, 1, 1);

beforeEach(() => fixture.versions.splice(0, fixture.versions.length, ...fixture.original));

describe("versioned pricing", () => {
  it("uses the older effective version before the newer one starts", () => {
    expect(priceCall(MODEL, USAGE, DEC)).toMatchObject({ status: "priced", aic: 2, rateVersion: "v1", confidence: "estimated" });
  });

  it.each(["newest-first", "oldest-first"])("selects the newest effective version with %s table order", order => {
    if (order === "oldest-first") fixture.versions.reverse();
    expect(priceCall(MODEL, USAGE, FEB)).toMatchObject({ status: "priced", aic: 8, tier: "long", rateVersion: "v2", confidence: "verified" });
  });

  it("switches versions at the effective instant inclusively", () => {
    const model = { provider: "github-copilot", id: "other" };
    const at = Date.UTC(2027, 0, 1);
    expect(priceCall(model, USAGE, at - 1)).toMatchObject({ status: "priced", aic: 3, rateVersion: "v1" });
    expect(priceCall(model, USAGE, at)).toMatchObject({ status: "priced", aic: 9, rateVersion: "v2" });
  });

  it("keeps aggregate confidence estimated even with a verified version", () => {
    expect(priceCall(MODEL, USAGE, FEB, { aggregate: true })).toMatchObject({
      status: "priced", aic: 4, tier: "aggregate-default-lower-bound", rateVersion: "v2", confidence: "estimated",
    });
  });

  it("prices an expired promotion again only when a newer version covers it", () => {
    expect(priceCall(MODEL, USAGE, Date.UTC(2026, 11, 15))).toEqual({ status: "unpriced", reason: "no-rate-at-time" });
    expect(priceCall(MODEL, USAGE, FEB)).toMatchObject({ status: "priced", aic: 8, rateVersion: "v2" });
  });

  it.each([
    ["old effective version", DEC, 3, "v1"],
    ["new effective version", FEB, 8, "v2"],
  ] as const)("resolves a reassigned alias only within the %s", (_label, at, aic, rateVersion) => {
    expect(priceCall({ provider: "github-copilot", id: "moving-alias" }, USAGE, at)).toMatchObject({ status: "priced", aic, rateVersion });
  });

  it("does not borrow aliases from past or future versions", () => {
    expect(priceCall({ provider: "github-copilot", id: "new-alias" }, USAGE, DEC)).toEqual({ status: "unpriced", reason: "unknown-model" });
    expect(priceCall({ provider: "github-copilot", id: "old-alias" }, USAGE, FEB)).toEqual({ status: "unpriced", reason: "unknown-model" });
  });
});
