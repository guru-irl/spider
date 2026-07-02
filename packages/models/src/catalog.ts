import { deriveTier } from "./tiers.js";
export type Tier = "nano" | "mini" | "standard" | "capable" | "reasoning";
export interface ModelEntry {
  provider: string; id: string; tier: Tier;
  reasoning: boolean; vision: boolean; ctx: number; speed: number; costHint: number; available: boolean;
}
export type EnumeratedModel = { provider: string; id: string; available: boolean; reasoning?: boolean; vision?: boolean; ctx?: number };
const SPEED: Record<Tier, number> = { nano: 5, mini: 4, standard: 3, capable: 2, reasoning: 1 };
const COST: Record<Tier, number> = { nano: 0.05, mini: 0.15, standard: 0.5, capable: 1, reasoning: 1.5 };
export function catalog(enumerate: () => EnumeratedModel[], overrides: Record<string, Partial<ModelEntry>> = {}): ModelEntry[] {
  return enumerate().map((m) => {
    const tier = deriveTier(m.id, { reasoning: m.reasoning });
    const base: ModelEntry = {
      provider: m.provider, id: m.id, tier,
      reasoning: !!m.reasoning || tier === "reasoning", vision: !!m.vision,
      ctx: m.ctx ?? 128_000, speed: SPEED[tier], costHint: COST[tier], available: m.available,
    };
    return { ...base, ...overrides[`${m.provider}/${m.id}`] };
  });
}
