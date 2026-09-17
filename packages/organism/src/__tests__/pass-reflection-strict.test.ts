import { describe, it, expect, afterEach, vi } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { reflectionPass } from "../passes/reflection.js";
import { addMemory, upsertVector } from "@spider/memory";
import type { Embedder } from "@spider/memory";
import type { DigestModel } from "../types.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

function seedCluster(ctx: ReturnType<typeof makeOrgDb>, dim: number): void {
  for (let i = 0; i < 4; i++) {
    const rec = addMemory(ctx.repoDb, "repo", { category: "insight", content: `insight ${i}` });
    const vec = new Float32Array(dim).fill(1);
    vec[i % dim] = 1 + i * 1e-4;
    upsertVector(ctx.repoDb, "memory", rec.uuid, vec, "test-model");
  }
}

describe("reflectionPass — strict JSON contract (no raw response dump)", () => {
  it("a wholly malformed (non-JSON) synthesis reply is never folded in as raw insight content", async () => {
    ctx = makeOrgDb();
    const dim = 8;
    seedCluster(ctx, dim);
    const stub: Embedder = { model: "test", dim, embed: async (t: string[]) => t.map(() => new Float32Array(dim)) };
    const model: DigestModel = { complete: async () => "Sorry, I can't help with that request." };
    const r = await reflectionPass(ctx.repoDb, stub, model);
    // must NOT contain the raw model prose folded in as an "insight"
    expect(r.memory.some((m) => m.content.includes("Sorry, I can't help"))).toBe(false);
  });

  it("still accepts a valid JSON synthesis reply", async () => {
    ctx = makeOrgDb();
    const dim = 8;
    seedCluster(ctx, dim);
    const stub: Embedder = { model: "test", dim, embed: async (t: string[]) => t.map(() => new Float32Array(dim)) };
    const model: DigestModel = {
      complete: async () => JSON.stringify({ memory: [{ category: "insight", content: "shared umbrella lesson" }] }),
    };
    const r = await reflectionPass(ctx.repoDb, stub, model);
    expect(r.memory.some((m) => m.content === "shared umbrella lesson")).toBe(true);
  });
});

// Two well-separated clusters so a per-cluster (not per-pass) malformed reply
// can be distinguished from the healthy cluster's valid synthesis (G4a).
function seedTwoClusters(ctx: ReturnType<typeof makeOrgDb>, dim: number): void {
  for (let g = 0; g < 2; g++) {
    for (let i = 0; i < 4; i++) {
      const rec = addMemory(ctx.repoDb, "repo", { category: "insight", content: `insight ${g}-${i}` });
      const vec = new Float32Array(dim).fill(g === 0 ? 1 : -1);
      vec[i % dim] += i * 1e-4;
      upsertVector(ctx.repoDb, "memory", rec.uuid, vec, "test-model");
    }
  }
}

describe("reflectionPass — per-cluster failure accounting (G4a)", () => {
  it("when EVERY cluster fails to parse, onClusterError fires ONCE with failed===total, and no raw content leaks in (never a healthy empty result mistaken for success)", async () => {
    ctx = makeOrgDb();
    const dim = 8;
    seedTwoClusters(ctx, dim);
    const stub: Embedder = { model: "test", dim, embed: async (t: string[]) => t.map(() => new Float32Array(dim)) };
    const model: DigestModel = { complete: async () => "Sorry, I can't help with that request." };
    const calls: Array<{ error: unknown; info: { failed: number; total: number } }> = [];
    const r = await reflectionPass(ctx.repoDb, stub, model, { onClusterError: (error, info) => calls.push({ error, info }) });
    expect(calls).toHaveLength(1);
    expect(calls[0].info).toEqual({ failed: 2, total: 2 });
    expect(r.memory).toHaveLength(0);
  });

  it("a MIXED run (one cluster malformed, one valid) preserves the valid item and reports exactly ONE aggregated cluster error with failed<total", async () => {
    ctx = makeOrgDb();
    const dim = 8;
    seedTwoClusters(ctx, dim);
    const stub: Embedder = { model: "test", dim, embed: async (t: string[]) => t.map(() => new Float32Array(dim)) };
    const model: DigestModel = {
      complete: async (_system: string, messages: { content: string }[]) =>
        (messages[0]?.content ?? "").includes("insight 0-")
          ? "Sorry, I can't help with that request."
          : JSON.stringify({ memory: [{ category: "insight", content: "group1 umbrella lesson" }] }),
    };
    const calls: Array<{ error: unknown; info: { failed: number; total: number } }> = [];
    const r = await reflectionPass(ctx.repoDb, stub, model, { onClusterError: (error, info) => calls.push({ error, info }) });
    expect(r.memory.some((m) => m.content === "group1 umbrella lesson")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].info).toEqual({ failed: 1, total: 2 });
    expect(String((calls[0].error as Error).message)).toMatch(/1\/2/);
  });

  it("a fully healthy run (all clusters valid) never calls onClusterError", async () => {
    ctx = makeOrgDb();
    const dim = 8;
    seedTwoClusters(ctx, dim);
    const stub: Embedder = { model: "test", dim, embed: async (t: string[]) => t.map(() => new Float32Array(dim)) };
    const model: DigestModel = {
      complete: async () => JSON.stringify({ memory: [{ category: "insight", content: "umbrella lesson" }] }),
    };
    const onClusterError = vi.fn();
    await reflectionPass(ctx.repoDb, stub, model, { onClusterError });
    expect(onClusterError).not.toHaveBeenCalled();
  });
});
