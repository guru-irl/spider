import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb.js";
import { addMemory } from "../store.js";
import { recall } from "../recall.js";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("recall", () => {
  it("no query + null embedder → listActive", async () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "preference", content: "dark mode" });
    expect((await recall(ctx.db, "project", undefined, null)).map(r => r.content)).toContain("dark mode");
  });
  it("query + null embedder → FTS", async () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "tool-quirk", content: "vitest needs --run" });
    expect((await recall(ctx.db, "project", "vitest", null)).map(r => r.content)).toContain("vitest needs --run");
  });
  it("enqueues an embed job on write", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "insight", content: "prefers small PRs" });
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number }).c).toBe(1);
  });
});
