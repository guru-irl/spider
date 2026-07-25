import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { addMemory } from "../store";
import { recall } from "../recall";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("recall", () => {
  it("no query + null embedder → listActive", async () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "dark mode" });
    expect((await recall(ctx.db, "repo", undefined, null)).map(r => r.content)).toContain("dark mode");
  });
  it("query + null embedder → FTS", async () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "tool-quirk", content: "vitest needs --run" });
    expect((await recall(ctx.db, "repo", "vitest", null)).map(r => r.content)).toContain("vitest needs --run");
  });
  it("enqueues an embed job on write", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "insight", content: "prefers small PRs" });
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number }).c).toBe(1);
  });
});
