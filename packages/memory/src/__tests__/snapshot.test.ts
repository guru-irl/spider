import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb, makeGlobalMemDb } from "./helpers/tmpdb";
import { addMemory } from "../store";
import { assembleSnapshot, assembleSnapshotWithStats } from "../snapshot";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("frozen snapshot", () => {
  it("injects every active entry at each scope's 8000-character store cap with scope labels", () => {
    const global = makeGlobalMemDb();
    const repo = makeMemDb();
    try {
      for (const [scope, db] of [["global", global.db], ["repo", repo.db]] as const) {
        for (let i = 0; i < 16; i++) {
          const content = `${scope}-${i}-` + "x".repeat(500 - `${scope}-${i}-`.length);
          if (scope === "global") {
            db.prepare("INSERT INTO global_memory (uuid, category, content, status, source, created_at) VALUES (?, 'preference', ?, 'active', 'user', ?)")
              .run(`${scope}-${i}`, content, i);
          } else addMemory(db, scope, { category: "preference", content });
        }
      }
      const text = assembleSnapshot({ global: global.db, repo: repo.db });
      expect(text).not.toContain("## worktree");
      for (const scope of ["global", "repo"] as const) {
        expect(text).toContain(`## ${scope}`);
        for (let i = 0; i < 16; i++) expect(text).toContain(`${scope}-${i}-`);
      }
      expect(text).not.toContain("omitted");
    } finally {
      global.cleanup(); repo.cleanup();
    }
  });

  it("on an explicit small cap packs preference and correction first, skips oversized entries, and reports omissions", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "insight", content: "small insight" });
    addMemory(ctx.db, "repo", { category: "correction", content: "correct me" });
    addMemory(ctx.db, "repo", { category: "preference", content: "preferred directive" });
    addMemory(ctx.db, "repo", { category: "preference", content: "H".repeat(500) });
    const text = assembleSnapshot({ repo: ctx.db }, { charCap: 210 });
    expect(text).toContain("preferred directive");
    expect(text).toContain("correct me");
    expect(text).toContain("small insight");
    expect(text).not.toContain("HHHH");
    expect(text).toMatch(/1 entr(?:y|ies) omitted/);
  });

  it("orders preference then correction before observations even when observations are newer", () => {
    ctx = makeMemDb();
    const global = makeGlobalMemDb();
    try {
      addMemory(ctx.db, "repo", { category: "insight", content: "new observation" });
      addMemory(ctx.db, "repo", { category: "correction", content: "corrective rule" });
      global.db.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('old-pref', 'preference', 'preferred rule', 'global', 'active', 'user', 1)").run();
      const text = assembleSnapshot({ global: global.db, repo: ctx.db }, { charCap: 1000 });
      expect(text.indexOf("preferred rule")).toBeLessThan(text.indexOf("corrective rule"));
      expect(text.indexOf("corrective rule")).toBeLessThan(text.indexOf("new observation"));
    } finally { global.cleanup(); }
  });

  it("groups mixed tiers and categories once within an observation priority band", () => {
    const global = makeGlobalMemDb();
    const repo = makeMemDb();
    try {
      const rows = [
        [global.db, "global", "insight", "global insight old", 1],
        [repo.db, "repo", "convention", "repo convention old", 2],
        [repo.db, "repo", "insight", "repo insight mid", 3],
        [global.db, "global", "convention", "global convention mid", 4],
        [global.db, "global", "insight", "global insight new", 5],
        [repo.db, "repo", "convention", "repo convention new", 6],
      ] as const;
      for (const [db, tier, category, content, created] of rows) {
        const table = tier === "global" ? "global_memory" : "memory";
        db.prepare(`INSERT INTO ${table} (uuid, category, content, status, source, created_at) VALUES (?, ?, ?, 'active', 'user', ?)`)
          .run(`${tier}-${created}`, category, content, created);
      }
      const text = assembleSnapshot({ global: global.db, repo: repo.db });
      expect(text.match(/^## global$/gm)).toHaveLength(1);
      expect(text.match(/^## repo$/gm)).toHaveLength(1);
      for (const group of text.split(/^## (?:global|repo)$/m).slice(1)) {
        expect(group.match(/^### insight$/gm)).toHaveLength(1);
        expect(group.match(/^### convention$/gm)).toHaveLength(1);
      }
      expect(text.indexOf("global insight new")).toBeLessThan(text.indexOf("global insight old"));
    } finally { global.cleanup(); repo.cleanup(); }
  });

  it("reports per-tier active and injected counts with a small explicit cap", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "preferred" });
    addMemory(ctx.db, "repo", { category: "insight", content: "X".repeat(250) });
    const result = assembleSnapshotWithStats({ repo: ctx.db }, { charCap: 100 });
    expect(result.counts).toEqual({ global: { active: 0, injected: 0 }, repo: { active: 2, injected: 1 } });
    expect(result.text).toContain("1 entry omitted");
    expect(result.text).toContain("preferred");
  });

  it.each(["worktree", "project"])("rejects removed %s scope in snapshot options", scope => {
    ctx = makeMemDb();
    expect(() => assembleSnapshot({ repo: ctx.db }, { scopes: [scope as never] })).toThrow(/worktree memory was removed.*use repo/i);
  });

  it("returns empty string when no active memory", () => {
    ctx = makeMemDb();
    expect(assembleSnapshot({ repo: ctx.db })).toBe("");
  });
  it("assembles active records grouped by category inside a fenced block", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "preference", content: "dark mode" });
    addMemory(ctx.db, "repo", { category: "convention", content: "conventional commits" });
    const snap = assembleSnapshot({ repo: ctx.db });
    expect(snap.startsWith("<memory-context>")).toBe(true);
    expect(snap).toContain("dark mode");
    expect(snap).toContain("conventional commits");
    expect(snap).toContain("[System note:");
  });
  it("excludes staged records and respects charCap", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "insight", content: "x".repeat(500) });
    addMemory(ctx.db, "repo", { category: "insight", content: "STAGED".repeat(50), status: "staged" });
    const snap = assembleSnapshot({ repo: ctx.db }, { charCap: 300 });
    expect(snap).not.toContain("STAGED");
    expect(snap.length).toBeLessThan(600);
  });
});
