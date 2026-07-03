import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { addMemory, getMemory, listActive, searchMemoryFts, setStatus, removeMemory, activeCharTotal, isDuplicate } from "../store";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("memory store (DB-as-truth)", () => {
  it("adds and reads back a record with a link (no content duplication)", () => {
    ctx = makeMemDb();
    const rec = addMemory(ctx.db, "project", { category: "convention", content: "Use 2-space indent", link: "eslint.config.js" });
    expect(rec.uuid).toMatch(/[0-9a-f-]{36}/);
    expect(getMemory(ctx.db, "project", rec.uuid)?.link).toBe("eslint.config.js");
  });
  it("lists only active records, filtered by category", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "preference", content: "dark mode" });
    addMemory(ctx.db, "project", { category: "failure", content: "flaky test x", status: "staged" });
    const prefs = listActive(ctx.db, "project", { category: "preference" });
    expect(prefs).toHaveLength(1);
    expect(listActive(ctx.db, "project")).toHaveLength(1); // staged excluded
  });
  it("FTS-searches active memory content", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "tool-quirk", content: "vitest needs --run in CI" });
    expect(searchMemoryFts(ctx.db, "project", "vitest").map(r => r.content)).toContain("vitest needs --run in CI");
  });
  it("removeMemory archives (never hard-deletes)", () => {
    ctx = makeMemDb();
    const rec = addMemory(ctx.db, "project", { category: "insight", content: "keep me" });
    removeMemory(ctx.db, "project", rec.uuid);
    expect(getMemory(ctx.db, "project", rec.uuid)?.status).toBe("archived");
  });
  it("activeCharTotal sums only active content", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "preference", content: "12345" });
    addMemory(ctx.db, "project", { category: "preference", content: "staged", status: "staged" });
    expect(activeCharTotal(ctx.db, "project")).toBe(5);
  });
  it("detects exact duplicates within category", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "project", { category: "preference", content: "tabs" });
    expect(isDuplicate(ctx.db, "project", "preference", "tabs")).toBe(true);
    expect(isDuplicate(ctx.db, "project", "convention", "tabs")).toBe(false);
  });
});
