import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths } from "@spider/db-core";
import { autoIndexOutput } from "../routing/autoindex.js";

let dbPath: string;

afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

function mkdb() {
  dbPath = join(paths.scratch("project", process.cwd()), `ai-${randomUUID()}.db`);
  return openDbAt(dbPath, "project");
}

describe("autoIndexOutput", () => {
  it("skips content below the threshold", () => {
    const db = mkdb();
    expect(autoIndexOutput(db, "short", "tool:bash", { threshold: 100 })).toBe(false);
    expect((db.prepare("SELECT COUNT(*) c FROM content").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it("indexes large content into content + content_fts", () => {
    const db = mkdb();
    const big = "needle ".concat("x".repeat(200));
    expect(autoIndexOutput(db, big, "tool:bash", { threshold: 50 })).toBe(true);
    expect((db.prepare("SELECT COUNT(*) c FROM content").get() as { c: number }).c).toBe(1);
    const hit = db.prepare("SELECT source FROM content_fts WHERE content_fts MATCH 'needle'").get() as { source: string } | undefined;
    expect(hit?.source).toBe("tool:bash");
    db.close();
  });

  it("delegates to an injected indexer when provided", () => {
    const db = mkdb();
    let called = "";
    const ok = autoIndexOutput(db, "x".repeat(200), "tool:read", {
      threshold: 50,
      indexLargeOutput: (_t, s) => {
        called = s;
      },
    });
    expect(ok).toBe(true);
    expect(called).toBe("tool:read");
    expect((db.prepare("SELECT COUNT(*) c FROM content").get() as { c: number }).c).toBe(0);
    db.close();
  });
});
