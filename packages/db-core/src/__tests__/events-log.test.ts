import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths } from "../index.js";
import { appendEvent, listEvents, eventCountsByTool, bus, type RunEvent } from "../events.js";

let dbPath: string;
afterEach(() => { for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true }); });
function mkdb() { dbPath = join(paths.scratch("project", process.cwd()), `evlog-${randomUUID()}.db`); return openDbAt(dbPath, "project"); }

describe("events log (producer + tracking readers)", () => {
  it("appends a before-phase intent event and emits it on the bus", () => {
    const db = mkdb();
    const seen: RunEvent[] = [];
    const off = bus.on((e) => seen.push(e));
    appendEvent(db, { sessionId: "s1", ts: 1000, phase: "before", tool: "read", description: "read a file" });
    off();
    const rows = listEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: "s1", ts: 1000, phase: "before", tool: "read", description: "read a file" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: "s1", type: "tool_intent", tool: "read" });
    db.close();
  });

  it("round-trips flagged JSON + added/removed ints on an after-phase event", () => {
    const db = mkdb();
    appendEvent(db, {
      sessionId: "s2", ts: 2000, phase: "after", tool: "edit",
      description: "edited a file", added: 5, removed: 2, flagged: ["secret", "todo"],
      payload: { path: "foo.ts" },
    });
    const rows = listEvents(db, { tool: "edit" });
    expect(rows).toHaveLength(1);
    expect(rows[0].added).toBe(5);
    expect(rows[0].removed).toBe(2);
    expect(rows[0].flagged).toEqual(["secret", "todo"]);
    expect(rows[0].payload).toEqual({ path: "foo.ts" });
    db.close();
  });

  it("counts events per tool", () => {
    const db = mkdb();
    appendEvent(db, { sessionId: "s3", ts: 1, phase: "before", tool: "read" });
    appendEvent(db, { sessionId: "s3", ts: 2, phase: "after", tool: "read" });
    appendEvent(db, { sessionId: "s3", ts: 3, phase: "before", tool: "edit" });
    const counts = eventCountsByTool(db);
    const byTool = Object.fromEntries(counts.map((c) => [c.tool, c.count]));
    expect(byTool.read).toBe(2);
    expect(byTool.edit).toBe(1);
    db.close();
  });
});
