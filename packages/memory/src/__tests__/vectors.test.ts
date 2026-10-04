import { describe, it, expect, afterEach, vi } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { upsertVector, knn, cosine, f32ToBlob, blobToF32, repairMissingVectors } from "../embeddings/vectors";
import * as vectors from "../embeddings/vectors";
import { onEmbeddingDiagnostic } from "../embeddings/drain-state";

let ctx: ReturnType<typeof makeMemDb>;
let unlog: (() => void) | undefined;
afterEach(() => { unlog?.(); unlog = undefined; vi.restoreAllMocks(); ctx?.cleanup(); });
const vec = (...xs: number[]) => Float32Array.from(xs);

describe("vectors", () => {
  it("stores 384-dimensional vectors in sqlite-vec and returns native KNN hits", () => {
    ctx = makeMemDb();
    const a = new Float32Array(384); a[0] = 1;
    const b = new Float32Array(384); b[1] = 1;
    upsertVector(ctx.db, "memory", "a", a, "BGE-small-en-v1.5");
    upsertVector(ctx.db, "memory", "b", b, "BGE-small-en-v1.5");
    ctx.db.loadVec();
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 2 });
    expect(ctx.db.prepare("SELECT rowid FROM vectors WHERE embedding MATCH ? AND k = 1")
      .all(f32ToBlob(a))).toEqual([{ rowid: 1 }]);
    expect(knn(ctx.db, a, 2, "memory").map(hit => hit.ownerId)).toEqual(["a", "b"]);
  });
  it("preserves native rowids beyond the JS safe integer range", () => {
    ctx = makeMemDb();
    const v = new Float32Array(384); v[0] = 1;
    ctx.db.prepare("INSERT INTO vector_map(rowid, owner_kind, owner_id, model, dim, embedding) VALUES (?, 'memory', 'seed', 'fixture', 384, ?)")
      .run(9007199254740992n, f32ToBlob(v));
    upsertVector(ctx.db, "content", "large", v, "fixture");
    expect(ctx.db.prepare("SELECT CAST(rowid AS TEXT) AS id FROM vectors").all())
      .toEqual([{ id: "9007199254740993" }]);
  });
  it("counts native errors, logs once per operation and preserves brute-force recall", () => {
    ctx = makeMemDb();
    const before = vectors.getVectorErrors();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages: string[] = []; unlog = onEmbeddingDiagnostic(message => messages.push(message));
    vi.spyOn(ctx.db, "loadVec").mockImplementation(() => { throw new Error("fixture native failure token=secretvalue"); });
    const v = new Float32Array(384); v[0] = 1;
    for (const id of ["a", "b"]) upsertVector(ctx.db, "memory", id, v, "fixture");
    for (let i = 0; i < 2; i++) {
      expect(knn(ctx.db, v, 1, "memory")[0].ownerId).toBe("a");
      expect(repairMissingVectors(ctx.db)).toBe(0);
    }
    const after = vectors.getVectorErrors();
    expect(after.insert).toBe(before.insert + 2);
    expect(after.knn).toBe(before.knn + 2);
    expect(after.repair).toBe(before.repair + 2);
    expect(after.lastError).toContain("fixture native failure");
    expect(after.lastError).not.toContain("secretvalue");
    expect(warn).not.toHaveBeenCalled();
    expect(messages).toHaveLength(3);
    expect(messages.every(message => message.includes("fixture native failure"))).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("secretvalue");
  });
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
