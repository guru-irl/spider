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

/** Read pi's available-model list defensively (listModels() → availableModels → []). */
export function listPiModels(pi: unknown): ListedModel[] {
  try {
    const p = pi as { listModels?: () => ListedModel[]; availableModels?: ListedModel[] };
    return p?.listModels?.() ?? p?.availableModels ?? [];
  } catch {
    return [];
  }
}
