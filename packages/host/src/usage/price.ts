import { COPILOT_RATE_VERSIONS } from "./rates.js";
import type { ModelRef, PriceResult, RateVersion, UsageTokens } from "./types.js";

function validUsage(usage: UsageTokens): boolean {
  const required = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const optional = [usage.cacheWrite1h, usage.reasoning, usage.totalTokens];
  return required.every(value => Number.isFinite(value) && value >= 0)
    && optional.every(value => value === undefined || (Number.isFinite(value) && value >= 0))
    && (usage.cacheWrite1h === undefined || usage.cacheWrite1h <= usage.cacheWrite);
}

export function priceCall(model: ModelRef, usage: UsageTokens, at: number, options?: { aggregate?: boolean }): PriceResult {
  if (!model.provider || !model.id) return { status: "unpriced", reason: "missing-attribution" };
  if (model.provider !== "github-copilot") return { status: "unpriced", reason: "unsupported-provider" };
  if (!validUsage(usage)) return { status: "unpriced", reason: "invalid-usage" };
  if (!Number.isFinite(at)) return { status: "unpriced", reason: "no-rate-at-time" };

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
  if (!version) return { status: "unpriced", reason: "no-rate-at-time" };
  // Alias attribution is scoped to the selected version, not guessed from another date.
  const rate = version.models.find(rate => rate.id === model.id || rate.aliases.includes(model.id!));
  if (!rate) return { status: "unpriced", reason: "unknown-model" };
  if (rate.validUntil && at >= Date.parse(rate.validUntil)) return { status: "unpriced", reason: "no-rate-at-time" };

  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
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
