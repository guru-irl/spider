import type { ModelEntry, Tier, ThinkingLevel } from "./catalog";
import { TIER_PREFERENCE } from "./catalog";
import { normalizeModelId } from "./model-id";
import { stripThinkingSuffix, thinkingFromModel, THINKING_LEVELS } from "@spider/db-core";
export interface PickProfile { role?: string; tier?: Tier; complexity?: "low"|"med"|"high"; budget?: "cheap"|"normal"|"premium"; needsVision?: boolean; thinkingLevel?: ThinkingLevel; model?: string; }
export interface PickResult { entry: ModelEntry; thinkingLevel: ThinkingLevel; }
export interface ModelsConfig { autoSelect: boolean; defaults: Record<string,string>; tierOverrides: Record<string,Tier>; tierPreference: Record<Tier,string[]>; thinkingDefaults: Record<string,ThinkingLevel>; }
const TIER_ORDER: Tier[] = ["light", "standard", "heavy"];
// Reuse the shared enum values so the production duplicate-enum guard stays meaningful.
const thinking = Object.fromEntries(THINKING_LEVELS.map(level => [level, level])) as Record<ThinkingLevel, ThinkingLevel>;
const DEFAULT_THINKING: Record<Tier, ThinkingLevel> = { light: thinking.low, standard: thinking.high, heavy: thinking.medium };
export const ROLE_POLICY: Record<string, { tier: Tier; thinking: ThinkingLevel }> = {
  worker: { tier: "standard", thinking: thinking.high },
  planner: { tier: "standard", thinking: thinking.high },
  researcher: { tier: "standard", thinking: thinking.high },
  oracle: { tier: "heavy", thinking: thinking.medium },
  reviewer: { tier: "heavy", thinking: thinking.high },
  scout: { tier: "light", thinking: thinking.low },
  digest: { tier: "light", thinking: thinking.low },
  self_name: { tier: "light", thinking: thinking.low },
  upstream_watch: { tier: "light", thinking: thinking.low },
};
function effectiveTier(e: ModelEntry, cfg: Partial<ModelsConfig>): Tier {
  return cfg.tierOverrides?.[`${e.provider}/${e.id}`] ?? cfg.tierOverrides?.[e.id] ?? e.tier;
}
function targetTier(p: PickProfile): Tier {
  if (p.tier) return p.tier;
  if (p.budget === "premium" || p.complexity === "high") return "heavy";
  if (p.budget === "cheap" || p.complexity === "low") return "light";
  return (p.role ? ROLE_POLICY[p.role]?.tier : undefined) ?? "standard";
}
function resolveThinking(p: PickProfile, tier: Tier, cfg: Partial<ModelsConfig>): ThinkingLevel {
  return p.thinkingLevel ?? (p.role ? cfg.thinkingDefaults?.[p.role] : undefined)
    ?? (p.role ? ROLE_POLICY[p.role]?.thinking : undefined) ?? cfg.thinkingDefaults?.[tier] ?? DEFAULT_THINKING[tier];
}
function matches(e: ModelEntry, id: string): boolean {
  return `${e.provider}/${e.id}` === id || e.id === id;
}
function matchesPreference(e: ModelEntry, ref: string): boolean {
  if (matches(e, ref)) return true;
  const slash = ref.indexOf("/");
  if (slash >= 0 && e.provider !== ref.slice(0, slash)) return false;
  return normalizeModelId(e.id) === normalizeModelId(ref);
}
function excludedFromAutomaticSelection(id: string): boolean {
  // Moving aliases can silently start naming an excluded family. Explicit pins still work.
  return id.startsWith("~") || /-latest$/.test(normalizeModelId(id))
    || /^(?:claude-sonnet-5\.5(?:[-:]|$)|gpt-5(?:[.-]|$)|gpt-6(?:\.\d+)*-terra(?:[-:]|$))/.test(normalizeModelId(id));
}
const FALLBACK_FAMILIES: Record<Tier, RegExp[]> = {
  light: [/^gpt-(6(?:\.\d+)*)-luna(?:$|[-:])/, /^claude-haiku-(\d+(?:\.\d+)*)(?:$|[-:])/],
  standard: [/^gpt-(6(?:\.\d+)*)-sol(?:$|[-:])/, /^claude-sonnet-(\d+(?:\.\d+)*)(?:$|[-:])/],
  heavy: [/^claude-opus-(\d+(?:\.\d+)*)(?:$|[-:])/, /^gpt-(6(?:\.\d+)*)-astra(?:$|[-:])/],
};
// Prefer a base id over a dated deployment or batch variant of the same version.
function preferBaseId(a: ModelEntry, b: ModelEntry): number { return a.id.length - b.id.length; }
function newestFamily(entries: ModelEntry[], tier: Tier): ModelEntry | undefined {
  for (const family of FALLBACK_FAMILIES[tier]) {
    const candidates = entries.flatMap(entry => {
      const version = normalizeModelId(entry.id).match(family)?.[1];
      return version ? [{ entry, version }] : [];
    });
    candidates.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true })
      || preferBaseId(a.entry, b.entry));
    if (candidates.length) return candidates[0].entry;
  }
  return undefined;
}
export function pick(entries: ModelEntry[], profile: PickProfile, cfg: Partial<ModelsConfig> = {}): PickResult {
  const avail = entries.filter((e) => e.available && (!profile.needsVision || e.vision));
  if (avail.length === 0) throw new Error("@spider/models: no available models");
  const result = (entry: ModelEntry, tier: Tier, pinned?: string): PickResult => ({ entry, thinkingLevel: resolveThinking({ ...profile, thinkingLevel: profile.thinkingLevel ?? thinkingFromModel(pinned) }, tier, cfg) });
  // Explicit model and configured role pins can name any model, including excluded families.
  if (profile.model) {
    const hit = avail.find((e) => matches(e, stripThinkingSuffix(profile.model)!));
    if (hit) return result(hit, effectiveTier(hit, cfg), profile.model);
  }
  const def = profile.role ? cfg.defaults?.[profile.role] : undefined;
  if (def) {
    const hit = avail.find((e) => matches(e, stripThinkingSuffix(def)!));
    if (hit) return result(hit, effectiveTier(hit, cfg), def);
  }
  const automatic = avail.filter(e => !excludedFromAutomaticSelection(e.id));
  if (!automatic.length) throw new Error("@spider/models: no eligible models for automatic selection");
  // Explicit tier preferences, newest matching family, any-of-tier, then nearest tier.
  const wi = TIER_ORDER.indexOf(targetTier(profile));
  const visitOrder: number[] = [wi];
  for (let d = 1; d < TIER_ORDER.length; d++) visitOrder.push(wi - d, wi + d);
  for (const ti of visitOrder) {
    if (ti < 0 || ti >= TIER_ORDER.length) continue;
    const tier = TIER_ORDER[ti];
    const prefs = cfg.tierPreference?.[tier] ?? TIER_PREFERENCE[tier];
    for (const id of prefs) {
      const hit = automatic.filter((e) => matchesPreference(e, id) && effectiveTier(e, cfg) === tier).sort(preferBaseId)[0];
      if (hit) return result(hit, tier);
    }
    const family = newestFamily(automatic.filter(e => effectiveTier(e, cfg) === tier), tier);
    if (family) return result(family, tier);
    const anyOfTier = automatic.find((e) => effectiveTier(e, cfg) === tier);
    if (anyOfTier) return result(anyOfTier, tier);
  }
  // Every valid tier was visited above. Only invalid runtime tier overrides reach here.
  throw new Error("@spider/models: no eligible models in configured tiers");
}
export const DEFAULT_MODELS_CONFIG: ModelsConfig = { autoSelect: true, defaults: {}, tierOverrides: {}, tierPreference: TIER_PREFERENCE, thinkingDefaults: { ...DEFAULT_THINKING, ...Object.fromEntries(Object.entries(ROLE_POLICY).map(([role, policy]) => [role, policy.thinking])) } };

/** Resolve shipped roles for both control display and dispatch. Configured pins stay verbatim. */
export function resolveRoleDefaults(entries: ModelEntry[], configured: Record<string, string> = {}): Record<string, string> {
  const defaults = { ...configured };
  for (const role of Object.keys(ROLE_POLICY)) {
    if (defaults[role] !== undefined) continue;
    try {
      const selected = pick(entries, { role });
      defaults[role] = `${selected.entry.provider}/${selected.entry.id}:${selected.thinkingLevel}`;
    } catch { /* No eligible catalog entry: no built-in default can be reported. */ }
  }
  return defaults;
}
