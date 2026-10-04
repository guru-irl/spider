import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolveEmbedder, getReadyEmbedder, isEmbedderLoaded, stopEmbedder, getEmbedderState, startEmbedderSession } from "../embeddings/embedder";

const fixture = vi.hoisted(() => ({ worker: undefined as any, failStart: false, inits: 0, silent: false, live: new Set<any>() }));
vi.mock("fastembed", () => ({ FlagEmbedding: { init() { fixture.inits++; throw new Error("main-thread provider init is forbidden"); } }, EmbeddingModel: { BGESmallENV15: "fixture" } }));
vi.mock("@huggingface/transformers", () => ({ pipeline() { throw new Error("main-thread fallback is forbidden"); } }));
vi.mock("node:worker_threads", () => ({ Worker: class extends EventEmitter {
  constructor(public source: string, public options: unknown) {
    super(); if (fixture.failStart) throw new Error("worker start fixture"); fixture.worker = this; fixture.live.add(this); queueMicrotask(() => this.emit("message", { type: "ready" }));
  }
  unreferenced = false;
  unref() { this.unreferenced = true; return this; }
  postMessage(msg: { id: number; texts: string[] }) {
    if (fixture.silent) return;
    queueMicrotask(() => this.emit("message", { type: "result", id: msg.id, vectors: msg.texts.map(() => new Float32Array(384)) }));
  }
  async terminate() { fixture.live.delete(this); this.emit("exit", 0); return 0; }
} }));
const cache = globalThis as typeof globalThis & Record<symbol, unknown>;
const key = Symbol.for("spider.embedder.v2:BGE-small-en-v1.5");
beforeEach(() => startEmbedderSession());
afterEach(async () => { await stopEmbedder(); delete cache[key]; fixture.worker = undefined; fixture.failStart = false; fixture.inits = 0; fixture.silent = false; fixture.live.clear(); vi.useRealTimers(); });

it("loads and embeds only through an inline worker and returns typed vectors", async () => {
  const embedder = await resolveEmbedder();
  expect(fixture.inits).toBe(0);
  expect(fixture.worker.options).toMatchObject({ eval: true, workerData: { base: expect.any(String) } });
  expect(embedder).not.toBeNull();
  expect(fixture.worker.unreferenced).toBe(true);
  const vectors = await embedder!.embed(["query", "content"]);
  expect(vectors).toHaveLength(2); expect(vectors[0]).toBeInstanceOf(Float32Array);
});

it("invalidates a crashed worker instead of running inference on the main thread", async () => {
  const embedder = await resolveEmbedder();
  expect(embedder).not.toBeNull();
  fixture.worker.emit("error", new Error("fixture crash"));
  expect(isEmbedderLoaded()).toBe(false);
  expect(getEmbedderState()).toMatchObject({ state: "unavailable", lastError: "fixture crash" });
  expect(getReadyEmbedder()).toBeNull();
  expect(await resolveEmbedder()).toBeNull();
  await expect(embedder!.embed(["query"])).rejects.toThrow("fixture crash");
  expect(fixture.inits).toBe(0);
});

it("returns null from every getter once worker shutdown begins", async () => {
  const ready = await resolveEmbedder(); expect(ready).not.toBeNull();
  const worker = fixture.worker;
  const stopped = stopEmbedder();
  expect(getReadyEmbedder()).toBeNull();
  expect(await resolveEmbedder()).toBeNull();
  await stopped;
  expect(isEmbedderLoaded()).toBe(false);
  expect(fixture.worker).toBe(worker);
});

it("rejects pending requests and becomes unavailable on a worker exit", async () => {
  const embedder = await resolveEmbedder(); fixture.silent = true;
  const pending = embedder!.embed(["exit fixture"]);
  fixture.worker.emit("exit", 9);
  await expect(pending).rejects.toThrow("embedding worker exited (9)");
  expect(getEmbedderState()).toMatchObject({ state: "unavailable", lastError: expect.stringContaining("exited (9)") });
  expect(fixture.live.size).toBe(0);
});

it("terminates an unresponsive worker after two minutes and settles all requests", async () => {
  const embedder = await resolveEmbedder(); fixture.silent = true;
  vi.useFakeTimers();
  const pending = embedder!.embed(["hang fixture"]);
  const rejection = pending.then(() => null, error => error);
  await vi.advanceTimersByTimeAsync(120001);
  expect(getEmbedderState()).toMatchObject({ state: "unavailable", lastError: expect.stringContaining("timed out") });
  expect((await rejection)?.message).toMatch(/timed out/);
  expect(fixture.live.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a successful worker ready after its cleared request deadline", async () => {
  const embedder = await resolveEmbedder();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  expect(await embedder!.embed(["completed fixture"])).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(120001);
  expect(getEmbedderState().state).toBe("ready");
  expect(fixture.live.size).toBe(1);
  expect(await embedder!.embed(["still ready fixture"])).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("physically terminates the worker on stopEmbedder", async () => {
  await resolveEmbedder(); expect(fixture.live.size).toBe(1);
  await stopEmbedder(); expect(fixture.live.size).toBe(0);
});

it("falls back to FTS availability when a worker cannot be constructed", async () => {
  fixture.failStart = true;
  expect(await resolveEmbedder()).toBeNull();
  expect(getEmbedderState()).toMatchObject({ state: "unavailable", lastError: "worker start fixture" });
  expect(fixture.inits).toBe(0);
});
