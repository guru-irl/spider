import { describe, it, expect, afterEach, vi } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { enqueueEmbed, drainEmbedQueue, startEmbedWorker } from "../embeddings/queue";
import { knn } from "../embeddings/vectors";
import type { Embedder } from "../embeddings/embedder";

let ctx: ReturnType<typeof makeMemDb>;
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); ctx?.cleanup(); });

const fakeEmbedder: Embedder = {
  model: "BGE-small-en-v1.5", dim: 3,
  async embed(texts) { return texts.map(t => Float32Array.from([t.length, t.includes("a") ? 1 : 0, 0])); },
};

describe("embed queue", () => {
  it("keeps queued writes while initialization is pending, then retries and drains", async () => {
    vi.useFakeTimers();
    ctx = makeMemDb();
    enqueueEmbed(ctx.db, "memory", "pending-model", "banana");
    let attempts = 0;
    stop = startEmbedWorker(ctx.db, () => ++attempts === 1 ? new Promise(() => {}) : Promise.resolve(fakeEmbedder), { intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number }).c).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number }).c).toBe(0);
    expect(knn(ctx.db, Float32Array.from([6, 1, 0]), 1, "memory")[0].ownerId).toBe("pending-model");
  });
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
