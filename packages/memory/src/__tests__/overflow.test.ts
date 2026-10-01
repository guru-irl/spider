import { describe, it, expect, afterEach } from "vitest";
import { makeGlobalMemDb, makeMemDb } from "./helpers/tmpdb";
import { activeCharTotal, listActive } from "../internal";
import { addMemory } from "../store";
import { MemoryOverflowError } from "../overflow";
import { approvePending, listPending, rejectPending } from "../staging";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("overflow hard-reject", () => {
  it.each(["global", "repo"] as const)("names %s scope, usage, requested size, and the real recovery command", scope => {
    ctx = scope === "global" ? makeGlobalMemDb() : makeMemDb();
    const entry = addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(7952) });
    let error: MemoryOverflowError | undefined;
    try { addMemory(ctx.db, scope, { category: "preference", content: "y".repeat(470) }); }
    catch (e) { error = e as MemoryOverflowError; }
    expect(error).toBeInstanceOf(MemoryOverflowError);
    expect(error!.message.split("\n")[0]).toBe(`Not stored: ${scope} memory is full (7,952 of 8,000 chars used). This entry is 470 chars; free at least 422.`);
    expect(error!.message).toContain(`spider control memory sub=forget uuid=<uuid> scope=${scope}`);
    expect(error!.message).toMatch(/condens/i);
    expect(error!.message).toContain("repo-specific");
    expect(error!.message).not.toContain("snapshotCharCap");
    expect(error!.message).toContain(entry.uuid);
    expect(error!.message).toContain("7,952 chars");
    expect(activeCharTotal(ctx.db, scope)).toBe(7952);
    expect(listActive(ctx.db, scope)).toHaveLength(1);
  });

  it.each(["global", "repo"] as const)("rejects an oversized %s entry without suggesting eviction", scope => {
    ctx = scope === "global" ? makeGlobalMemDb() : makeMemDb();
    expect(() => addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(9000) }))
      .toThrow(`Not stored: this entry is 9,000 chars, over the 8,000-char ${scope} memory cap. Shorten it; forgetting entries cannot make room.`);
    try { addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(9000) }); }
    catch (error) {
      expect((error as Error).message).not.toContain("memory is full");
      expect((error as Error).message).not.toContain("sub=forget");
    }
    expect(listActive(ctx.db, scope)).toHaveLength(0);
  });

  it.each(["global", "repo"] as const)("names the staged %s UUID and retry action when approval overflows", scope => {
    ctx = scope === "global" ? makeGlobalMemDb() : makeMemDb();
    addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(7952) });
    const staged = addMemory(ctx.db, scope, { category: "preference", content: "y".repeat(470), status: "staged" });
    expect(() => approvePending(ctx.db, scope, staged.uuid)).toThrow(
      `Not approved: ${scope} memory is full (7,952 of 8,000 chars used). Staged entry ${staged.uuid} is 470 chars; free at least 422, then approve it again.`,
    );
    expect(listPending(ctx.db, scope).map(entry => entry.uuid)).toEqual([staged.uuid]);
    expect(activeCharTotal(ctx.db, scope)).toBe(7952);
  });

  it("accepts exactly the cap and rejects one extra code point, with no per-entry overhead", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "x".repeat(7952) });
    expect(() => addMemory(ctx.db, "repo", { category: "preference", content: "y".repeat(48) })).not.toThrow();
    expect(activeCharTotal(ctx.db, "repo")).toBe(8000);
    expect(() => addMemory(ctx.db, "repo", { category: "preference", content: "z" })).toThrow("This entry is 1 char; free at least 1.");
  });

  it.each(["global", "repo"] as const)("uses SQLite code-point units for %s writes, approval, and listed sizes", scope => {
    ctx = scope === "global" ? makeGlobalMemDb() : makeMemDb();
    const old = addMemory(ctx.db, scope, { category: "preference", content: "😀".repeat(3000) });
    expect(() => addMemory(ctx.db, scope, { category: "preference", content: "😃".repeat(2600) })).not.toThrow();
    const staged = addMemory(ctx.db, scope, { category: "preference", content: "😄".repeat(2400), status: "staged" });
    expect(() => approvePending(ctx.db, scope, staged.uuid)).not.toThrow();
    expect(activeCharTotal(ctx.db, scope)).toBe(8000);
    expect(() => addMemory(ctx.db, scope, { category: "preference", content: "😁" })).toThrow(MemoryOverflowError);
    try { addMemory(ctx.db, scope, { category: "preference", content: "😁" }); }
    catch (error) {
      expect((error as Error).message).toContain("8,000 of 8,000 chars used");
      expect((error as Error).message).toContain("This entry is 1 char; free at least 1.");
      expect((error as Error).message).toContain(`${old.uuid} · 3,000 chars`);
      expect((error as Error).message).not.toContain("6,000 chars");
    }
  });

  it.each(["global", "repo"] as const)("accepts exactly 8,000 %s chars from nonzero usage and rejects 8,001 without writing", scope => {
    ctx = scope === "global" ? makeGlobalMemDb() : makeMemDb();
    addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(100) });
    expect(() => addMemory(ctx.db, scope, { category: "preference", content: "y".repeat(7900) })).not.toThrow();
    expect(activeCharTotal(ctx.db, scope)).toBe(8000);
    expect(() => addMemory(ctx.db, scope, { category: "preference", content: "z" })).toThrow(MemoryOverflowError);
    expect(activeCharTotal(ctx.db, scope)).toBe(8000);
    expect(listActive(ctx.db, scope)).toHaveLength(2);
  });

  it("treats a cap-sized entry with existing usage as recoverable by eviction", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "x".repeat(100) });
    expect(() => addMemory(ctx.db, "repo", { category: "preference", content: "y".repeat(8000) }))
      .toThrow("This entry is 8,000 chars; free at least 100.");
    expect(listActive(ctx.db, "repo")).toHaveLength(1);
  });

  it.each(["😀", "e\u0301", "👩🏽‍💻"])("keeps %s graphemes intact at the preview boundary", grapheme => {
    ctx = makeMemDb();
    const entry = addMemory(ctx.db, "repo", { category: "preference", content: "a".repeat(49) + grapheme + "tail" });
    let error: MemoryOverflowError | undefined;
    try { addMemory(ctx.db, "repo", { category: "preference", content: "new" }, 50); }
    catch (e) { error = e as MemoryOverflowError; }
    expect(error).toBeInstanceOf(MemoryOverflowError);
    const row = error!.message.split("\n").find(line => line.startsWith(`- ${entry.uuid}`));
    expect(row).toContain(`[preference] ${"a".repeat(49)}${grapheme}...`);
    expect(row).not.toContain("tail");
  });

  it.each(["global", "repo"] as const)("gives executable recovery for an oversized staged %s entry", scope => {
    ctx = scope === "global" ? makeGlobalMemDb() : makeMemDb();
    const staged = addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(8001), status: "staged" });
    expect(() => approvePending(ctx.db, scope, staged.uuid)).toThrow(
      `Reject it with spider control memory sub=reject uuid=${staged.uuid} scope=${scope}, then remember a shorter version; forgetting entries cannot make room.`,
    );
    expect(listPending(ctx.db, scope).map(entry => entry.uuid)).toEqual([staged.uuid]);
    rejectPending(ctx.db, scope, staged.uuid);
    expect(listPending(ctx.db, scope)).toHaveLength(0);
    expect(() => addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(8000) })).not.toThrow();
    expect(activeCharTotal(ctx.db, scope)).toBe(8000);
  });

  it("lists only the 20 largest entries, with UUIDs, sizes, and bounded single-line previews", () => {
    ctx = makeMemDb();
    const entries = Array.from({ length: 22 }, (_, i) => addMemory(ctx.db, "repo", {
      category: "preference", content: `row${i}\n` + "x".repeat(i * 100),
    }, 100000));
    const usage = activeCharTotal(ctx.db, "repo");
    let error: MemoryOverflowError | undefined;
    try { addMemory(ctx.db, "repo", { category: "preference", content: "new" }, usage); }
    catch (e) { error = e as MemoryOverflowError; }
    expect(error).toBeInstanceOf(MemoryOverflowError);
    const rows = error!.message.split("\n").filter(line => line.startsWith("- "));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain(entries[21].uuid);
    expect(rows[0]).toContain("2,106 chars");
    expect(rows[19]).toContain(entries[2].uuid);
    expect(error!.message).not.toContain(entries[0].uuid);
    expect(error!.message).not.toContain(entries[1].uuid);
    expect(error!.message).toContain("2 more");
    expect(rows.every(row => row.length < 160)).toBe(true);
    expect(listActive(ctx.db, "repo")).toHaveLength(22);
  });

  it("throws MemoryOverflowError listing current entries when active cap exceeded", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "x".repeat(90) }, 100);
    expect(() => addMemory(ctx.db, "repo", { category: "preference", content: "y".repeat(50) }, 100))
      .toThrow(MemoryOverflowError);
    try { addMemory(ctx.db, "repo", { category: "preference", content: "y".repeat(50) }, 100); }
    catch (e) { const err = e as MemoryOverflowError; expect(err.cap).toBe(100); expect(err.entries.length).toBe(1); }
  });
  it("staged writes bypass the cap", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "x".repeat(90) }, 100);
    expect(() => addMemory(ctx.db, "repo", { category: "preference", content: "y".repeat(50), status: "staged" }, 100)).not.toThrow();
  });
});
