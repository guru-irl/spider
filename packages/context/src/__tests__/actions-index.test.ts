import { describe, it, expect, afterEach } from "vitest";
import { makeContentDb } from "./helpers/tmpdb";
import { runIndex } from "../actions/index-fetch";

let ctx: ReturnType<typeof makeContentDb>;

afterEach(() => ctx?.cleanup());

describe("index action", () => {
  it("indexes inline content and enqueues embeds for each chunk", async () => {
    ctx = makeContentDb();
    const r = await runIndex(
      { action: "index", content: "# T\nhello world caching", source: "doc" } as any,
      { db: ctx.db, cwd: process.cwd() },
    );
    expect(r.text).toMatch(/indexed/i);
    const q = ctx.db.prepare("SELECT COUNT(*) n FROM embed_queue WHERE owner_kind='content'").get() as any;
    expect(q.n).toBeGreaterThan(0);
  });
});
