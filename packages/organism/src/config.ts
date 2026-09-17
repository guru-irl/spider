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

/**
 * The staged-write budget must be a sane bound: a nonnegative finite
 * integer. Fractional, negative, NaN or infinite values are nonsensical
 * limits and fall back to `dflt` rather than being silently truncated.
 */
function asWriteBudget(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : dflt;
}

function readField(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * First-defined-wins between an explicit dotted `controlConfig` leaf (e.g.
 * `"organism.enabled"`, read as a literal top-level property of `cfg` — this
 * is exactly the flat shape `controlConfig("get", cwd)` returns) and the
 * legacy nested value (e.g. `cfg.organism.enabled`). The dotted leaf always
 * wins when both are present.
 */
function dottedOrNested(cfg: unknown, dottedKey: string, nested: unknown): unknown {
  const dotted = readField(cfg, dottedKey);
  return dotted !== undefined ? dotted : nested;
}

/**
 * Deep-merge `cfg.organism` (legacy nested shape) AND real dotted
 * `controlConfig` keys (`organism.enabled`, `organism.passes.<name>`,
 * `organism.selfNaming`, `organism.autoWriteBudget`) over
 * {@link ORGANISM_DEFAULTS}. `passes` is merged key-by-key (unknown/missing
 * keys fall back to the default); booleans/numbers are coerced defensively.
 * An explicit dotted leaf always overrides a conflicting nested/default
 * value. `cfg` is `unknown` — every access is guarded.
 */
export function readOrganismConfig(cfg: unknown): OrganismConfig {
  const org = readField(cfg, "organism");
  const passesRaw = readField(org, "passes");
  const passes = {} as Record<PassName, boolean>;
  for (const name of Object.keys(ORGANISM_DEFAULTS.passes) as PassName[]) {
    const value = dottedOrNested(cfg, `organism.passes.${name}`, readField(passesRaw, name));
    passes[name] = asBool(value, ORGANISM_DEFAULTS.passes[name]);
  }
  return {
    enabled: asBool(dottedOrNested(cfg, "organism.enabled", readField(org, "enabled")), ORGANISM_DEFAULTS.enabled),
    passes,
    selfNaming: asBool(
      dottedOrNested(cfg, "organism.selfNaming", readField(org, "selfNaming")),
      ORGANISM_DEFAULTS.selfNaming,
    ),
    autoWriteBudget: asWriteBudget(
      dottedOrNested(cfg, "organism.autoWriteBudget", readField(org, "autoWriteBudget")),
      ORGANISM_DEFAULTS.autoWriteBudget,
    ),
  };
}

/**
 * Deep-merge `cfg.curator` (legacy nested shape) AND real dotted
 * `controlConfig` keys (`curator.staleAfterDays`, `curator.archiveAfterDays`,
 * `curator.minIntervalHours`, `curator.consolidate`) over
 * {@link CURATOR_DEFAULTS}. Coerces numbers/booleans defensively; an explicit
 * dotted leaf always overrides a conflicting nested/default value.
 */
export function readCuratorConfig(cfg: unknown): CuratorConfig {
  const cur = readField(cfg, "curator");
  return {
    staleAfterDays: asNum(
      dottedOrNested(cfg, "curator.staleAfterDays", readField(cur, "staleAfterDays")),
      CURATOR_DEFAULTS.staleAfterDays,
    ),
    archiveAfterDays: asNum(
      dottedOrNested(cfg, "curator.archiveAfterDays", readField(cur, "archiveAfterDays")),
      CURATOR_DEFAULTS.archiveAfterDays,
    ),
    minIntervalHours: asNum(
      dottedOrNested(cfg, "curator.minIntervalHours", readField(cur, "minIntervalHours")),
      CURATOR_DEFAULTS.minIntervalHours,
    ),
    consolidate: asBool(
      dottedOrNested(cfg, "curator.consolidate", readField(cur, "consolidate")),
      CURATOR_DEFAULTS.consolidate,
    ),
  };
}
