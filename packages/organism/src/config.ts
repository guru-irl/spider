import type { PassName } from "./types.js";
import { CURATOR_DEFAULTS, type CuratorConfig } from "./curator.js";

/**
 * Organism master + per-pass toggles. `enabled` is the master kill-switch;
 * `passes` gates each digest pass individually; `selfNaming` allows the
 * consolidation self-name to flow to `projects.name`; `autoWriteBudget` caps
 * the per-drain staged writes.
 */
export interface OrganismConfig {
  enabled: boolean;
  passes: Record<PassName, boolean>;
  selfNaming: boolean;
  autoWriteBudget: number;
}

/** Ship defaults: everything on, budget 20 staged writes per drain. */
export const ORGANISM_DEFAULTS: OrganismConfig = {
  enabled: true,
  passes: {
    runMemoryTodo: true,
    todoMemory: true,
    learning: true,
    consolidation: true,
    reflection: true,
    insights: true,
  },
  selfNaming: true,
  autoWriteBudget: 20,
};

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function asNum(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function readField(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * Deep-merge `cfg.organism` over {@link ORGANISM_DEFAULTS}. `passes` is merged
 * key-by-key (unknown/missing keys fall back to the default); booleans/number
 * are coerced defensively. `cfg` is `unknown` — every access is guarded.
 */
export function readOrganismConfig(cfg: unknown): OrganismConfig {
  const org = readField(cfg, "organism");
  const passesRaw = readField(org, "passes");
  const passes = {} as Record<PassName, boolean>;
  for (const name of Object.keys(ORGANISM_DEFAULTS.passes) as PassName[]) {
    passes[name] = asBool(readField(passesRaw, name), ORGANISM_DEFAULTS.passes[name]);
  }
  return {
    enabled: asBool(readField(org, "enabled"), ORGANISM_DEFAULTS.enabled),
    passes,
    selfNaming: asBool(readField(org, "selfNaming"), ORGANISM_DEFAULTS.selfNaming),
    autoWriteBudget: asNum(readField(org, "autoWriteBudget"), ORGANISM_DEFAULTS.autoWriteBudget),
  };
}

/**
 * Deep-merge `cfg.curator` over {@link CURATOR_DEFAULTS}. Coerces
 * numbers/booleans defensively; unknown/missing keys fall back to the default.
 */
export function readCuratorConfig(cfg: unknown): CuratorConfig {
  const cur = readField(cfg, "curator");
  return {
    staleAfterDays: asNum(readField(cur, "staleAfterDays"), CURATOR_DEFAULTS.staleAfterDays),
    archiveAfterDays: asNum(readField(cur, "archiveAfterDays"), CURATOR_DEFAULTS.archiveAfterDays),
    minIntervalHours: asNum(readField(cur, "minIntervalHours"), CURATOR_DEFAULTS.minIntervalHours),
    consolidate: asBool(readField(cur, "consolidate"), CURATOR_DEFAULTS.consolidate),
  };
}
