import type { Tier } from "./catalog.js";
// Heuristic: id substrings + capability flags → tier. Deliberately NOT a hardcoded id whitelist
// (Copilot ids drift); host may override per-id via the `models.tierOverrides` config (A7).
export function deriveTier(id: string, flags: { reasoning?: boolean } = {}): Tier {
  const s = id.toLowerCase();
  if (flags.reasoning || /codex|o[1-9]\b|thinking|reason/.test(s)) return "reasoning";
  if (/nano/.test(s)) return "nano";
  if (/mini|haiku|flash|small/.test(s)) return "mini";
  if (/opus|gpt-5\.5|ultra|pro\b/.test(s)) return "capable";
  return "standard"; // sonnet, gpt-4.1/5.x, gemini-pro default
}
