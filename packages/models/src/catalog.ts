import { deriveTier, type Tier } from "./tiers";
export type { Tier }; // re-export so consumers (pick.ts) keep importing Tier from catalog
import type { ThinkingModel } from "@spider/db-core";
export type { ThinkingLevel } from "@spider/db-core";
export interface ModelEntry {
  provider: string; id: string; tier: Tier;
  thinking: boolean; thinkingLevelMap?: ThinkingModel["thinkingLevelMap"]; vision: boolean; ctx: number; speed: number; costHint: number; available: boolean;
}
export type EnumeratedModel = { provider: string; id: string; available: boolean; thinking?: boolean; reasoning?: boolean; thinkingLevelMap?: ThinkingModel["thinkingLevelMap"]; vision?: boolean; ctx?: number };
// Ordered refs or ids per tier; pick() returns the first available (A8).
// Qualified policy refs precede bare ids so Copilot wins when several providers list them.
export const TIER_PREFERENCE: Record<Tier, string[]> = {
  light:    ["github-copilot/gpt-6-luna", "gpt-6-luna", "mai-code-1-flash-picker", "gemini-3.5-flash"],
  standard: ["github-copilot/gpt-6.1-sol", "gpt-6.1-sol", "github-copilot/gpt-6-sol", "gpt-6-sol", "gemini-3.1-pro-preview"],
  heavy:    ["github-copilot/claude-opus-5.5", "claude-opus-5.5"],
};
const SPEED: Record<Tier, number> = { light: 3, standard: 2, heavy: 1 };
const COST: Record<Tier, number> = { light: 0.1, standard: 0.5, heavy: 1 };
export function catalog(enumerate: () => EnumeratedModel[], overrides: Record<string, Partial<ModelEntry>> = {}): ModelEntry[] {
  return enumerate().map((m) => {
    const tier = deriveTier(m.id);
    const base: ModelEntry = {
      provider: m.provider, id: m.id, tier,
      thinking: !!(m.thinking ?? m.reasoning), vision: !!m.vision,
      ctx: m.ctx ?? 128_000, speed: SPEED[tier], costHint: COST[tier], available: m.available,
    };
    if (m.thinkingLevelMap) base.thinkingLevelMap = m.thinkingLevelMap;
    return { ...base, ...overrides[`${m.provider}/${m.id}`] };
  });
}
