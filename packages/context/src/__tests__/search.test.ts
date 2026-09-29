import { describe, it, expect, afterEach } from "vitest";
import { makeContentDb } from "./helpers/tmpdb";
import { unifiedSearch } from "../search";
import { ContentStore } from "../content-store";
import { recall } from "@spider/memory";
import { sanitizeQuery } from "../fts-query";

let ctx: ReturnType<typeof makeContentDb>;

afterEach(() => ctx?.cleanup());

describe("unifiedSearch (FTS-only degrade path)", () => {
  it("recall and search give the same memory hits for an operator-bearing query", async () => {
    ctx = makeContentDb();
    for (const [uuid, content] of [["m-apple", "apple only"], ["m-pear", "pear only"]]) {
      ctx.repoDb.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES (?, 'insight', ?, 'active', 'user', 1)").run(uuid, content);
      ctx.repoDb.prepare("INSERT INTO memory_fts (uuid, category, content) VALUES (?, 'insight', ?)").run(uuid, content);
    }
    const query = "apple OR pear";
    const recalled = (await recall(ctx.repoDb, "repo", query, null)).map(row => row.uuid).sort();
    const searched = (await unifiedSearch({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, { query, kinds: ["memory"] }))
      .map(row => row.id).sort();
    expect(searched).toEqual(["m-apple", "m-pear"]);
    expect(recalled).toEqual(searched);
  });

  it("sanitizes NUL for search FTS queries", async () => {
    ctx = makeContentDb();
    ctx.repoDb.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('nul', 'insight', 'alpha beta', 'active', 'user', 1)").run();
    ctx.repoDb.prepare("INSERT INTO memory_fts (uuid, category, content) VALUES ('nul', 'insight', 'alpha beta')").run();
    expect(sanitizeQuery("alpha\u0000beta", "OR")).toBe('"alpha" OR "beta"');
    const rows = await unifiedSearch({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, { query: "alpha\u0000beta", kinds: ["memory"] });
    expect(rows.map(row => row.id)).toContain("nul");
  });

  it("returns content + memory hits across kinds ranked by RRF", async () => {
    ctx = makeContentDb();
    new ContentStore(ctx.db).indexContent({
      content: "# Retry\nWe retry on SQLITE_BUSY with backoff.",
      source: "notes",
    });
    ctx.repoDb
      .prepare(
        "INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run("m1", "convention", "always retry on SQLITE_BUSY", "active", "user", Date.now());
    ctx.repoDb
      .prepare("INSERT INTO memory_fts (uuid, category, content, link) VALUES (?,?,?,?)")
      .run("m1", "convention", "always retry on SQLITE_BUSY", "");

    const rows = await unifiedSearch({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, { query: "retry busy", limit: 10 });
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has("content")).toBe(true);
    expect(kinds.has("memory")).toBe(true);
  });
});
