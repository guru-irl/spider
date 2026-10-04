import type { Embedder } from "@spider/memory";

// These fixtures enqueue memory but never drain embeddings, so KNN has no hits.
// Its recall results intentionally match a null embedder: no semantic ranking is tested.
// Keep the real recall/FTS path, without loading ONNX or downloading a model.
export const memoryTestEmbedder: Embedder = {
  model: "fixture",
  dim: 384,
  async embed(texts) {
    return texts.map(() => {
      const vector = new Float32Array(384);
      vector[0] = 1;
      return vector;
    });
  },
};
