// packages/host/src/__tests__/run-source.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { openDb, migrate, appendRunEvent } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil"; // exported test helper (Phase 0 Task 3)
import { createRunSource } from "../agents/run-source.js";

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
