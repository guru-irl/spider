// packages/host/src/__tests__/run-source.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { openDb, migrate, appendRunEvent } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil"; // exported test helper (Phase 0 Task 3)
import { createRunSource } from "../agents/run-source";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

describe("createRunSource", () => {
  it("lists active runs for the session and reads a single run", () => {
    const db = openDb(scratchDbPath("runsrc")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
                VALUES ('r1','s','worker','running',1,10,0)`).run();
    const src = createRunSource(db, "s");
    expect(src.listActive().map(r => r.id)).toEqual(["r1"]);
    expect(src.getRun("r1")?.status).toBe("running");
  });

  it("returns database ids in timestamp then id order", () => {
    const db = openDb(scratchDbPath("runsrc-events")); opened.push(db); migrate(db, "project");
    appendRunEvent(db, { runId: "run", sessionId: "s", ts: 20, type: "message", summary: "later" });
    appendRunEvent(db, { runId: "run", sessionId: "s", ts: 10, type: "message", summary: "same" });
    appendRunEvent(db, { runId: "run", sessionId: "s", ts: 10, type: "message", summary: "same" });
    db.prepare("UPDATE run_events SET payload = ? WHERE run_id = ? AND ts = ?").run("{bad json", "run", 20);
    const source = createRunSource(db, "s");
    const events = source.listEvents!("run");
    expect(events.map(event => event.ts)).toEqual([10, 10, 20]);
    expect(events.every(event => typeof event.id === "number" && Number.isInteger(event.id))).toBe(true);
    expect(new Set(events.map(event => event.id)).size).toBe(3);
    expect(events[0]!.id).toBeLessThan(events[1]!.id);
    expect(source.listEvents!("run").map(event => event.id)).toEqual(events.map(event => event.id));
    expect(events[2]!.payload).toBeUndefined();
  });

  it("subscribe fires only for the matching session on appendRunEvent", () => {
    const db = openDb(scratchDbPath("runsrc2")); opened.push(db); migrate(db, "project");
    const src = createRunSource(db, "s");
    const seen: string[] = [];
    const off = src.subscribe((e) => seen.push(e.sessionId));
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "status", summary: "running" });
    appendRunEvent(db, { runId: "r2", sessionId: "other", ts: 2, type: "status", summary: "running" });
    off();
    expect(seen).toEqual(["s"]);
  });
});
