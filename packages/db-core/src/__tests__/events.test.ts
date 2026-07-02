import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { appendRunEvent, bus, type RunEvent } from "../events.js";
import { scratchDbPath, cleanupScratch } from "../testutil.js";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

describe("event stream", () => {
  it("appends to run_events and emits on the bus", () => {
    const db = openDb(scratchDbPath("events")); opened.push(db);
    migrate(db, "project");
    const seen: RunEvent[] = [];
    const off = bus.on((e) => seen.push(e));
    appendRunEvent(db, { sessionId: "s1", ts: 111, type: "status", summary: "running" });
    off();
    const row = db.prepare("SELECT session_id, type, summary FROM run_events WHERE session_id = ?").get("s1");
    expect(row).toEqual({ session_id: "s1", type: "status", summary: "running" });
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("status");
  });

  it("bus unsubscribe stops delivery", () => {
    const seen: RunEvent[] = [];
    const off = bus.on((e) => seen.push(e));
    off();
    bus.emit({ sessionId: "s2", ts: 1, type: "log" });
    expect(seen).toHaveLength(0);
  });

  it("serializes payload as JSON", () => {
    const db = openDb(scratchDbPath("payload")); opened.push(db);
    migrate(db, "project");
    appendRunEvent(db, { runId: "r1", sessionId: "s3", ts: 2, type: "tool_intent", tool: "bash", payload: { cmd: "ls" } });
    const row = db.prepare("SELECT payload FROM run_events WHERE run_id = 'r1'").get() as { payload: string };
    expect(JSON.parse(row.payload)).toEqual({ cmd: "ls" });
  });
});
