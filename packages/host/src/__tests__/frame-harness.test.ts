// TUI frame-snapshot harness: store -> projection -> component -> rendered frame,
// driven over a REAL scratch DB. Proves the whole integration without pi/Storybook:
//
//   raw DB writes (runs + run_events)  ->  appendRunEvent/bus  ->  AgentStore ingest
//     ->  AgentSnapshot projection  ->  AgentFooter.render(width)  ->  text frame
//
// An identity ThemeAdapter keeps frames ANSI-free and stable, so substring asserts
// on the rendered text prove the agent name, live activity tail, and terminal-state
// glyph actually flow through every layer. These are NOT tautologies: each asserted
// substring can only appear in the frame if the corresponding DB write was ingested,
// projected, and rendered (verified by breaking the pipeline).
import { afterAll, describe, expect, it } from "vitest";
import { openDb, migrate, appendRunEvent, type Db } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { AgentStore, AgentFooter, type ThemeAdapter } from "@spider/ui";
import { createRunSource } from "../agents/run-source";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

// Identity theme => frames carry no color escapes, only literal text + glyphs.
const idTheme: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

const opened: Db[] = [];
afterAll(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

describe("TUI frame-snapshot harness (store -> footer render)", () => {
  it("renders live activity then terminal state across an agent's full lifecycle", () => {
    const db = openDb(scratchDbPath("frame")); opened.push(db); migrate(db, "project");
    const sessionId = "s-frame";
    const runId = "r-frame-1";
    const now = Date.now();

    const runSource = createRunSource(db, sessionId);
    const store = new AgentStore(runSource);
    store.start();

    const footer = new AgentFooter(store, idTheme);
    const frame = (): string => {
      footer.invalidate(); // render() caches per width; force a rebuild each call
      return strip(footer.render(80).join("\n"));
    };

    // --- lifecycle: start (running) ---
    db.prepare(
      `INSERT INTO runs (id, session_id, agent, role, name, status, step_count, token_count, started_at)
       VALUES (?, ?, 'scout', 'scout', 'scout-alpha', 'running', 1, 12, ?)`
    ).run(runId, sessionId, now);
    // Emit through appendRunEvent so the store ingests (synchronous bus emit).
    appendRunEvent(db, { runId, sessionId, ts: now, type: "status", summary: "running" });

    // --- lifecycle: tool intent carrying a live activity summary ---
    appendRunEvent(db, { runId, sessionId, ts: now + 5, type: "tool_intent", tool: "grep", summary: "grepping repo for RunEventTailer" });

    const runningFrame = frame();
    // (a) running frame contains the agent name AND the activity/summary tail
    expect(runningFrame).toContain("scout-alpha");
    expect(runningFrame).toContain("grepping repo for RunEventTailer");
    // running glyph is the spinner, never the terminal check
    expect(runningFrame).not.toContain("✓");

    // --- lifecycle: terminal (done) ---
    db.prepare(`UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?`).run(now + 10, runId);
    appendRunEvent(db, { runId, sessionId, ts: now + 10, type: "status", summary: "done" });

    const doneFrame = frame();
    // (b) terminal frame reflects done -> ✓ (AgentStatus done->✓) and keeps the name
    expect(doneFrame).toContain("scout-alpha");
    expect(doneFrame).toContain("✓");

    store.stop();
  });
});
