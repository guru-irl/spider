import { afterEach, expect, it, vi } from "vitest";
import { makeContentDb } from "./helpers/tmpdb";
import { unifiedSearch } from "../search";
import { addMemory, upsertVector, recall, enqueueEmbed, drainEmbedQueue, getVectorState } from "@spider/memory";
import { ContentStore } from "../content-store";

// Replace only inference/provider initialization; storage, KNN, recall and search are real.
vi.mock("@spider/memory", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/memory")>();
  const fixture = {
    model: "fixture", dim: 384,
    async embed(texts: string[]) { return texts.map(() => { const v = new Float32Array(384); v[0] = 1; return v; }); },
  };
  return { ...actual, resolveEmbedder: async () => fixture, getReadyEmbedder: () => fixture, isEmbedderLoaded: () => true };
});

vi.mock("fastembed", () => ({ FlagEmbedding: { init() { throw new Error("real provider init forbidden"); } } }));

const guard = vi.hoisted(() => ({ workers: 0 }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn() { guard.workers++; throw new Error("real worker forbidden in search fixture"); },
}));

let ctx: ReturnType<typeof makeContentDb>;
afterEach(() => { ctx?.cleanup(); expect(guard.workers).toBe(0); });

it("recall and unified search hydrate native-only hits for each vector owner", async () => {
  ctx = makeContentDb();
  const v = new Float32Array(384); v[0] = 1;
  const memory = addMemory(ctx.repoDb, "repo", { category: "insight", content: "fixture orchard" });
  const content = new ContentStore(ctx.db).indexContent({ content: "fixture meadow", source: "fixture" });
  ctx.db.prepare("INSERT INTO sessions(id, name, summary, started_at) VALUES ('s1', 'fixture', 'fixture forest', 1)").run();
  upsertVector(ctx.repoDb, "memory", memory.uuid, v, "fixture");
  upsertVector(ctx.db, "content", String(content.ids[0]), v, "fixture");
  upsertVector(ctx.db, "session", "s1", v, "fixture");
  const query = "noftsword";
  const recalled = await recall(ctx.repoDb, "repo", query, {
    model: "fixture", dim: 384, async embed() { return [v]; },
  });
  expect(recalled.map(r => r.uuid)).toEqual([memory.uuid]);
  const searched = await unifiedSearch({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, { query });
  expect(searched.map(r => r.key).sort()).toEqual([
    `content:${content.ids[0]}`, `memory:${memory.uuid}`, "session:s1",
  ].sort());
  expect(searched.every(r => r.snippet.includes("fixture"))).toBe(true);
});

it("content deletion removes queued, mapped and native vectors before id reuse", () => {
  ctx = makeContentDb(); const store = new ContentStore(ctx.db);
  const row = store.indexContent({ content: "old fixture", source: "old" });
  const v = new Float32Array(384); v[0] = 1;
  upsertVector(ctx.db, "content", String(row.ids[0]), v, "fixture");
  enqueueEmbed(ctx.db, "content", String(row.ids[0]), "old fixture");
  expect(store.deleteBySource("old")).toBe(1);
  expect(getVectorState(ctx.db)).toMatchObject({ mapped: 0, indexed: 0, pending: 0 });
  expect(store.indexContent({ content: "new fixture", source: "new" }).ids).toEqual(row.ids);
  expect(getVectorState(ctx.db)).toMatchObject({ mapped: 0, indexed: 0 });
});

it("purges orphan content before calling inference", async () => {
  ctx = makeContentDb();
  enqueueEmbed(ctx.db, "content", "1234", "gone fixture");
  let calls = 0;
  await drainEmbedQueue(ctx.db, { model: "fixture", dim: 384, async embed() { calls++; throw new Error("orphan was embedded"); } });
  expect(calls).toBe(0);
  expect(getVectorState(ctx.db)).toMatchObject({ mapped: 0, pending: 0, retried: 0 });
});
