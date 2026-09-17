import type { ModelEntry } from "./catalog";
import type { PickResult } from "./pick";
import type { Db } from "@spider/db-core";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface CompleteOpts {
  system?: string;
  thinkingLevel?: string;
  maxTokens?: number;
  /**
   * Authenticated pi ModelRegistry (or a stand-in exposing just find/complete).
   * Required for the default (non-CompleteDeps) path — production callers must
   * supply the real registry from ExtensionContext (ctx.modelRegistry).
   */
  registry?: Pick<ModelRegistry, "find" | "complete">;
  /** Forwarded to registry.complete() so callers can cancel in-flight requests. */
  signal?: AbortSignal;
}
export interface CompleteDeps {
  getModel: (provider: string, id: string) => unknown;
  run: (model: unknown, prompt: string, opts: CompleteOpts) => Promise<string>;
}
// Accepts a bare ModelEntry OR a pick() PickResult — when given a PickResult, pick's resolved
// thinkingLevel is threaded into the runner automatically (explicit opts.thinkingLevel still wins).
//
// Two seams:
//  - `deps` (CompleteDeps): explicit injection kept for existing callers/tests. Unchanged shape.
//  - default path (no deps): uses `opts.registry`, a pi ModelRegistry (Pick<'find'|'complete'>).
//    This is the production path — it resolves the FULL handle via registry.find() (so custom
//    model/provider configuration on the resolved handle is preserved) and calls
//    registry.complete(handle, context, options), the public authenticated completion API in
//    pi 0.85.1. There is no unauthenticated fallback: a missing registry or an unresolvable
//    model is a thrown, actionable error, never a silent/empty success.
export async function complete(model: ModelEntry | PickResult, prompt: string, opts: CompleteOpts = {}, deps?: CompleteDeps): Promise<string> {
  const entry = "entry" in model ? model.entry : model;
  const pickedThinking = "entry" in model ? model.thinkingLevel : undefined;
  const thinkingLevel = opts.thinkingLevel ?? pickedThinking;
  const mergedOpts: CompleteOpts = { ...opts, thinkingLevel };

  if (deps) {
    const handle = deps.getModel(entry.provider, entry.id);
    return deps.run(handle, prompt, mergedOpts);
  }

  return completeViaRegistry(entry, prompt, mergedOpts);
}

async function completeViaRegistry(entry: ModelEntry, prompt: string, opts: CompleteOpts): Promise<string> {
  const registry = opts.registry;
  if (!registry) {
    throw new Error(
      `@spider/models: complete() has no CompleteDeps and no opts.registry for ${entry.provider}/${entry.id}. ` +
        `Pass the authenticated ModelRegistry (e.g. ctx.modelRegistry) — there is no unauthenticated fallback.`,
    );
  }

  const handle = registry.find(entry.provider, entry.id);
  if (!handle) {
    throw new Error(`@spider/models: model not found in registry: ${entry.provider}/${entry.id}`);
  }

  const context = {
    systemPrompt: opts.system,
    messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
  };

  // ModelsApiStreamOptions<TApi> is per-API-literal (each provider's option type is different).
  // The widened Model<Api> handle returned by find() resolves the generic fallback branch
  // (StreamOptions & Record<string, unknown>), where reasoningEffort lives for OpenAI-family
  // options types. Cast at this one narrow boundary rather than hiding the whole module's types.
  const message = await registry.complete(handle, context, {
    reasoningEffort: opts.thinkingLevel,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
  } as Parameters<typeof registry.complete>[2]);

  if (message.stopReason === "aborted") {
    throw new Error(`@spider/models: completion aborted for ${entry.provider}/${entry.id}${message.errorMessage ? `: ${message.errorMessage}` : ""}`);
  }
  if (message.stopReason === "error") {
    throw new Error(`@spider/models: completion error for ${entry.provider}/${entry.id}: ${message.errorMessage ?? "unknown error"}`);
  }

  const text = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  if (!text) {
    throw new Error(`@spider/models: completion for ${entry.provider}/${entry.id} returned no text content (stopReason=${message.stopReason})`);
  }

  return text;
}

export function recordModelStat(db: Db, s: { model: string; ms: number; ok: boolean; tokens: number }): void {
  db.prepare("INSERT INTO model_stats (model, ms, ok, tokens, ts) VALUES (?, ?, ?, ?, ?)")
    .run(s.model, s.ms, s.ok ? 1 : 0, s.tokens, Date.now());
}
