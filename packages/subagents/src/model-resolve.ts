/**
 * Resolve a subagent model id to a provider-qualified ref.
 *
 * A bare model id (e.g. "claude-sonnet-5") is passed verbatim to the child pi as
 * `--model claude-sonnet-5`, which pi resolves to its DEFAULT provider for that
 * family (e.g. "anthropic"). If that provider isn't authenticated in the child's
 * environment the child dies at startup with "No API key found for <provider>" —
 * and because the spawner uses stdio:"ignore" the failure is silent (the run still
 * reports "done" with no output). Qualifying the id with the provider that pi
 * actually lists as AVAILABLE (e.g. "github-copilot/claude-sonnet-5") routes the
 * child to an authenticated provider. Already-qualified refs pass through untouched.
 */
export interface ListedModel {
  provider?: string;
  providerId?: string;
  id: string;
  available?: boolean;
}

export function qualifyModelProvider(model: string | undefined, list: ListedModel[]): string | undefined {
  if (!model) return model; // undefined / "" pass through
  if (model.includes("/")) return model; // already provider-qualified
  try {
    const matches = (list ?? []).filter((m) => m.id === model || m.id.endsWith(`/${model}`));
    const pick = matches.find((m) => m.available !== false) ?? matches[0];
    if (!pick) return model;
    if (pick.id.includes("/")) return pick.id; // list already carries a qualified id
    const provider = pick.provider ?? pick.providerId;
    return provider ? `${provider}/${model}` : model;
  } catch {
    return model;
  }
}

/** Read pi's model list from the ModelRegistry on the ExtensionContext.
 *
 *  This used to read `pi.listModels()` / `pi.availableModels`. NEITHER EXISTS anywhere in
 *  pi — the real surface is `ExtensionContext.modelRegistry`, a ModelRegistry with
 *  `getAll()` / `getAvailable()` (dist/core/model-registry.d.ts). So this always returned
 *  [], `qualifyModelProvider` never found a match, and every bare model id was passed to
 *  the child unqualified — exactly the silent "No API key found" death this module exists
 *  to prevent. Passing provider-qualified refs by hand was a workaround for this bug.
 *
 *  Availability is membership in getAvailable(), not a field on the model. */
export function listPiModels(registry: unknown): ListedModel[] {
  try {
    const r = registry as { getAll?: () => unknown[]; getAvailable?: () => unknown[] } | undefined;
    if (typeof r?.getAll !== "function") return [];
    const availableKeys = new Set<string>();
    const hasAvailability = typeof r.getAvailable === "function";
    if (hasAvailability) {
      for (const m of (r.getAvailable!() ?? []) as Array<Record<string, unknown>>) {
        availableKeys.add(`${String(m.provider ?? "")}/${String(m.id ?? "")}`);
      }
    }
    return ((r.getAll() ?? []) as Array<Record<string, unknown>>).map((m) => {
      const provider = String(m.provider ?? "");
      const id = String(m.id ?? "");
      return {
        provider,
        id,
        available: hasAvailability ? availableKeys.has(`${provider}/${id}`) : true,
      };
    });
  } catch {
    return [];
  }
}
