import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { buildLearningGraph, tokenize } from "../learning-graph.js";
import { addMemory } from "@spider/memory";
import { SkillStore } from "../skill-usage.js";

let ctx: ReturnType<typeof makeOrgDb> | undefined;
afterEach(() => ctx?.cleanup());

describe("learning graph", () => {
  it("tokenize keeps ≥3-char lowercase tokens", () => {
    expect([...tokenize("Auth Refactor a b cat")]).toEqual(
      expect.arrayContaining(["auth", "refactor", "cat"])
    );
    expect(tokenize("Auth Refactor a b cat").has("a")).toBe(false);
    expect(tokenize("Auth Refactor a b cat").has("b")).toBe(false);
  });

  it("links a memory to a skill by lexical overlap and persists insights", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.repoDb);
    s.upsert({ name: "auth-flow", category: "security" });
    addMemory(ctx.repoDb, "repo", { category: "convention", content: "the auth flow uses PKCE" });
    const g = buildLearningGraph(ctx.repoDb, ctx.repoDb, { persist: true });
    expect(g.nodes.some((n) => n.kind === "skill" && n.id === "auth-flow")).toBe(true);
    expect(g.edges.some((e) => e.target === "auth-flow")).toBe(true);
    const rows = ctx.repoDb
      .prepare("SELECT COUNT(*) c FROM insights WHERE kind IN ('node','edge')")
      .get() as { c: number };
    expect(rows.c).toBeGreaterThan(0);
  });
});
