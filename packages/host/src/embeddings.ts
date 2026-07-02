// packages/host/src/embeddings.ts
import { createRequire } from "node:module";
import { paths } from "@spider/db-core";

const require = createRequire(import.meta.url);

export interface EmbeddingConfig { provider: string; model: string; dim: number; }

export function embeddingConfig(): EmbeddingConfig {
  // Phase 0: static defaults (config precedence lands via control.ts in Phase 1+).
  return { provider: "fastembed", model: "BGE-small-en-v1.5", dim: 384 };
}

let _embedder: unknown | null = null;

export function isEmbedderLoaded(): boolean {
  return _embedder !== null;
}

/**
 * Lazily construct the fastembed FlagEmbedding. NOT called anywhere in Phase 0 —
 * memory/search phases invoke it. Kept here so the dependency graph and cache
 * dir (~/.pi/agent/spider/models) are wired now.  First call downloads the model.
 */
export async function loadEmbedder(): Promise<unknown> {
  if (_embedder) return _embedder;
  const { FlagEmbedding, EmbeddingModel } = require("fastembed") as {
    FlagEmbedding: { init(opts: { model: unknown; cacheDir: string }): Promise<unknown> };
    EmbeddingModel: Record<string, unknown>;
  };
  _embedder = await FlagEmbedding.init({
    model: EmbeddingModel.BGESmallENV15,
    cacheDir: paths.models,
  });
  return _embedder;
}
