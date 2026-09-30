import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { reflectionPass, clusterMemory } from "../passes/reflection.js";
import { addMemory, upsertVector } from "@spider/memory";
import type { Embedder } from "@spider/memory";
import type { DigestModel } from "../types.js";

const model = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("reflectionPass", () => {
  it("no embedder → empty (FTS-only degrade)", async () => {
    ctx = makeOrgDb();
    const r = await reflectionPass(ctx.repoDb, null, model({ memory: [] }));
    expect(r.memory).toEqual([]);
  });

  it("caps reflection proposals and keeps the scope bound to its repo input", async () => {
    ctx = makeOrgDb();
    for (let i = 0; i < 3; i++) {
      const rec = addMemory(ctx.repoDb, "repo", { category: "insight", content: `shared rule ${i}` });
      upsertVector(ctx.repoDb, "memory", rec.uuid, new Float32Array(8).fill(1), "test-model");
    }
    const stub: Embedder = { model: "test", dim: 8, embed: async texts => texts.map(() => new Float32Array(8)) };
    const proposals = Array.from({ length: 5 }, (_, i) => ({ category: "insight", content: `Umbrella rule ${i}`,
      scope: "global", justification: "Durable synthesis for this repo", evidence: "src/rules.ts:2" }));
    const result = await reflectionPass(ctx.repoDb, stub, model({ memory: proposals }), { maxMemoryProposals: 2 });
    expect(result.memory).toHaveLength(2);
    expect(result.capDropped).toBe(3);
    expect(result.memory.every(m => m.scope === "repo")).toBe(true);
  });

  it("caps reflection only after rejecting malformed metadata and guardrail failures", async () => {
    ctx = makeOrgDb();
    for (let i = 0; i < 3; i++) {
      const rec = addMemory(ctx.repoDb, "repo", { category: "insight", content: `cluster item ${i}` });
      upsertVector(ctx.repoDb, "memory", rec.uuid, new Float32Array(8).fill(1), "test-model");
    }
    const embedder: Embedder = { model: "test", dim: 8, embed: async texts => texts.map(() => new Float32Array(8)) };
    const valid = { category: "insight", content: "Keep the stable repository check", scope: "repo",
      justification: "Recurring check for future work", evidence: "src/checks.ts:4" };
    const result = await reflectionPass(ctx.repoDb, embedder, model({ memory: [
      { ...valid, content: "No citation", evidence: "unknown" },
      { ...valid, content: "browser tools do not work" },
      valid,
      { ...valid, content: "Use the repository check on changes" },
    ] }), { maxMemoryProposals: 1 });
    expect(result.memory.map(m => m.content)).toEqual([valid.content]);
    expect(result.capDropped).toBe(1);
  });

  it("clusterMemory returns [] below minCluster", () => {
    ctx = makeOrgDb();
    addMemory(ctx.repoDb, "repo", { category: "insight", content: "a" });
    expect(clusterMemory(ctx.repoDb, null, 3)).toEqual([]); // null embedder / too few
  });

  it("clusterMemory clusters real persisted memory vectors by uuid", () => {
    ctx = makeOrgDb();
    const dim = 8;
    for (let i = 0; i < 4; i++) {
      const rec = addMemory(ctx.repoDb, "repo", { category: "insight", content: `insight ${i}` });
      // near-identical vectors so they are mutual near-neighbours
      const vec = new Float32Array(dim).fill(1);
      vec[i % dim] = 1 + i * 1e-4;
      upsertVector(ctx.repoDb, "memory", rec.uuid, vec, "test-model");
    }
    const stub: Embedder = {
      model: "test",
      dim,
      embed: async (t: string[]) => t.map(() => new Float32Array(dim)),
    };
    const clusters = clusterMemory(ctx.repoDb, stub, 3);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...clusters.map((c) => c.length))).toBeGreaterThanOrEqual(3);
  });
});
