// Defect 2: the memory cap has no eviction path. `removeMemory` (store.ts) already
// archives a row and strips it from the FTS mirror, but nothing exposes "find this uuid,
// confirm it exists in THIS scope, then remove it" as a single reusable operation — the
// building block `control memory forget` needs. That operation is `forgetMemory`.
import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb, makeGlobalMemDb } from "./helpers/tmpdb";
import { addMemory, getMemory, listActive, activeCharTotal, searchMemoryFts } from "../store";
import { stageWrite, listPending, forgetMemory } from "../staging";
import { MemoryOverflowError } from "../overflow";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("forgetMemory (deactivate-by-uuid, the missing eviction path)", () => {
  it("archives an active entry and excludes it from listActive/activeCharTotal", () => {
    ctx = makeMemDb();
    const rec = addMemory(ctx.db, "repo", { category: "tool-quirk", content: "junk row one" });
    expect(listActive(ctx.db, "repo")).toHaveLength(1);

    const removed = forgetMemory(ctx.db, "repo", rec.uuid);

    expect(removed?.status).toBe("archived");
    expect(listActive(ctx.db, "repo")).toHaveLength(0);
    expect(activeCharTotal(ctx.db, "repo")).toBe(0);
    // Never hard-deleted -- matches reject/removeMemory: the row survives, archived.
    expect(getMemory(ctx.db, "repo", rec.uuid)?.status).toBe("archived");
  });

  it("returns null for an unknown uuid and leaves existing entries untouched", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "keep me" });

    const result = forgetMemory(ctx.db, "repo", "00000000-0000-0000-0000-000000000000");

    expect(result).toBeNull();
    expect(listActive(ctx.db, "repo")).toHaveLength(1);
  });

  it("removes the entry from the FTS mirror so it stops matching full-text search", () => {
    ctx = makeMemDb();
    const rec = addMemory(ctx.db, "repo", { category: "tool-quirk", content: "findable via fts" });
    expect(searchMemoryFts(ctx.db, "repo", "findable").map((r) => r.uuid)).toContain(rec.uuid);

    forgetMemory(ctx.db, "repo", rec.uuid);

    expect(searchMemoryFts(ctx.db, "repo", "findable")).toHaveLength(0);
  });

  it("archives a staged (pending) entry too, removing it from listPending", () => {
    ctx = makeMemDb();
    const staged = stageWrite(ctx.db, "repo", { category: "insight", content: "pending idea", source: "auto" });
    expect(staged.status).toBe("staged");
    expect(listPending(ctx.db, "repo")).toHaveLength(1);

    const removed = forgetMemory(ctx.db, "repo", staged.uuid!);

    expect(removed?.status).toBe("archived");
    expect(listPending(ctx.db, "repo")).toHaveLength(0);
  });

  it("works for global scope (global_memory table, no FTS mirror)", () => {
    const g = makeGlobalMemDb();
    try {
      // Inserted directly (not via addMemory): a fresh GLOBAL_SCHEMA db has no embed_queue
      // table (that gap is pre-existing and unrelated to forgetMemory -- addMemory's
      // enqueueEmbed call is unconditional and would throw here). Going straight to SQL
      // keeps this test scoped to what it's actually verifying: forgetMemory's global-scope
      // branch (global_memory has no FTS mirror and a different column set than memory).
      const uuid = "11111111-1111-1111-1111-111111111111";
      g.db.prepare(`
        INSERT INTO global_memory (uuid, category, content, link, scope, status, source, confidence, created_at, updated_at)
        VALUES (?, 'preference', 'global junk', NULL, 'global', 'active', 'user', NULL, ?, NULL)
      `).run(uuid, Date.now());
      expect(listActive(g.db, "global")).toHaveLength(1);

      const removed = forgetMemory(g.db, "global", uuid);

      expect(removed?.status).toBe("archived");
      expect(listActive(g.db, "global")).toHaveLength(0);
    } finally {
      g.cleanup();
    }
  });

  it("frees enough active-char budget that a previously cap-blocked write now succeeds", () => {
    ctx = makeMemDb();
    const cap = 100;
    const bigOne = addMemory(ctx.db, "repo", { category: "tool-quirk", content: "x".repeat(90) }, cap);

    // Reproduces the real bug: scope is full, the write is hard-rejected, and (before this
    // feature) there was no supported way to free space short of raw SQL.
    expect(() => addMemory(ctx.db, "repo", { category: "tool-quirk", content: "y".repeat(20) }, cap))
      .toThrow(MemoryOverflowError);

    const removed = forgetMemory(ctx.db, "repo", bigOne.uuid);
    expect(removed?.status).toBe("archived");

    // The SAME write that was blocked now succeeds.
    expect(() => addMemory(ctx.db, "repo", { category: "tool-quirk", content: "y".repeat(20) }, cap)).not.toThrow();
    expect(activeCharTotal(ctx.db, "repo")).toBe(20);
  });
});
