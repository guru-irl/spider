import { afterEach, expect, it, vi } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { enqueueEmbed, drainEmbedQueue } from "../embeddings/queue";
import * as memory from "../index";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => { vi.restoreAllMocks(); ctx?.cleanup(); });

it.each([false, true])("does not drain a stale snapshot after another consumer completes (rowid reused: %s)", async reuse => {
  ctx = makeMemDb();
  ctx.db.prepare("INSERT INTO memory(uuid,category,content,status,created_at) VALUES ('m', 'insight', 'fixture', 'active', 1)").run();
  enqueueEmbed(ctx.db, "memory", "m", "fixture");
  const finishes: Array<(vecs: Float32Array[]) => void> = [];
  const embedder = { model: "fixture", dim: 384, embed: () => new Promise<Float32Array[]>(resolve => finishes.push(resolve)) };
  const first = drainEmbedQueue(ctx.db, embedder);
  memory.upsertVector(ctx.db, "memory", "m", Float32Array.from([1, ...Array(383).fill(0)]), "fixture");
  ctx.db.exec("DELETE FROM embed_queue");
  const v = new Float32Array(384); v[0] = 1;

  if (reuse) {
    enqueueEmbed(ctx.db, "memory", "m", "new fixture");
    expect(ctx.db.prepare("SELECT id FROM embed_queue").get()).toEqual({ id: 1 });
  }
  finishes[0]([v]); expect(await first).toBe(0);
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM vector_map").get()).toEqual({ n: 1 });
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 1 });
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM embed_queue").get()).toEqual({ n: reuse ? 1 : 0 });
});

it("counts embedding attempts and exposes safe last-attempt/error/drain state across DB handles", async () => {
  ctx = makeMemDb();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  ctx.db.prepare("INSERT INTO memory(uuid,category,content,status,created_at) VALUES ('m', 'insight', 'fixture', 'active', 1)").run();
  enqueueEmbed(ctx.db, "memory", "m", "fixture");
  const failed = { model: "fixture", dim: 384, async embed(): Promise<Float32Array[]> { throw new Error("fixture failure token=secretvalue"); } };
  await drainEmbedQueue(ctx.db, failed);
  await drainEmbedQueue(ctx.db, failed);
  expect(ctx.db.prepare("SELECT tries FROM embed_queue").get()).toEqual({ tries: 2 });
  const state = memory.getEmbedDrainState(ctx.db);
  expect(state.lastAttemptAt).toBeGreaterThan(0);
  expect(state.lastDrainAt).toBeUndefined();
  expect(state.oldestQueuedAt).toBeGreaterThan(0);
  expect(state.errors).toBe(2);
  expect(state.lastError).toContain("fixture failure");
  expect(state.lastError).not.toContain("secretvalue");
  expect(warn).not.toHaveBeenCalled();
  const v = new Float32Array(384); v[0] = 1;
  expect(await drainEmbedQueue(ctx.db, { model: "fixture", dim: 384, async embed() { return [v]; } })).toBe(1);
  expect(memory.getEmbedDrainState(ctx.db).lastDrainAt).toBeGreaterThan(0);
  expect(memory.getEmbedDrainState(ctx.db).oldestPendingAt).toBeUndefined();
});
