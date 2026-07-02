import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb.js";
import { enqueueEmbed, drainEmbedQueue } from "../embeddings/queue.js";
import { knn } from "../embeddings/vectors.js";
import type { Embedder } from "../embeddings/embedder.js";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

const fakeEmbedder: Embedder = {
  model: "BGE-small-en-v1.5", dim: 3,
  async embed(texts) { return texts.map(t => Float32Array.from([t.length, t.includes("a") ? 1 : 0, 0])); },
};

describe("embed queue", () => {
  it("drains queued rows into vectors", async () => {
    ctx = makeMemDb();
    enqueueEmbed(ctx.db, "memory", "m1", "banana");
    const n = await drainEmbedQueue(ctx.db, fakeEmbedder, 10);
    expect(n).toBe(1);
    const remaining = ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number };
    expect(remaining.c).toBe(0);
    expect(knn(ctx.db, Float32Array.from([6, 1, 0]), 1, "memory")[0].ownerId).toBe("m1");
  });
  it("leaves rows and returns 0 when embedder is null (FTS degrade)", async () => {
    ctx = makeMemDb();
    enqueueEmbed(ctx.db, "memory", "m2", "cherry");
    expect(await drainEmbedQueue(ctx.db, null, 10)).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number }).c).toBe(1);
  });
});
