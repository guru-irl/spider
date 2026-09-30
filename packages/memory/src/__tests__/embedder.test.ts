import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { resolveEmbedder, isEmbedderLoaded, EMBED_DIM } from "../embeddings/embedder";

// Mock only optional model providers. Cache ownership, resolution, and vector
// conversion run as shipped. Never download a model or run real inference.
const provider = vi.hoisted(() => ({ inits: 0, fail: false }));
vi.mock("fastembed", () => ({
  EmbeddingModel: { BGESmallENV15: "fixture" },
  FlagEmbedding: { init: async () => {
    provider.inits++;
    if (provider.fail) throw new Error("fixture initialization rejected");
    return { async *embed(texts: string[]) { yield texts.map(() => new Float32Array(384)); } };
  } },
}));
vi.mock("@huggingface/transformers", () => ({ pipeline: async () => { throw new Error("fixture fallback unavailable"); } }));
const globalCache = globalThis as typeof globalThis & Record<symbol, unknown>;
const key = Symbol.for("spider.embedder.v1:BGE-small-en-v1.5");
beforeEach(() => { delete globalCache[key]; provider.inits = 0; provider.fail = false; });
afterEach(() => { delete globalCache[key]; vi.resetModules(); });

describe("embedder", () => {
  it("reports dim=384 and converts provider vectors", async () => {
    const e = await resolveEmbedder();
    expect(e?.dim).toBe(EMBED_DIM);
    const vectors = await e!.embed(["hello world"]);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0].length).toBe(384);
  });

  it("shares one initialization across concurrent calls from two module instances", async () => {
    vi.resetModules();
    const secondModule = await import("../embeddings/embedder");
    // No await between calls: all three must share the still-pending slot.
    const first = resolveEmbedder();
    const second = secondModule.resolveEmbedder();
    const third = resolveEmbedder();
    expect(second).toBe(first);
    expect(third).toBe(first);
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(provider.inits).toBe(1);
    expect(globalCache[key]).toBeDefined();
  });

  it("an initialization rejection does not poison the process-wide promise", async () => {
    const failure = new Error("fixture config rejected");
    const pending = resolveEmbedder({ get modelsDir(): string { throw failure; } });
    await expect(pending).rejects.toBe(failure);
    expect(globalCache[key]).toBeUndefined();
    expect(await resolveEmbedder()).not.toBeNull();
    expect(provider.inits).toBe(1);
  });

  it("shares an unavailable result for ten minutes across module instances, then retries", async () => {
    vi.resetModules();
    const secondModule = await import("../embeddings/embedder");
    let time = 1000;
    const now = () => time;
    provider.fail = true;
    const first = resolveEmbedder(undefined, now);
    expect(await first).toBeNull();
    expect(isEmbedderLoaded()).toBe(false);
    expect(provider.inits).toBe(1);
    provider.fail = false;
    time = 1000 + 9 * 60 * 1000;
    expect(secondModule.resolveEmbedder(undefined, now)).toBe(first);
    expect(await resolveEmbedder(undefined, now)).toBeNull();
    time = 1000 + 10 * 60 * 1000 - 1;
    expect(await secondModule.resolveEmbedder(undefined, now)).toBeNull();
    expect(provider.inits).toBe(1);
    time++;
    expect(await secondModule.resolveEmbedder(undefined, now)).not.toBeNull();
    expect(isEmbedderLoaded()).toBe(true);
    expect(provider.inits).toBe(2);
  });
});
