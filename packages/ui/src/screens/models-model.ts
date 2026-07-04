import type { ModelEntry, Tier } from "@spider/models";

/** Subagent roles that carry a configurable model default (models.defaults.<role>). */
export const MODEL_ROLES: string[] = [
  "reviewer", "worker", "scout", "planner", "researcher",
  "oracle", "digest", "self_name", "upstream_watch",
];

/** Tier render order — light → standard → heavy. */
const TIER_ORDER: Tier[] = ["light", "standard", "heavy"];

/** One catalog row: a ModelEntry flattened with its provider/id ref and the roles it
 *  is the configured default for. */
export interface CatalogRow {
  provider: string; id: string; ref: string; tier: Tier;
  available: boolean; thinking: boolean; vision: boolean; isDefaultFor: string[];
}

/** A tier bucket of catalog rows (only non-empty tiers survive). */
export interface TierGroup { tier: Tier; rows: CatalogRow[]; }

/** Group model entries by tier (light→standard→heavy, empty groups dropped). Each row's
 *  `isDefaultFor` lists the roles in `defaults` whose value === that row's `ref`. */
export function catalogRows(entries: ModelEntry[], defaults: Record<string, string>): TierGroup[] {
  const groups: TierGroup[] = [];
  for (const tier of TIER_ORDER) {
    const rows: CatalogRow[] = [];
    for (const e of entries) {
      if (e.tier !== tier) continue;
      const ref = `${e.provider}/${e.id}`;
      const isDefaultFor = Object.keys(defaults).filter((role) => defaults[role] === ref);
      rows.push({ provider: e.provider, id: e.id, ref, tier: e.tier, available: e.available, thinking: e.thinking, vision: e.vision, isDefaultFor });
    }
    if (rows.length) groups.push({ tier, rows });
  }
  return groups;
}

/** Resolve a role's configured default ref — but only if that ref is still present AND
 *  available in `entries`; otherwise undefined (the config points at a vanished model). */
export function resolveDefault(defaults: Record<string, string>, role: string, entries: ModelEntry[]): string | undefined {
  const ref = defaults[role];
  if (!ref) return undefined;
  const hit = entries.find((e) => `${e.provider}/${e.id}` === ref);
  return hit && hit.available ? ref : undefined;
}
