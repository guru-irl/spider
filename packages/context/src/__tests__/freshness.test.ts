import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "@spider/db-core";
import { makeContentDb } from "./helpers/tmpdb.js";
import { ContentStore } from "../content-store.js";
import { refreshStaleContent } from "../freshness.js";

let ctx: ReturnType<typeof makeContentDb>;
let file: string;

afterEach(() => {
  ctx?.cleanup();
  try {
    if (file) rmSync(file);
  } catch {
    // Ignore cleanup errors
  }
});

describe("refreshStaleContent", () => {
  it("re-indexes a file-backed source when its on-disk content changed", () => {
    ctx = makeContentDb();
    const dir = paths.scratch("project", process.cwd());
    mkdirSync(dir, { recursive: true });
    file = join(dir, `fresh-${randomUUID()}.md`);
    writeFileSync(file, "# One\nalpha");
    const store = new ContentStore(ctx.db);
    store.indexContent({ path: file, source: "doc" });
    expect(store.ftsSearch("alpha", 5).length).toBe(1);
    writeFileSync(file, "# One\nbravo");
    const n = refreshStaleContent(store);
    expect(n).toBe(1);
    expect(store.ftsSearch("alpha", 5).length).toBe(0);
    expect(store.ftsSearch("bravo", 5).length).toBe(1);
  });
});
