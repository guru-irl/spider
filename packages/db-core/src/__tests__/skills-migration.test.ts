import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDbAt, paths } from "../index";

let dbPath: string;
afterEach(() => { for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true }); });

describe("phase6 schema", () => {
  it("creates skills + curator_state tables on project migrate", () => {
    dbPath = join(paths.scratch("project", process.cwd()), `skills-${Date.now()}.db`);
    const db = openDbAt(dbPath, "project");
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);
    expect(names).toContain("skills");
    expect(names).toContain("curator_state");
    db.close();
  });
});
