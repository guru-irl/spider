import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { reflectionPass, clusterMemory } from "../passes/reflection.js";
import { addMemory } from "@spider/memory";
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
    addMemory(ctx.db, "project", { category: "insight", content: "a" });
    expect(clusterMemory(ctx.db, null, 3)).toEqual([]); // null embedder / too few
  });
});
