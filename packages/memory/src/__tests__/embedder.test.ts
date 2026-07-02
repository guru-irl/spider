import { describe, it, expect } from "vitest";
import { resolveEmbedder, EMBED_DIM } from "../embeddings/embedder.js";

describe("embedder", () => {
  it("never throws and reports dim=384 when available (else null → FTS degrade)", async () => {
    const e = await resolveEmbedder({ modelsDir: undefined });
    if (e) {
      expect(e.dim).toBe(EMBED_DIM);
      const [v] = await e.embed(["hello world"]);
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(EMBED_DIM);
    } else {
      expect(e).toBeNull(); // degrade-to-FTS path
    }
  }, 120_000);
});
