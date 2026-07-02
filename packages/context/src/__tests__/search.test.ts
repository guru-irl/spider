import { describe, it, expect, afterEach } from "vitest";
import { makeContentDb } from "./helpers/tmpdb.js";
import { unifiedSearch } from "../search.js";
import { ContentStore } from "../content-store.js";

let ctx: ReturnType<typeof makeContentDb>;

afterEach(() => ctx?.cleanup());

describe("unifiedSearch (FTS-only degrade path)", () => {
  it("returns content + memory hits across kinds ranked by RRF", async () => {
    ctx = makeContentDb();
    new ContentStore(ctx.db).indexContent({
      content: "# Retry\nWe retry on SQLITE_BUSY with backoff.",
      source: "notes",
    });
    ctx.db
      .prepare(
        "INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run("m1", "convention", "always retry on SQLITE_BUSY", "active", "user", Date.now());
    ctx.db
      .prepare("INSERT INTO memory_fts (uuid, category, content, link) VALUES (?,?,?,?)")
      .run("m1", "convention", "always retry on SQLITE_BUSY", "");

    const rows = await unifiedSearch(ctx.db, { query: "retry busy", limit: 10 });
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has("content")).toBe(true);
    expect(kinds.has("memory")).toBe(true);
  });
});
