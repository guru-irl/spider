import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb.js";
import { addMemory } from "../store.js";
import { MemoryOverflowError } from "../overflow.js";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("overflow hard-reject", () => {
  it("throws MemoryOverflowError listing current entries when active cap exceeded", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "preference", content: "x".repeat(90) }, 100);
    expect(() => addMemory(ctx.db, "project", { category: "preference", content: "y".repeat(50) }, 100))
      .toThrow(MemoryOverflowError);
    try { addMemory(ctx.db, "project", { category: "preference", content: "y".repeat(50) }, 100); }
    catch (e) { const err = e as MemoryOverflowError; expect(err.cap).toBe(100); expect(err.entries.length).toBe(1); }
  });
  it("staged writes bypass the cap", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "preference", content: "x".repeat(90) }, 100);
    expect(() => addMemory(ctx.db, "project", { category: "preference", content: "y".repeat(50), status: "staged" }, 100)).not.toThrow();
  });
});
