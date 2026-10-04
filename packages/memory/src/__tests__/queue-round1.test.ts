import { afterEach, expect, it, vi } from "vitest";
import { openDbAt } from "@spider/db-core";
import { makeMemDb } from "./helpers/tmpdb";
import { addMemory, setStatus, removeMemory, recall } from "../index";
import { enqueueEmbed, drainEmbedQueue } from "../embeddings/queue";
import { upsertVector, getVectorState } from "../embeddings/vectors";
import { getEmbedDrainState } from "../embeddings/drain-state";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => { vi.restoreAllMocks(); ctx?.cleanup(); });
const vector = () => { const v = new Float32Array(384); v[0] = 1; return v; };
const good = { model: "fixture", dim: 384, async embed(texts: string[]) { return texts.map(vector); } };
const add = (text: string) => addMemory(ctx.db, "repo", { category: "insight", content: text });

it("isolates a poison item, drains later good items, and stops after five failures", async () => {
  ctx = makeMemDb(); add("POISON");
  for (let i = 0; i < 40; i++) add(`good ${i}`);
  let poisonCalls = 0;
  const provider = { ...good, async embed(texts: string[]) {
    if (texts.includes("POISON")) { poisonCalls++; throw new Error("poison fixture"); }
    return texts.map(vector);
  } };
  for (let i = 0; i < 20; i++) await drainEmbedQueue(ctx.db, provider, 8);
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM vector_map").get()).toEqual({ n: 40 });
  expect(ctx.db.prepare("SELECT text, tries FROM embed_queue").all()).toEqual([{ text: "POISON", tries: 5 }]);
  const before = poisonCalls;
  await drainEmbedQueue(ctx.db, provider, 8);
  expect(poisonCalls).toBe(before);
  expect(getVectorState(ctx.db)).toMatchObject({ dead: 1 });
  expect(getEmbedDrainState(ctx.db)).toMatchObject({ lastError: expect.stringContaining("poison fixture") });
});

it("isolates transport poison after a batch crash and dead-letters it without blocking good rows", async () => {
  ctx = makeMemDb(); add("POISON");
  for (let i = 0; i < 10; i++) add(`good ${i}`);
  const provider = { ...good, async embed(texts: string[]) {
    if (texts.includes("POISON")) throw Object.assign(new Error("fixture worker exited (9)"), { code: "EMBED_WORKER_UNAVAILABLE" });
    return texts.map(vector);
  } };
  for (let i = 0; i < 30; i++) await drainEmbedQueue(ctx.db, provider);
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM vector_map").get()).toEqual({ n: 10 });
  expect(ctx.db.prepare("SELECT text, tries FROM embed_queue").all()).toEqual([{ text: "POISON", tries: 5 }]);
});

it("charges a transport failure when the crashing row is already isolated", async () => {
  ctx = makeMemDb(); add("POISON");
  const crashed = { ...good, async embed() { throw Object.assign(new Error("fixture worker exited (9)"), { code: "EMBED_WORKER_UNAVAILABLE" }); } };
  for (let i = 0; i < 6; i++) await drainEmbedQueue(ctx.db, crashed);
  expect(ctx.db.prepare("SELECT tries FROM embed_queue").get()).toEqual({ tries: 5 });
});

it("does not charge infrastructure crashes to unattempted batch rows", async () => {
  ctx = makeMemDb(); for (let i = 0; i < 8; i++) add(`row ${i}`);
  let attempts = 0;
  const crashed = { ...good, async embed() { attempts++; throw Object.assign(new Error("fixture worker exited (9)"), { code: "EMBED_WORKER_UNAVAILABLE" }); } };
  expect(await drainEmbedQueue(ctx.db, crashed)).toBe(0);
  expect(attempts).toBe(1);
  expect(ctx.db.prepare("SELECT DISTINCT tries FROM embed_queue").all()).toEqual([{ tries: 0 }]);
  expect(getEmbedDrainState(ctx.db).lastError).toContain("worker exited");
  expect(await drainEmbedQueue(ctx.db, good)).toBe(1);
  expect(await drainEmbedQueue(ctx.db, good)).toBe(7);
});

it("keeps successful isolated results and refunds the tail after a per-item worker crash", async () => {
  ctx = makeMemDb(); for (let i = 0; i < 4; i++) add(`row ${i}`);
  const seen: string[][] = [];
  const provider = { ...good, async embed(texts: string[]) {
    seen.push(texts);
    if (texts.length > 1) throw new Error("isolate fixture");
    if (texts[0] === "row 1") throw Object.assign(new Error("fixture worker exited (9)"), { code: "EMBED_WORKER_UNAVAILABLE" });
    return texts.map(vector);
  } };
  expect(await drainEmbedQueue(ctx.db, provider)).toBe(1);
  expect(seen).toHaveLength(3);
  expect(ctx.db.prepare("SELECT text, tries FROM embed_queue ORDER BY id").all()).toEqual([
    { text: "row 1", tries: 1 }, { text: "row 2", tries: 0 }, { text: "row 3", tries: 0 },
  ]);
});

it("does not retry a dead letter when a new good item wakes the queue", async () => {
  ctx = makeMemDb(); add("dead"); ctx.db.exec("UPDATE embed_queue SET tries = 5"); add("new");
  const seen: string[] = [];
  expect(await drainEmbedQueue(ctx.db, { ...good, async embed(texts) { seen.push(...texts); return texts.map(vector); } })).toBe(1);
  expect(seen).toEqual(["new"]);
  expect(ctx.db.prepare("SELECT text, tries FROM embed_queue").all()).toEqual([{ text: "dead", tries: 5 }]);
});

it("uses FTS rather than propagating a query worker failure", async () => {
  ctx = makeMemDb(); const m = add("needle lexical fixture");
  const hits = await recall(ctx.db, "repo", "needle", { ...good, async embed() { throw new Error("fixture worker crashed"); } });
  expect(hits.map(hit => hit.uuid)).toEqual([m.uuid]);
});

it.each(["count", "dimension", "nan"])("does not commit invalid %s output and isolates it", async kind => {
  ctx = makeMemDb(); add("malformed");
  const bad = { ...good, async embed() {
    if (kind === "count") return [];
    if (kind === "dimension") return [new Float32Array(3)];
    const v = vector(); v[0] = NaN; return [v];
  } };
  await drainEmbedQueue(ctx.db, bad);
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM vector_map").get()).toEqual({ n: 0 });
  expect(ctx.db.prepare("SELECT tries FROM embed_queue").get()).toEqual({ tries: 1 });
  expect(getEmbedDrainState(ctx.db).lastError).toMatch(/invalid|dimension|count|finite/i);
});

it("replaces previous native and mapped vectors for the same owner", () => {
  ctx = makeMemDb(); const m = add("owner");
  upsertVector(ctx.db, "memory", m.uuid, vector(), "fixture");
  upsertVector(ctx.db, "memory", m.uuid, vector(), "fixture");
  expect(getVectorState(ctx.db)).toMatchObject({ mapped: 1, indexed: 1 });
});

it.each(["rejected", "archived", "forgotten"])("removes queued and stored vectors when %s", status => {
  ctx = makeMemDb(); const m = add("owner");
  upsertVector(ctx.db, "memory", m.uuid, vector(), "fixture");
  if (status === "forgotten") removeMemory(ctx.db, "repo", m.uuid);
  else setStatus(ctx.db, "repo", m.uuid, status as "rejected" | "archived");
  expect(getVectorState(ctx.db)).toMatchObject({ mapped: 0, indexed: 0, pending: 0 });
});

it("purges legacy inactive queue and vectors before inference in bounded passes", async () => {
  ctx = makeMemDb();
  for (let i = 0; i < 20; i++) {
    const m = add(`old ${i}`); upsertVector(ctx.db, "memory", m.uuid, vector(), "fixture");
    ctx.db.prepare("UPDATE memory SET status = 'rejected' WHERE uuid = ?").run(m.uuid);
  }
  const m = add("good");
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) await drainEmbedQueue(ctx.db, { ...good, async embed(texts: string[]) { seen.push(...texts); return texts.map(vector); } }, 8);
  expect(seen).toEqual(["good"]);
  expect(ctx.db.prepare("SELECT owner_id FROM vector_map").all()).toEqual([{ owner_id: m.uuid }]);
});

it("merges FTS when many inactive nearest vectors leave fewer than the requested active hits", async () => {
  ctx = makeMemDb();
  for (let i = 0; i < 30; i++) {
    const m = addMemory(ctx.db, "repo", { category: "insight", content: `inactive ${i}`, status: "rejected" });
    const near = vector(); near[1] = 0.01;
    upsertVector(ctx.db, "memory", m.uuid, near, "fixture");
  }
  const lexical = [add("needle one"), add("needle two"), add("needle three")];
  const semantic = add("unrelated semantic"); upsertVector(ctx.db, "memory", semantic.uuid, vector(), "fixture");
  const hits = await recall(ctx.db, "repo", "needle", good, { limit: 3 });
  expect(hits).toHaveLength(3);
  expect(hits.every(h => h.status === "active")).toBe(true);
  expect(hits.some(h => lexical.some(m => m.uuid === h.uuid))).toBe(true);
});

it("does not write during an empty drain tick", async () => {
  ctx = makeMemDb();
  const m = add("owner"); await drainEmbedQueue(ctx.db, good);
  const changes = () => (ctx.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = changes();
  await drainEmbedQueue(ctx.db, good);
  expect(changes()).toBe(before);
  expect(ctx.db.prepare("SELECT owner_id FROM vector_map").all()).toEqual([{ owner_id: m.uuid }]);
});

it("skips a competing drainer using a second connection to the same DB file", async () => {
  ctx = makeMemDb(); add("owner"); const second = openDbAt(ctx.db.raw.name, "repo");
  let finish!: (value: Float32Array[]) => void;
  const first = drainEmbedQueue(ctx.db, { ...good, embed: () => new Promise<Float32Array[]>(resolve => { finish = resolve; }) });
  try {
    expect(await drainEmbedQueue(second, good)).toBe(0);
    finish([vector()]); expect(await first).toBe(1);
    expect(getVectorState(second)).toMatchObject({ mapped: 1, indexed: 1 });
  } finally { finish?.([vector()]); await first; second.close(); }
});

it("does not commit when shutdown arrives between request settlement and its continuation", async () => {
  ctx = makeMemDb(); add("late fixture");
  const controller = new AbortController();
  let finish!: (vectors: Float32Array[]) => void;
  const task = drainEmbedQueue(ctx.db, { ...good, embed: () => new Promise(resolve => { finish = resolve; }) }, 8, { signal: controller.signal });
  finish([vector()]); queueMicrotask(() => controller.abort());
  expect(await task).toBe(0);
  expect(getVectorState(ctx.db)).toMatchObject({ mapped: 0, pending: 1, retried: 0 });
  expect(getEmbedDrainState(ctx.db).errors).toBe(0);
});

it("refunds all charged rows when shutdown aborts batch or isolated inference", async () => {
  for (const isolated of [false, true]) {
    ctx = makeMemDb(); for (let i = 0; i < 3; i++) add(`row ${i}`);
    const controller = new AbortController();
    const provider = { ...good, async embed(texts: string[]) {
      if (isolated && texts.length > 1) throw new Error("isolate fixture");
      controller.abort(); throw new Error("shutdown fixture");
    } };
    expect(await drainEmbedQueue(ctx.db, provider, 8, { signal: controller.signal })).toBe(0);
    expect(ctx.db.prepare("SELECT DISTINCT tries FROM embed_queue").all()).toEqual([{ tries: 0 }]);
    expect(getEmbedDrainState(ctx.db).errors).toBe(0);
    ctx.cleanup();
  }
});

it("caps an oversized queue request at eight texts", async () => {
  ctx = makeMemDb(); for (let i = 0; i < 20; i++) add(`row ${i}`);
  expect(await drainEmbedQueue(ctx.db, good, 200)).toBe(8);
});

it("over-fetches past ten inactive nearest vectors to return active semantic hits without FTS", async () => {
  ctx = makeMemDb();
  for (let i = 0; i < 10; i++) {
    const m = addMemory(ctx.db, "repo", { category: "insight", content: `inactive ${i}`, status: "rejected" });
    upsertVector(ctx.db, "memory", m.uuid, vector(), "fixture");
  }
  const active = Array.from({ length: 5 }, (_, i) => {
    const m = add(`semantic ${i}`); const v = vector(); v[1] = (i + 1) / 100;
    upsertVector(ctx.db, "memory", m.uuid, v, "fixture"); return m;
  });
  const hits = await recall(ctx.db, "repo", "noftsquery", good, { limit: 3 });
  expect(hits.map(hit => hit.uuid)).toEqual(active.slice(0, 3).map(m => m.uuid));
});
