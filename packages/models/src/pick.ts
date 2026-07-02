import type { ModelEntry, Tier, ThinkingLevel } from "./catalog.js";
import { TIER_PREFERENCE } from "./catalog.js";
export interface PickProfile { role?: string; tier?: Tier; complexity?: "low"|"med"|"high"; budget?: "cheap"|"normal"|"premium"; needsVision?: boolean; thinkingLevel?: ThinkingLevel; model?: string; }
export interface PickResult { entry: ModelEntry; thinkingLevel: ThinkingLevel; }
export interface ModelsConfig { autoSelect: boolean; defaults: Record<string,string>; tierOverrides: Record<string,Tier>; tierPreference: Record<Tier,string[]>; thinkingDefaults: Record<string,ThinkingLevel>; }
const TIER_ORDER: Tier[] = ["light", "standard", "heavy"];
const DEFAULT_THINKING: Record<Tier, ThinkingLevel> = { light: "low", standard: "medium", heavy: "low" };
function effectiveTier(e: ModelEntry, cfg: Partial<ModelsConfig>): Tier {
  return cfg.tierOverrides?.[`${e.provider}/${e.id}`] ?? cfg.tierOverrides?.[e.id] ?? e.tier;
}
function targetTier(p: PickProfile): Tier {
  if (p.tier) return p.tier;
  if (p.budget === "premium" || p.complexity === "high") return "heavy";
  if (p.budget === "cheap" || p.complexity === "low") return "light";
  return "standard";
}
function resolveThinking(p: PickProfile, tier: Tier, cfg: Partial<ModelsConfig>): ThinkingLevel {
  return p.thinkingLevel ?? cfg.thinkingDefaults?.[tier] ?? DEFAULT_THINKING[tier];
}
function matches(e: ModelEntry, id: string): boolean {
  return `${e.provider}/${e.id}` === id || e.id === id;
}
export function pick(entries: ModelEntry[], profile: PickProfile, cfg: Partial<ModelsConfig> = {}): PickResult {
  const avail = entries.filter((e) => e.available && (!profile.needsVision || e.vision));
  if (avail.length === 0) throw new Error("@spider/models: no available models");
  const result = (entry: ModelEntry, tier: Tier): PickResult => ({ entry, thinkingLevel: resolveThinking(profile, tier, cfg) });
  // 1) explicit model
  if (profile.model) {
    const hit = avail.find((e) => matches(e, profile.model!));
    if (hit) return result(hit, effectiveTier(hit, cfg));
  }
  // 2) role default
  const def = profile.role ? cfg.defaults?.[profile.role] : undefined;
  if (def) {
    const hit = avail.find((e) => matches(e, def));
    if (hit) return result(hit, effectiveTier(hit, cfg));
  }
  // 3) tier preference-order (first available) -> any-of-tier -> degrade to nearest tier
  const wi = TIER_ORDER.indexOf(targetTier(profile));
  const visitOrder: number[] = [wi];
  for (let d = 1; d < TIER_ORDER.length; d++) visitOrder.push(wi - d, wi + d);
  for (const ti of visitOrder) {
    if (ti < 0 || ti >= TIER_ORDER.length) continue;
    const tier = TIER_ORDER[ti];
    const prefs = cfg.tierPreference?.[tier] ?? TIER_PREFERENCE[tier];
    for (const id of prefs) {
      const hit = avail.find((e) => matches(e, id));
      if (hit) return result(hit, tier);
    }
    const anyOfTier = avail.find((e) => effectiveTier(e, cfg) === tier);
    if (anyOfTier) return result(anyOfTier, tier);
  }
  // 4) last resort: fastest available
  const fastest = [...avail].sort((a, b) => b.speed - a.speed)[0];
  return result(fastest, effectiveTier(fastest, cfg));
}
export const DEFAULT_MODELS_CONFIG: ModelsConfig = { autoSelect: true, defaults: {}, tierOverrides: {}, tierPreference: TIER_PREFERENCE, thinkingDefaults: { ...DEFAULT_THINKING } };
