// packages/host/src/embeddings.ts
import { resolveEmbedder, type Embedder } from "@spider/memory";
export { isEmbedderLoaded } from "@spider/memory";

export interface EmbeddingConfig { provider: string; model: string; dim: number; }

export function embeddingConfig(): EmbeddingConfig {
  // Phase 0: static defaults (config precedence lands via control.ts in Phase 1+).
  return { provider: "fastembed", model: "BGE-small-en-v1.5", dim: 384 };
}

/** Legacy entry point; all consumers share the process-wide model and adapter. */
export const loadEmbedder: () => Promise<Embedder | null> = resolveEmbedder;
