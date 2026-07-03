import { describe, it, expect, afterEach } from "vitest";
import { ContentStore } from "../content-store";
import { makeContentDb } from "./helpers/tmpdb";

describe("ContentStore", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  it("indexes content into content + content_fts and finds it by FTS", () => {
    const { db, cleanup } = makeContentDb();
    cleanups.push(cleanup);
    const store = new ContentStore(db);
    const r = store.indexContent({ content: "# Caching\nWe cache responses with an LRU.", source: "notes" });
    expect(r.chunkCount).toBeGreaterThan(0);
    const hits = store.ftsSearch("cache", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.toLowerCase()).toContain("cache");
  });

  it("re-indexing the same source replaces prior chunks (no dupes)", () => {
    const { db, cleanup } = makeContentDb();
    cleanups.push(cleanup);
    const store = new ContentStore(db);
    store.indexContent({ content: "alpha", source: "s" });
    store.indexContent({ content: "bravo", source: "s" });
    const hits = store.ftsSearch("alpha", 5);
    expect(hits.length).toBe(0);
    expect(store.ftsSearch("bravo", 5).length).toBe(1);
  });
});
