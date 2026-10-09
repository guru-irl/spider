import { COPILOT_RATE_VERSIONS } from "./rates.js";
import type { ModelRef, PriceResult, RateVersion, UsageTokens } from "./types.js";

export const REPORTED_COST_RATE_VERSION = "pi-reported-cost-v1";

/** Plugin attribution is billing evidence only when it is a bounded qualified id. */
export function summaryModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== "string" || value.length > 128 || !/^[a-z0-9._-]+\/[A-Za-z0-9.:_-]+$/.test(value)) return undefined;
  const [provider, id] = value.split("/");
  return { provider: provider!, id: id! };
}

/** Pi records USD. Only Copilot's reported cost has the 100 credits/USD basis. */
export function priceReportedCost(provider: string | null, cost: {
  total?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown;
} | null | undefined, usage: UsageTokens, at: number): PriceResult {
  if (!provider) return { status: "unpriced", reason: "missing-attribution" };
  if (provider !== "github-copilot") return { status: "unpriced", reason: "unsupported-provider" };
  if (!rateVersionAt(at)) return { status: "unpriced", reason: "no-rate-at-time" };
  const credits = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(value * 100) ? value * 100 : null;
  const aic = credits(cost?.total);
  if (aic === null) return { status: "unpriced", reason: "invalid-usage" };
  if (aic === 0 && Object.values(usage).some(value => value > 0)) return { status: "unpriced", reason: "reported-cost-zero" };
  return { status: "priced", aic, components: { input: credits(cost?.input), output: credits(cost?.output),
    cacheRead: credits(cost?.cacheRead), cacheWrite: credits(cost?.cacheWrite) },
    rateVersion: REPORTED_COST_RATE_VERSION, tier: "reported-cost", confidence: "estimated" };
}

function validUsage(usage: UsageTokens): boolean {
  const required = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const optional = [usage.cacheWrite1h, usage.reasoning, usage.totalTokens];
  return required.every(value => Number.isInteger(value) && value >= 0)
    && optional.every(value => value === undefined || (Number.isInteger(value) && value >= 0))
    && (usage.cacheWrite1h === undefined || usage.cacheWrite1h <= usage.cacheWrite);
}

function rateVersionAt(at: number): RateVersion | undefined {
  if (!Number.isFinite(at)) return undefined;
  // Select the most recent effective version, independent of array ordering.
  let version: RateVersion | undefined;
  let effectiveFrom = -Infinity;
  for (const candidate of COPILOT_RATE_VERSIONS) {
    const from = Date.parse(candidate.effectiveFrom);
    if (from <= at && from > effectiveFrom) {
      version = candidate;
      effectiveFrom = from;
    }
  }
  return version;
}

export function priceCall(model: ModelRef, usage: UsageTokens, at: number, options?: { aggregate?: boolean }): PriceResult {
  if (!model.provider || !model.id) return { status: "unpriced", reason: "missing-attribution" };
  if (model.provider !== "github-copilot") return { status: "unpriced", reason: "unsupported-provider" };
  if (!validUsage(usage)) return { status: "unpriced", reason: "invalid-usage" };
  const version = rateVersionAt(at);
  if (!version) return { status: "unpriced", reason: "no-rate-at-time" };
  // Alias attribution is scoped to the selected version, not guessed from another date.
  const rate = version.models.find(rate => rate.id === model.id || rate.aliases.includes(model.id!));
  if (!rate) return { status: "unpriced", reason: "unknown-model" };
  if (rate.validUntil && at >= Date.parse(rate.validUntil)) return { status: "unpriced", reason: "no-rate-at-time" };

  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  // Low rates can leave components finite even when the token sum overflows.
  if (!Number.isFinite(prompt)) return { status: "unpriced", reason: "invalid-usage" };
  let selected = rate.tiers.find(tier => tier.abovePromptTokens === 0);
  if (!selected) return { status: "unpriced", reason: "no-rate-at-time" };
  if (!options?.aggregate) {
    for (const tier of rate.tiers) {
      if (prompt > tier.abovePromptTokens && tier.abovePromptTokens > selected.abovePromptTokens) selected = tier;
    }
  }

  // 1M tokens / 100 credits per USD = divisor 10000.
  // reasoning is already included in output; cacheWrite1h is included in cacheWrite.
  // The public table has one write rate, not the upstream vendor's 5m/1h split.
  // Preserve doubles here: consumers round only for display and compare sums with tolerance.
  const usd = selected.usdPerMillion;
  const components = {
    input: usage.input * usd.input / 10000,
    cacheRead: usage.cacheRead * usd.cacheRead / 10000,
    cacheWrite: usage.cacheWrite * usd.cacheWrite / 10000,
    output: usage.output * usd.output / 10000,
  };
  const aic = components.input + components.cacheRead + components.cacheWrite + components.output;
  if (!Number.isFinite(aic)) return { status: "unpriced", reason: "invalid-usage" };
  return {
    status: "priced", aic, components, rateVersion: version.id,
    tier: options?.aggregate ? "aggregate-default-lower-bound" : selected.name,
    confidence: options?.aggregate ? "estimated" : version.confidence,
  };
}
