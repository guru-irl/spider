import { describe, it, expect, afterEach } from "vitest";
import { sanitizeQuery } from "@spider/db-core";
import { makeMemDb, makeGlobalMemDb } from "./helpers/tmpdb";
import { addMemory, setStatus } from "../store";
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
  it("treats punctuation, FTS operators and NUL as safe query text", async () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "insight", content: 'foo-6-bar accepts "quoted" input with AND OR NOT * : tokens' });
    for (const query of ["foo-6-bar", '"quoted"', '"', '"unterminated', "AND", "OR", "NOT", "AND OR", "*", ":", "a\u0000b", 'foo-6-bar "quoted"']) {
      await expect(recall(ctx.db, "repo", query, null)).resolves.toBeDefined();
    }
    for (const query of ["foo-6-bar", "quoted"]) {
      expect((await recall(ctx.db, "repo", query, null)).map(r => r.content)).toContain('foo-6-bar accepts "quoted" input with AND OR NOT * : tokens');
    }
  });
  it("recalls across a NUL separator without throwing", async () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "insight", content: "alpha and beta" });
    expect((await recall(ctx.db, "repo", "alpha\u0000beta", null)).map(r => r.content)).toContain("alpha and beta");
  });
  it("recalls nonadjacent words in either order", async () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "insight", content: "prefers small PRs" });
    for (const query of ["prefers PRs", "PRs prefers"]) {
      expect((await recall(ctx.db, "repo", query, null)).map(r => r.content)).toContain("prefers small PRs");
    }
  });
  it("ranks an old all-words match ahead of eleven newer partial matches", async () => {
    ctx = makeMemDb();
    const target = addMemory(ctx.db, "repo", { category: "convention", content: "vitest config guard checks paths" });
    ctx.db.prepare("UPDATE memory SET created_at = 1 WHERE uuid = ?").run(target.uuid);
    for (let i = 0; i < 11; i++) {
      addMemory(ctx.db, "repo", { category: "insight", content: `${["vitest", "config", "guard"][i % 3]} note ${i}` });
    }
    const rows = await recall(ctx.db, "repo", "vitest config guard", null);
    expect(rows).toHaveLength(10);
    expect(rows[0].uuid).toBe(target.uuid);
    expect(new Set(rows.map(r => r.uuid)).size).toBe(10);
  });

  it("puts the all-words entry first for three mixed-category memory queries", async () => {
    ctx = makeMemDb();
    const entries: Array<[string, string]> = [
      ["convention", "Vitest config guard: config reads and writes stay inside test fixtures."],
      ["preference", "Model policy: workers use a fast model; reviews use a stronger model."],
      ["tool-quirk", "Compaction reserve tokens: reserve enough room for a summary."],
      ["insight", "The organism drains on compaction and session shutdown."],
      ["convention", "Test fixtures live under the scratch directory."],
      ["tool-quirk", "vitest needs a non-watch flag in CI."],
      ["preference", "Keep changes small and focused."],
      ["correction", "The model registry lives on the extension context."],
      ["failure", "A config write in a test reached the checkout configuration."],
      ["insight", "Token budgets are tracked per run."],
      ["tool-quirk", "Model identifiers need a provider."],
      ["convention", "Config precedence is defaults then global then local config."],
      ["insight", "vitest runs files in separate workers."],
      ["preference", "Prefer plain wording in reports."],
      ["tool-quirk", "The model picker falls back when there is no default."],
      ["insight", "Config reload happens on each dispatch."],
      ["failure", "A test reused the global DB across vitest files."],
      ["convention", "The guard for exec blocks the old shell tool."],
      ["insight", "Large outputs are indexed to save tokens."],
      ["tool-quirk", "The vector extension loads lazily."],
      ["preference", "Run the full test suite twice."],
      ["insight", "Snapshot cap is read from local config."],
      ["correction", "The policy for memory scope defaults to repo."],
      ["tool-quirk", "Thinking effort depends on the model."],
      ["insight", "Session summaries are indexed after a drain."],
      ["convention", "Every config key has a default."],
      ["failure", "A mutation test raced another task."],
      ["insight", "Tokens shown in the footer come from usage."],
      ["preference", "Use an appropriate model for reviews."],
      ["tool-quirk", "Vitest config lives at the repo root."],
      ["insight", "A compaction summary drops older output before the reserve window."],
      ["insight", "Guard rails for staged writes require approval."],
    ];
    const ids = entries.map(([category, content], i) => {
      const row = addMemory(ctx.db, "repo", { category: category as "insight", content });
      ctx.db.prepare("UPDATE memory SET created_at = ? WHERE uuid = ?").run(1000 + i, row.uuid);
      return row.uuid;
    });
    for (const [query, targetIndex] of [["vitest config guard", 0], ["model policy", 1], ["compaction reserve tokens", 2]] as const) {
      const before = (ctx.db.prepare(`SELECT m.uuid FROM memory m WHERE m.uuid IN
        (SELECT uuid FROM memory_fts WHERE memory_fts MATCH ?) AND m.status = 'active'
        ORDER BY m.created_at DESC LIMIT 10`).all(sanitizeQuery(query, "OR")) as Array<{ uuid: string }>).map(r => r.uuid);
      const rows = await recall(ctx.db, "repo", query, null);
      const oldRank = before.indexOf(ids[targetIndex]) + 1;
      const newRank = rows.findIndex(r => r.uuid === ids[targetIndex]) + 1;
      console.log(`recall rank ${query}: before=${oldRank || "absent"} after=${newRank || "absent"}`);
      expect(rows[0]?.uuid, query).toBe(ids[targetIndex]);
    }
  });

  it("approval replaces a staged row already present in a rebuilt FTS index", () => {
    ctx = makeMemDb();
    const staged = addMemory(ctx.db, "repo", { category: "insight", content: "amber basil", status: "staged" });
    ctx.db.prepare("INSERT INTO memory_fts (uuid, category, content, link) SELECT uuid, category, content, link FROM memory WHERE uuid = ?").run(staged.uuid);
    setStatus(ctx.db, "repo", staged.uuid, "active");
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE uuid = ?").get(staged.uuid) as { n: number }).n).toBe(1);
  });

  it("returns each memory once even if the existing FTS index contains duplicate hits", async () => {
    ctx = makeMemDb();
    const a = addMemory(ctx.db, "repo", { category: "insight", content: "amber basil" });
    const b = addMemory(ctx.db, "repo", { category: "insight", content: "amber basil shorter" });
    ctx.db.prepare("INSERT INTO memory_fts (uuid, category, content, link) VALUES (?, ?, ?, NULL)").run(a.uuid, a.category, a.content);
    const rows = await recall(ctx.db, "repo", "amber basil", null, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.uuid))).toEqual(new Set([a.uuid, b.uuid]));
  });

  it("requires every meaningful query word when an all-words match exists", async () => {
    ctx = makeMemDb();
    const target = addMemory(ctx.db, "repo", { category: "insight", content: "quartz lantern reports" });
    ctx.db.prepare("UPDATE memory SET created_at = 1 WHERE uuid = ?").run(target.uuid);
    const partial = addMemory(ctx.db, "repo", { category: "insight", content: "quartz alone" });
    ctx.db.prepare("UPDATE memory SET created_at = 2 WHERE uuid = ?").run(partial.uuid);
    const rows = await recall(ctx.db, "repo", "quartz lantern", null, { limit: 1 });
    expect(rows.map(r => r.uuid)).toEqual([target.uuid]);
  });

  it("ranks all-words hits ahead of shorter partial hits even when OR bm25 prefers a partial hit", async () => {
    ctx = makeMemDb();
    const target = addMemory(ctx.db, "repo", { category: "insight", content: `zeta eta ${"filler ".repeat(100)}` });
    ctx.db.prepare("UPDATE memory SET created_at = 1 WHERE uuid = ?").run(target.uuid);
    const partial = addMemory(ctx.db, "repo", { category: "insight", content: "zeta" });
    ctx.db.prepare("UPDATE memory SET created_at = 2 WHERE uuid = ?").run(partial.uuid);
    for (let i = 0; i < 20; i++) {
      const row = addMemory(ctx.db, "repo", { category: "insight", content: `eta note ${i}` });
      ctx.db.prepare("UPDATE memory SET created_at = ? WHERE uuid = ?").run(3 + i, row.uuid);
    }
    expect((await recall(ctx.db, "repo", "zeta eta", null, { limit: 1 })).map(r => r.uuid)).toEqual([target.uuid]);
  });

  it("orders all-words matches by bm25 before creation time", async () => {
    ctx = makeMemDb();
    const short = addMemory(ctx.db, "repo", { category: "insight", content: "amber basil" });
    ctx.db.prepare("UPDATE memory SET created_at = 1 WHERE uuid = ?").run(short.uuid);
    const long = addMemory(ctx.db, "repo", { category: "insight", content: `amber basil ${"filler ".repeat(100)}` });
    ctx.db.prepare("UPDATE memory SET created_at = 2 WHERE uuid = ?").run(long.uuid);
    expect((await recall(ctx.db, "repo", "amber basil", null, { limit: 1 })).map(r => r.uuid)).toEqual([short.uuid]);
  });

  it("falls back to one-word matches if no memory has all query words", async () => {
    ctx = makeMemDb();
    const match = addMemory(ctx.db, "repo", { category: "insight", content: "lantern remains available" });
    expect((await recall(ctx.db, "repo", "lantern nonexistentword", null)).map(r => r.uuid)).toContain(match.uuid);
  });

  it("global recall matches the whole query as a substring rather than splitting words", async () => {
    ctx = makeGlobalMemDb();
    addMemory(ctx.db, "global", { category: "insight", content: "model and policy are separate" });
    const target = addMemory(ctx.db, "global", { category: "insight", content: "the model policy is documented" });
    expect((await recall(ctx.db, "global", "model policy", null)).map(r => r.uuid)).toEqual([target.uuid]);
  });

  it("enqueues an embed job on write", () => {
    ctx = makeMemDb();
    addMemory(ctx.db, "repo", { category: "insight", content: "prefers small PRs" });
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM embed_queue").get() as { c: number }).c).toBe(1);
  });
});
