import { deriveTier, type Tier } from "./tiers";
export type { Tier }; // re-export so consumers (pick.ts) keep importing Tier from catalog
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ModelEntry {
  provider: string; id: string; tier: Tier;
  thinking: boolean; vision: boolean; ctx: number; speed: number; costHint: number; available: boolean;
}
export type EnumeratedModel = { provider: string; id: string; available: boolean; thinking?: boolean; reasoning?: boolean; vision?: boolean; ctx?: number };
// Ordered copilot ids per tier; pick() returns the FIRST AVAILABLE (A8). Host may override via cfg.tierPreference.
export const TIER_PREFERENCE: Record<Tier, string[]> = {
  light:    ["mai-code-1-flash-picker", "claude-haiku-4.5", "gpt-5.4-nano", "gpt-5-mini", "gemini-3.5-flash"],
  standard: ["claude-sonnet-5", "claude-sonnet-4.6", "claude-sonnet-4.5", "gpt-5.4"],
  heavy:    ["claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "gpt-5.5"],
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
    return { ...base, ...overrides[`${m.provider}/${m.id}`] };
  });
}
