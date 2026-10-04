import { describe, it, expect, afterEach, vi } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { enqueueEmbed, drainEmbedQueue } from "../embeddings/queue";
import { knn, getVectorState } from "../embeddings/vectors";
import type { Embedder } from "../embeddings/embedder";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => { vi.useRealTimers(); ctx?.cleanup(); });

const fakeEmbedder: Embedder = {
  model: "BGE-small-en-v1.5", dim: 384,
  async embed(texts) { return texts.map(t => { const v = new Float32Array(384); v[0] = t.length; v[1] = t.includes("a") ? 1 : 0; return v; }); },
};

function queueMemory(id: string, text: string): void {
  ctx.db.prepare("INSERT OR IGNORE INTO memory(uuid, category, content, status, created_at) VALUES (?, 'insight', ?, 'active', 1)").run(id, text);
  enqueueEmbed(ctx.db, "memory", id, text);
}

describe("embed queue", () => {
  it("repairs missing native rows in bounded idempotent batches without an embedder", async () => {
    ctx = makeMemDb();
    ctx.db.loadVec();
    const v = new Float32Array(384); v[0] = 1;
    const blob = Buffer.from(v.buffer);
    const insert = ctx.db.prepare("INSERT INTO vector_map(owner_kind, owner_id, model, dim, embedding) VALUES (?, ?, 'fixture', ?, ?)");
    for (const [i, kind] of ["memory", "content", "session", "run", "memory"].entries()) {
      if (kind === "memory") ctx.db.prepare("INSERT INTO memory(uuid,category,content,status,created_at) VALUES (?, 'insight', 'fixture', 'active', 1)").run(String(i));
      insert.run(kind, String(i), 384, blob);
    }
    for (const id of ["small", "missing", "truncated"]) ctx.db.prepare("INSERT INTO memory(uuid,category,content,status,created_at) VALUES (?, 'insight', 'fixture', 'active', 1)").run(id);
    insert.run("memory", "small", 3, Buffer.from(new Float32Array(3).buffer));
    insert.run("memory", "missing", 384, null);
    insert.run("memory", "truncated", 384, Buffer.alloc(4));
    ctx.db.exec("INSERT INTO vectors(rowid, embedding) SELECT rowid, embedding FROM vector_map WHERE rowid = 1");
    queueMemory( "pending", "fixture pending text");
    const count = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM vectors").get();
    expect(await drainEmbedQueue(ctx.db, null, 2)).toBe(0);
    expect(count()).toEqual({ n: 3 });
    await drainEmbedQueue(ctx.db, null, 2);
    expect(count()).toEqual({ n: 5 });
    await drainEmbedQueue(ctx.db, null, 2);
    expect(count()).toEqual({ n: 5 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM vector_map").get()).toEqual({ n: 8 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM embed_queue").get()).toEqual({ n: 1 });
    expect(getVectorState(ctx.db)).toEqual({ mapped: 8, indexed: 5, missing: 2, pending: 1, retried: 0, dead: 0 });
    for (const kind of ["memory", "content", "session", "run"] as const) {
      expect(knn(ctx.db, v, 10, kind).length).toBeGreaterThan(0);
    }
  });
  it("drains queued rows into vectors", async () => {
    ctx = makeMemDb();
    queueMemory( "m1", "banana");
    const n = await drainEmbedQueue(ctx.db, fakeEmbedder, 10);
    expect(n).toBe(1);
    const remaining = ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number };
    expect(remaining.c).toBe(0);
    expect(knn(ctx.db, await fakeEmbedder.embed(["banana"]).then(v => v[0]), 1, "memory")[0].ownerId).toBe("m1");
  });
  it("leaves rows and returns 0 when embedder is null (FTS degrade)", async () => {
    ctx = makeMemDb();
    queueMemory( "m2", "cherry");
    expect(await drainEmbedQueue(ctx.db, null, 10)).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number }).c).toBe(1);
  });
});
