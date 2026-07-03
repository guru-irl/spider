import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { upsertVector, knn, cosine, f32ToBlob, blobToF32 } from "../embeddings/vectors";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());
const vec = (...xs: number[]) => Float32Array.from(xs);

describe("vectors", () => {
  it("round-trips float32 blobs", () => {
    const v = vec(0.1, -0.2, 0.3);
    expect(Array.from(blobToF32(f32ToBlob(v)))).toEqual(Array.from(v));
  });
  it("cosine of identical vectors is ~1", () => {
    expect(cosine(vec(1, 0, 0), vec(1, 0, 0))).toBeCloseTo(1, 5);
  });
  it("KNN returns nearest owner first (brute-force path always correct)", () => {
    ctx = makeMemDb();
    upsertVector(ctx.db, "memory", "a", vec(1, 0, 0), "BGE-small-en-v1.5");
    upsertVector(ctx.db, "memory", "b", vec(0, 1, 0), "BGE-small-en-v1.5");
    const hits = knn(ctx.db, vec(0.9, 0.1, 0), 2, "memory");
    expect(hits[0].ownerId).toBe("a");
  });
});
