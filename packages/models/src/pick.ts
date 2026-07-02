// packages/models/src/pick.ts
import type { ModelEntry, Tier } from "./catalog.js";
export interface PickProfile { role?: string; complexity?: "low"|"med"|"high"; needsReasoning?: boolean; needsVision?: boolean; budget?: "cheap"|"normal"|"premium"; thinkingLevel?: string; model?: string; }
export interface ModelsConfig { autoSelect: boolean; defaults: Record<string,string>; tierOverrides: Record<string,Tier>; budgetCaps: Record<string,Tier>; }
const ORDER: Tier[] = ["nano", "mini", "standard", "capable", "reasoning"];
function targetTier(p: PickProfile): Tier {
  if (p.needsReasoning) return "reasoning";
  if (p.budget === "cheap" || p.complexity === "low") return "nano";
  if (p.budget === "premium" || p.complexity === "high") return "capable";
  return "standard";
}
export function pick(entries: ModelEntry[], profile: PickProfile, cfg: Partial<ModelsConfig> = {}): ModelEntry {
  const avail = entries.filter((e) => e.available);
  if (avail.length === 0) throw new Error("@spider/models: no available models");
  // 1) explicit override
  if (profile.model) {
    const hit = avail.find((e) => `${e.provider}/${e.id}` === profile.model || e.id === profile.model);
    if (hit) return hit;
  }
  // 2) config default (per role/kind)
  const key = profile.role;
  const def = key && cfg.defaults?.[key];
  if (def) {
    const hit = avail.find((e) => `${e.provider}/${e.id}` === def || e.id === def);
    if (hit) return hit;
  }
  // 3) policy: aim for target tier, degrade toward the nearest available (prefer down, then up)
  const want = targetTier(profile);
  if (profile.needsVision) { const v = avail.filter((e) => e.vision); if (v.length) return byTier(v, want); }
  return byTier(avail, want);
}
function byTier(list: ModelEntry[], want: Tier): ModelEntry {
  const wi = ORDER.indexOf(want);
  const sorted = [...list].sort((a, b) => Math.abs(ORDER.indexOf(a.tier) - wi) - Math.abs(ORDER.indexOf(b.tier) - wi) || b.speed - a.speed);
  return sorted[0];
}
export const DEFAULT_MODELS_CONFIG: ModelsConfig = { autoSelect: true, defaults: {}, tierOverrides: {}, budgetCaps: {} };
