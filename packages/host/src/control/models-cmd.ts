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

// Enumerate the models the user can ACTUALLY USE.
//
// pi exposes two methods and they are wildly different: getAll() is the entire models.json
// provider catalogue (~800 entries across bedrock/openrouter/vertex/... , nearly all
// unusable), while getAvailable() is filtered to providers with configured auth -- i.e.
// what the subscription actually grants. `spider control models` is a "what can I run?"
// question, so getAvailable() is the correct source. getAll() is kept only as a fallback
// for hosts that predate it.
//
// Field names are pi's, not ours: `reasoning` (not `thinking`), and vision is derived from
// `input` containing "image" (there is no `vision` flag).
function enumerate(registry: unknown): EnumeratedModel[] {
  const r = registry as {
    getAll?: () => unknown[];
    getAvailable?: () => unknown[];
  } | undefined;

  const source =
    typeof r?.getAvailable === "function" ? r.getAvailable()
    : typeof r?.getAll === "function" ? r.getAll()
    : undefined;
  if (!source) return [];

  return (source as Array<Record<string, unknown>>).map((m) => {
    const input = Array.isArray(m.input) ? (m.input as unknown[]).map(String) : [];
    return {
      provider: String(m.provider ?? ""),
      id: String(m.id ?? ""),
      available: true, // by construction: everything here is usable
      thinking: !!m.reasoning,
      vision: input.includes("image"),
      ctx: Number(m.contextWindow ?? 0) || undefined,
    };
  });
}

/** Build the catalog of USABLE models from pi's live registry, degrading to [] on any error.
 *  Pass the ExtensionContext's `modelRegistry`, not the extension API. */
export function listCatalog(registry: unknown): ModelEntry[] {
  try {
    return catalog(() => enumerate(registry));
  } catch {
    return [];
  }
}
