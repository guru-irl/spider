// Real cross-process WAL bridge e2e (replaces the previous env-gated tautology).
//
// Proves the full async-run visibility path WITHOUT pi / node-pty:
//   separate OS process  ->  shared SQLite DB (WAL)  ->  parent RunEventTailer.poll()  ->  bus
//
// A child node process (spawned via process.execPath, NOT node-pty) opens the SAME
// DB file the parent opened, INSERTs a run_events row with raw SQL, and exits. The
// parent — whose tailer captured its cursor BEFORE the child wrote — then polls and
// must observe the child's committed row emitted on the shared bus. If cross-process
// WAL visibility or the tailer->bus bridge were broken, no event would arrive and the
// assertions would fail (this is not a tautology: the payload is written by a DIFFERENT
// process and only reaches the assertion through the real DB + tailer + bus pipeline).
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { openDb, migrate, bus, type Db } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { RunEventTailer } from "../event-tailer.js";

const opened: Db[] = [];
afterAll(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

describe("cross-process WAL run_events bridge", () => {
  it("bridges a run_events row written by a SEPARATE OS process to the parent bus", () => {
    const dbPath = scratchDbPath("e2e-wal");
    const runId = "run-xproc-1";
    const sessionId = "sess-xproc";

    // Parent connection: open + migrate, then construct the tailer so its cursor
    // (MAX(run_events.id)) is captured BEFORE the child writes anything.
    const parentDb = openDb(dbPath); opened.push(parentDb); migrate(parentDb, "project");
    const tailer = new RunEventTailer(parentDb);
    tailer.track(runId); // poll() only emits for tracked run ids

    const received: Array<{ runId?: string; sessionId: string; type: string; summary?: string }> = [];
    const off = bus.on((e) => received.push({ runId: e.runId, sessionId: e.sessionId, type: e.type, summary: e.summary }));

    // Child script: a DIFFERENT process opens the SAME db file and inserts a
    // run_events row via raw SQL (matching the canonical column names), then closes.
    // better-sqlite3 autocommits the single INSERT before close() checkpoints WAL.
    const childScript = `
      const path = ${JSON.stringify(dbPath)};
      const Database = require("better-sqlite3");
      const db = new Database(path, { timeout: 30000 });
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.prepare(
        "INSERT INTO run_events (run_id, session_id, ts, type, tool, summary) VALUES (?,?,?,?,?,?)"
      ).run(${JSON.stringify(runId)}, ${JSON.stringify(sessionId)}, Date.now(), "status", null, "child-wrote-me");
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    `;

    // Spawn a real separate OS process. cwd = repo root so require("better-sqlite3")
    // resolves from node_modules. Throws (failing the test) on non-zero exit.
    execFileSync(process.execPath, ["-e", childScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Before poll, the parent bus has seen nothing for this run.
    expect(received.filter((e) => e.runId === runId)).toEqual([]);

    // Poll re-emits NEW run_events (id > cursor) on the shared bus.
    tailer.poll();
    off();

    const mine = received.filter((e) => e.runId === runId);
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({ runId, sessionId, type: "status", summary: "child-wrote-me" });
  });
});
