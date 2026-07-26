import { catalog, type ModelEntry, type EnumeratedModel } from "@spider/models";
import { MODEL_ROLES } from "@spider/ui";
import { controlConfig } from "../control.js";

/** Persist a role→model default under `models.defaults`. Rejects unknown roles; otherwise
 *  merges into the existing map and writes it back through controlConfig. */
export function setModelDefault(cwd: string, role: string, ref: string): { ok: boolean; error?: string } {
  if (!MODEL_ROLES.includes(role)) {
    return { ok: false, error: `unknown role '${role}' (valid: ${MODEL_ROLES.join(", ")})` };
  }
  const cur = (controlConfig("get", cwd, "models.defaults") as Record<string, string> | undefined) ?? {};
  const next = { ...cur, [role]: ref };
  controlConfig("set", cwd, "models.defaults", next);
  return { ok: true };
}

// Enumerate over pi's real model surface. `modelRegistry` is a ModelRegistry
// (dist/core/model-registry.d.ts) exposed on the ExtensionContext — NOT on the extension
// API object. This previously read `pi.listModels()` / `pi.availableModels`, neither of
// which exists anywhere in pi, so the catalog was silently always empty.
//
// Field names are pi's, not ours: `reasoning` (not `thinking`), and vision is derived from
// `input` containing "image" (there is no `vision` flag). Availability is not a property on
// the model at all — it is membership in getAvailable().
function enumerate(registry: unknown): EnumeratedModel[] {
  const r = registry as {
    getAll?: () => unknown[];
    getAvailable?: () => unknown[];
  } | undefined;
  if (typeof r?.getAll !== "function") return [];

  const all = (r.getAll() ?? []) as Array<Record<string, unknown>>;
  const availableKeys = new Set<string>();
  if (typeof r.getAvailable === "function") {
    for (const m of (r.getAvailable() ?? []) as Array<Record<string, unknown>>) {
      availableKeys.add(`${String(m.provider ?? "")}/${String(m.id ?? "")}`);
    }
  }
  const hasAvailability = typeof r.getAvailable === "function";

  return all.map((m) => {
    const provider = String(m.provider ?? "");
    const id = String(m.id ?? "");
    const input = Array.isArray(m.input) ? (m.input as unknown[]).map(String) : [];
    return {
      provider,
      id,
      available: hasAvailability ? availableKeys.has(`${provider}/${id}`) : true,
      thinking: !!m.reasoning,
      vision: input.includes("image"),
      ctx: Number(m.contextWindow ?? 0) || undefined,
    };
  });
}

/** Build the model catalog from pi's live registry, degrading to [] on any error.
 *  Pass the ExtensionContext's `modelRegistry`, not the extension API. */
export function listCatalog(registry: unknown): ModelEntry[] {
  try {
    return catalog(() => enumerate(registry));
  } catch {
    return [];
  }
}
