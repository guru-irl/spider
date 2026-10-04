import type { ModelRate, RateTier, RateVersion } from "./types.js";

function tier(name: string, abovePromptTokens: number, input: number, cacheRead: number, cacheWrite: number, output: number): RateTier {
  return { name, abovePromptTokens, usdPerMillion: { input, cacheRead, cacheWrite, output } };
}

function model(id: string, tiers: readonly RateTier[], aliases: readonly string[] = [], validUntil?: string): ModelRate {
  return { id, aliases, tiers, ...(validUntil ? { validUntil } : {}) };
}

// The public snapshot is not evidence of rates before the inspected month.
// All values are USD per million tokens. No runtime fetch is performed.
export const COPILOT_RATE_VERSIONS: readonly RateVersion[] = [{
  id: "copilot-public-2026-10-04",
  effectiveFrom: "2026-10-01T00:00:00.000Z",
  sourceAsOf: "2026-10-04",
  confidence: "estimated",
  source: "GitHub Docs, Models and pricing for GitHub Copilot: "
    + "https://docs.github.com/en/copilot/reference/ai-models/models-and-pricing. "
    + "Not applicable or absent cache-write prices are represented as 0. "
    + "Includes Claude Opus 4.8 fast mode (preview). "
    + "Gemini 3.7 Flash and Gemini 3.8 Flash promotional prices apply through 2026-12-31 inclusive (UTC); "
    + "trailing footnote markers are not model IDs.",
  models: [
    model("gpt-5-mini", [tier("default", 0, 0.25, 0.025, 0, 2)]),
    model("gpt-5.3-codex", [tier("default", 0, 1.75, 0.175, 0, 14)]),
    model("gpt-5.4", [
      tier("default", 0, 2.5, 0.25, 0, 15),
      tier("long-context", 272000, 5, 0.5, 0, 22.5),
    ]),
    model("gpt-5.4-mini", [tier("default", 0, 0.75, 0.075, 0, 4.5)]),
    model("gpt-5.4-nano", [tier("default", 0, 0.2, 0.02, 0, 1.25)]),
    model("gpt-5.5", [
      tier("default", 0, 5, 0.5, 0, 30),
      tier("long-context", 272000, 10, 1, 0, 45),
    ]),
    model("gpt-5.6-luna", [
      tier("default", 0, 0.2, 0.02, 0.25, 1.2),
      tier("long-context", 200000, 0.4, 0.04, 0.5, 1.8),
    ]),
    model("gpt-5.6-sol", [
      tier("default", 0, 4, 0.4, 5, 20),
      tier("long-context", 272000, 8, 0.8, 10, 30),
    ]),
    model("gpt-5.6-terra", [
      tier("default", 0, 2, 0.2, 2.5, 12),
      tier("long-context", 272000, 4, 0.4, 5, 18),
    ]),
    model("gpt-6-astra", [
      tier("default", 0, 10, 1, 12.5, 50),
      tier("long-context", 272000, 20, 2, 25, 75),
    ]),
    model("gpt-6-luna", [
      tier("default", 0, 0.1, 0.01, 0.125, 0.5),
      tier("long-context", 272000, 0.2, 0.02, 0.25, 0.75),
    ]),
    model("gpt-6-sol", [
      tier("default", 0, 2, 0.2, 2.5, 10),
      tier("long-context", 272000, 4, 0.4, 5, 15),
    ]),
    model("gpt-6.1-sol", [
      tier("default", 0, 2, 0.1, 2.5, 10),
      tier("long-context", 272000, 4, 0.2, 5, 15),
    ]),
    model("claude-haiku-4.5", [tier("default", 0, 1, 0.1, 1.25, 5)]),
    model("claude-sonnet-4", [tier("default", 0, 3, 0.3, 3.75, 15)]),
    model("claude-sonnet-4.6", [tier("default", 0, 3, 0.3, 3.75, 15)]),
    model("claude-opus-4.8", [tier("default", 0, 5, 0.5, 6.25, 25)]),
    model("claude-opus-5", [tier("default", 0, 5, 0.5, 6.25, 25)]),
    // Only confirmed response aliases are normalized, never fuzzy model names.
    model("claude-opus-5.5", [tier("default", 0, 4, 0.2, 5, 20)], ["claude-opus-5-5"]),
    model("claude-sonnet-5", [tier("default", 0, 2, 0.2, 2.5, 10)]),
    model("claude-sonnet-5.5", [tier("default", 0, 2, 0.2, 2.5, 10)]),
    model("claude-opus-4.8-fast", [tier("default", 0, 10, 1, 12.5, 50)]),
    model("claude-fable-5", [tier("default", 0, 10, 1, 12.5, 50)]),
    model("claude-fable-5.1", [tier("default", 0, 10, 0.25, 12.5, 50)]),
    model("gemini-3.7-flash", [tier("default", 0, 0.75, 0.075, 0, 3.75)], [], "2027-01-01T00:00:00.000Z"),
    model("gemini-3.8-flash", [tier("default", 0, 0.75, 0.075, 0, 3.75)], [], "2027-01-01T00:00:00.000Z"),
    model("mai-code-1.1-flash", [tier("default", 0, 0.2, 0.02, 0, 1.2)]),
    model("grok-4.5", [
      tier("default", 0, 2, 0.5, 0, 6),
      tier("long-context", 200000, 4, 1, 0, 12),
    ]),
    model("grok-4.6", [
      tier("default", 0, 2, 0.5, 0, 6),
      tier("long-context", 200000, 4, 1, 0, 12),
    ]),
    model("grok-4.7", [
      tier("default", 0, 2, 0.5, 0, 6),
      tier("long-context", 200000, 4, 1, 0, 12),
    ]),
    model("kimi-k3", [tier("default", 0, 3, 0.3, 0, 15)]),
  ],
}];

export function canonicalModelId(id: string): string {
  for (const version of COPILOT_RATE_VERSIONS) {
    const match = version.models.find(model => model.id === id || model.aliases.includes(id));
    if (match) return match.id;
  }
  return id;
}
