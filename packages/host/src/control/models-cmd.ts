import { catalog, type ModelEntry, type EnumeratedModel } from "@spider/models";
import { MODEL_ROLES } from "@spider/ui";
import { controlConfig } from "../control.js";

function refOf(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

// Known-stale provider prefixes we've actually shipped by mistake -> their real pi
// provider id. `copilot` is not a provider id anywhere in spider or pi (the only
// `copilot` string in the tree is the unrelated embeddings backend in
// packages/ui/src/screens/config-schema.ts); the real id pi reports is `github-copilot`.
const STALE_PROVIDER_PREFIX: Record<string, string> = { copilot: "github-copilot" };

/** Normalise a known-stale provider prefix onto its corrected form, but ONLY when the
 *  corrected ref actually resolves in the live catalog -- otherwise leave it alone (so the
 *  caller's normal "unknown ref" rejection still applies to genuinely bad prefixes). A bare
 *  id (no `/`) or an already-correct ref passes through untouched. */
function normalizeStaleProvider(ref: string, models: ModelEntry[]): string {
  const slash = ref.indexOf("/");
  if (slash < 0) return ref;
  const corrected = STALE_PROVIDER_PREFIX[ref.slice(0, slash)];
  if (!corrected) return ref;
  const candidate = `${corrected}${ref.slice(slash)}`;
  return models.some((m) => refOf(m) === candidate) ? candidate : ref;
}

/** True when `ref` names a model the live catalog actually has: a fully-qualified
 *  `provider/id` match, or a bare id present under ANY provider. */
function isKnownRef(ref: string, models: ModelEntry[]): boolean {
  return models.some((m) => refOf(m) === ref || m.id === ref);
}

/** Persist a role→model default under `models.defaults`. Rejects an unknown role, and
 *  rejects a ref absent from the live catalog (listing the valid refs) -- models.defaults
 *  used to be write-only: `control models set` wrote it, `control models` displayed it back,
 *  and NOTHING ever validated or consumed it, so a bad ref just silently never resolved at
 *  spawn time. Known-stale provider prefixes (`copilot/` -> `github-copilot/`) are
 *  normalised first, before validation. */
export function setModelDefault(cwd: string, role: string, ref: string, models: ModelEntry[]): { ok: boolean; error?: string } {
  if (!MODEL_ROLES.includes(role)) {
    return { ok: false, error: `unknown role '${role}' (valid: ${MODEL_ROLES.join(", ")})` };
  }
  const normalized = normalizeStaleProvider(ref, models);
  if (!isKnownRef(normalized, models)) {
    const valid = models.map(refOf).join(", ");
    return { ok: false, error: `unknown model '${ref}' (valid: ${valid || "no models available"})` };
  }
  const cur = (controlConfig("get", cwd, "models.defaults") as Record<string, string> | undefined) ?? {};
  const next = { ...cur, [role]: normalized };
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
