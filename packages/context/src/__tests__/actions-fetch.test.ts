import { describe, it, expect, afterEach, vi } from "vitest";
import { makeContentDb } from "./helpers/tmpdb";
import { runFetch } from "../actions/index-fetch";
import { ContentStore } from "../content-store";

let ctx: ReturnType<typeof makeContentDb>;
const realFetch = globalThis.fetch;

afterEach(() => {
  ctx?.cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("fetch action", () => {
  it("fetches HTML, converts to markdown, and indexes it", async () => {
    ctx = makeContentDb();
    globalThis.fetch = (async () => ({
      headers: { get: () => "text/html" },
      text: async () => "<h1>Retry</h1><p>on busy backoff</p>",
    })) as any;

    const r = await runFetch(
      { action: "fetch", url: "http://example.test/doc", source: "web" },
      { db: ctx.db, cwd: process.cwd() },
    );

    expect(r.text).toMatch(/fetched\+indexed 1/i);
    const hits = new ContentStore(ctx.db).ftsSearch("retry", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.toLowerCase()).toContain("retry");
  });
});
