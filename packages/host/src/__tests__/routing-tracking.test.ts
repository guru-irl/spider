import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths, listEvents } from "@spider/db-core";
import { recordIntent, recordResult, isExempt } from "../routing/tracking";

let dbPath: string;
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});
function mkdb() {
  dbPath = join(paths.scratch("project", process.cwd()), `track-${randomUUID()}.db`);
  return openDbAt(dbPath, "project");
}

describe("tool-intent producer", () => {
  it("records a before-phase intent for a tracked tool", () => {
    const db = mkdb();
    expect(recordIntent(db, { sessionId: "s1", tool: "bash", payload: { command: "ls" } })).toBe(true);
    const rows = listEvents(db, { phase: "before" });
    expect(rows[0].tool).toBe("bash");
    db.close();
  });

  it("records an after-phase result with line counts + flags", () => {
    const db = mkdb();
    recordResult(db, { sessionId: "s1", tool: "edit", description: "fix", added: 2, removed: 1, flagged: ["github_personal_token"] });
    const [row] = listEvents(db, { phase: "after" });
    expect(row.added).toBe(2);
    expect(row.flagged).toEqual(["github_personal_token"]);
    db.close();
  });

  it("exempts the spider mega-tool (no event written)", () => {
    const db = mkdb();
    expect(isExempt("spider")).toBe(true);
    expect(recordIntent(db, { sessionId: "s1", tool: "spider" })).toBe(false);
    expect(listEvents(db)).toHaveLength(0);
    db.close();
  });
});
