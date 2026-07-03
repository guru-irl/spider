// packages/host/src/__tests__/embeddings.test.ts
import { describe, it, expect } from "vitest";
import { embeddingConfig, isEmbedderLoaded } from "../embeddings";

describe("embeddings wiring (lazy, no download in Phase 0)", () => {
  it("reports the default provider/model/dim", () => {
    expect(embeddingConfig()).toEqual({ provider: "fastembed", model: "BGE-small-en-v1.5", dim: 384 });
  });

  it("does NOT load the embedder at import time", () => {
    // Importing the module must not construct a FlagEmbedding / download a model.
    expect(isEmbedderLoaded()).toBe(false);
  });
});
