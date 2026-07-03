import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { addMemory } from "../store";
import { assembleSnapshot } from "../snapshot";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("frozen snapshot", () => {
  it("returns empty string when no active memory", () => {
    ctx = makeMemDb();
    expect(assembleSnapshot({ project: ctx.db })).toBe("");
  });
  it("assembles active records grouped by category inside a fenced block", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "preference", content: "dark mode" });
    addMemory(ctx.db, "project", { category: "convention", content: "conventional commits" });
    const snap = assembleSnapshot({ project: ctx.db });
    expect(snap.startsWith("<memory-context>")).toBe(true);
    expect(snap).toContain("dark mode");
    expect(snap).toContain("conventional commits");
    expect(snap).toContain("[System note:");
  });
  it("excludes staged records and respects charCap", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "insight", content: "x".repeat(500) });
    addMemory(ctx.db, "project", { category: "insight", content: "STAGED".repeat(50), status: "staged" });
    const snap = assembleSnapshot({ project: ctx.db }, { charCap: 300 });
    expect(snap).not.toContain("STAGED");
    expect(snap.length).toBeLessThan(600);
  });
});
