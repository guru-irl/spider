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

// Local enumerate over pi's model surface (matches extension.ts `enumerate`; inlined to keep
// control/models-cmd out of an import cycle with extension.ts).
function enumerate(pi: unknown): EnumeratedModel[] {
  const p = pi as { listModels?: () => unknown[]; availableModels?: unknown[] };
  const list = p.listModels?.() ?? p.availableModels ?? [];
  return (list as Array<Record<string, unknown>>).map((m) => ({
    provider: String(m.provider ?? m.providerId ?? ""),
    id: String(m.id ?? ""),
    available: m.available !== false,
    thinking: !!(m.thinking ?? m.reasoning),
    vision: !!m.vision,
    ctx: Number(m.contextWindow ?? 0) || undefined,
  }));
}

/** Build the copilot model catalog from pi's live model surface, degrading to [] on any error. */
export function listCatalog(pi: unknown): ModelEntry[] {
  try {
    return catalog(() => enumerate(pi));
  } catch {
    return [];
  }
}
