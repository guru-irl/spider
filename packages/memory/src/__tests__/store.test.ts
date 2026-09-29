import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb, makeGlobalMemDb } from "./helpers/tmpdb";
import { addMemory, getMemory, listActive, searchMemoryFts, setStatus, removeMemory, activeCharTotal, isDuplicate } from "../store";
import { tableFor } from "../internal";
import type { MemoryScope } from "../types";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("memory store (DB-as-truth)", () => {
  it.each(["worktree", "project"])("rejects removed %s scope even at the internal table boundary", scope => {
    expect(() => tableFor(scope as MemoryScope)).toThrow(/worktree memory was removed.*use repo/i);
  });
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
  it("global dedupe ignores archived rows but still counts staged rows", () => {
    ctx = makeGlobalMemDb();
    ctx.db.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('original', 'correction', 'retry me', 'global', 'active', 'user', 1)").run();
    expect(isDuplicate(ctx.db, "global", "correction", "retry me")).toBe(true);
    removeMemory(ctx.db, "global", "original");
    expect(isDuplicate(ctx.db, "global", "correction", "retry me")).toBe(false);
    ctx.db.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('staged', 'correction', 'retry me', 'global', 'staged', 'user', 2)").run();
    expect(isDuplicate(ctx.db, "global", "correction", "retry me")).toBe(true);
  });

  it.each(["repo", "global"] as const)("%s dedupe counts rejected for auto/import only and never archived", scope => {
    ctx = scope === "repo" ? makeMemDb() : makeGlobalMemDb();
    const table = scope === "repo" ? "memory" : "global_memory";
    const insert = (status: string, content: string) => ctx.db.prepare(
      `INSERT INTO ${table} (uuid, category, content, status, source, created_at) VALUES (?, 'insight', ?, ?, 'user', 1)`,
    ).run(`${status}-${content}`, content, status);
    for (const status of ["active", "staged", "rejected", "archived"] as const) {
      insert(status, `item-${status}`);
      for (const source of ["user", "auto", "import"] as const) {
        expect(isDuplicate(ctx.db, scope, "insight", `item-${status}`, source)).toBe(
          status === "active" || status === "staged" || status === "rejected" && source !== "user",
        );
      }
    }
  });

  it("detects exact duplicates within category", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "tabs" });
    expect(isDuplicate(ctx.db, "repo", "preference", "tabs")).toBe(true);
    expect(isDuplicate(ctx.db, "repo", "convention", "tabs")).toBe(false);
  });
});
