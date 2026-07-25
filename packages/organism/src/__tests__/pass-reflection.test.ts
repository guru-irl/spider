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
    const r = await reflectionPass(ctx.db, null, model({ memory: [] }));
    expect(r.memory).toEqual([]);
  });

  it("clusterMemory returns [] below minCluster", () => {
    ctx = makeOrgDb();
    addMemory(ctx.db, "repo", { category: "insight", content: "a" });
    expect(clusterMemory(ctx.db, null, 3)).toEqual([]); // null embedder / too few
  });

  it("clusterMemory clusters real persisted memory vectors by uuid", () => {
    ctx = makeOrgDb();
    const dim = 8;
    for (let i = 0; i < 4; i++) {
      const rec = addMemory(ctx.db, "repo", { category: "insight", content: `insight ${i}` });
      // near-identical vectors so they are mutual near-neighbours
      const vec = new Float32Array(dim).fill(1);
      vec[i % dim] = 1 + i * 1e-4;
      upsertVector(ctx.db, "memory", rec.uuid, vec, "test-model");
    }
    const stub: Embedder = {
      model: "test",
      dim,
      embed: async (t: string[]) => t.map(() => new Float32Array(dim)),
    };
    const clusters = clusterMemory(ctx.db, stub, 3);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...clusters.map((c) => c.length))).toBeGreaterThanOrEqual(3);
  });
});
