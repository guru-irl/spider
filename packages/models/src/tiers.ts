import { normalizeModelId } from "./model-id";
// Tier is owned here (leaf) so catalog->tiers stays one-directional (no cycle).
export type Tier = "light" | "standard" | "heavy";
// Family heuristic id -> Tier (A8). Tier = model-quality lever; ThinkingLevel is orthogonal.
// Per-id override via models.tierOverrides (A7). NOT a hardcoded whitelist.
export function deriveTier(id: string): Tier {
  const s = normalizeModelId(id);
  if (/opus/.test(s)) return "heavy";
  if (/sonnet/.test(s)) return "standard";
  if (/luna|haiku|mai|flash/.test(s) || /(?:^|[-_.])(?:nano|mini|small)(?:[-_.]|$)/.test(s)) return "light";
  if (/gpt-5\.5|^gpt-6(?:\.\d+)*-astra(?:$|[-:])/.test(s)) return "heavy";
  return "standard"; // gpt-5.x / gemini pro / gpt-4.x default
}
