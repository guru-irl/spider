export type UsageTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of cacheWrite, billed at the single public write rate, not a separate 1h rate. */
  cacheWrite1h?: number;
  /** Included in output, not an additional billable bucket. */
  reasoning?: number;
  totalTokens?: number;
};

export type ModelRef = { provider: string | null; id: string | null };

export type Actor = "parent" | "subagent" | "aux" | "compaction" | "warmer";

export type PriceResult = {
  status: "priced";
  /** Unrounded double: round only for display; compare summed estimates with tolerance. */
  aic: number;
  components: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null };
  rateVersion: string;
  tier: string;
  confidence: "estimated" | "verified";
} | {
  status: "unpriced";
  reason: "unknown-model" | "unsupported-provider" | "missing-attribution" | "no-rate-at-time" | "invalid-usage" | "reported-cost-zero";
};

export type RateVersion = {
  id: string;
  effectiveFrom: string;
  source: string;
  sourceAsOf: string;
  confidence: "estimated" | "verified";
  models: readonly ModelRate[];
};

export type ModelRate = {
  id: string;
  aliases: readonly string[];
  /** Exclusive ISO timestamp: this model's rates are not known at or after it. */
  validUntil?: string;
  tiers: readonly RateTier[];
};

export type RateTier = {
  name: string;
  abovePromptTokens: number;
  usdPerMillion: { input: number; cacheRead: number; cacheWrite: number; output: number };
};
