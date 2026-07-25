import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { addMemory, getMemory, listActive, searchMemoryFts, setStatus, removeMemory, activeCharTotal, isDuplicate } from "../store";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("memory store (DB-as-truth)", () => {
  it("adds and reads back a record with a link (no content duplication)", () => {
    ctx = makeMemDb();
    const rec = addMemory(ctx.db, "repo", { category: "convention", content: "Use 2-space indent", link: "eslint.config.js" });
    expect(rec.uuid).toMatch(/[0-9a-f-]{36}/);
    expect(getMemory(ctx.db, "repo", rec.uuid)?.link).toBe("eslint.config.js");
  });
  it("lists only active records, filtered by category", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "dark mode" });
    addMemory(ctx.db, "repo", { category: "failure", content: "flaky test x", status: "staged" });
    const prefs = listActive(ctx.db, "repo", { category: "preference" });
    expect(prefs).toHaveLength(1);
    expect(listActive(ctx.db, "repo")).toHaveLength(1); // staged excluded
  });
  it("FTS-searches active memory content", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "tool-quirk", content: "vitest needs --run in CI" });
    expect(searchMemoryFts(ctx.db, "repo", "vitest").map(r => r.content)).toContain("vitest needs --run in CI");
  });
  it("removeMemory archives (never hard-deletes)", () => {
    ctx = makeMemDb();
    const rec = addMemory(ctx.db, "repo", { category: "insight", content: "keep me" });
    removeMemory(ctx.db, "repo", rec.uuid);
    expect(getMemory(ctx.db, "repo", rec.uuid)?.status).toBe("archived");
  });
  it("activeCharTotal sums only active content", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "12345" });
    addMemory(ctx.db, "repo", { category: "preference", content: "staged", status: "staged" });
    expect(activeCharTotal(ctx.db, "repo")).toBe(5);
  });
  it("detects exact duplicates within category", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "tabs" });
    expect(isDuplicate(ctx.db, "repo", "preference", "tabs")).toBe(true);
    expect(isDuplicate(ctx.db, "repo", "convention", "tabs")).toBe(false);
  });
});
