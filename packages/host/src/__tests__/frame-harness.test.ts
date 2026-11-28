// TUI frame-snapshot harness driven over a real scratch DB:
// raw DB writes -> appendRunEvent/bus -> AgentStore -> footer, grid and detail.
// The footer shows the agent name and status; the grid and detail show activity.
// An identity theme keeps the rendered text ANSI-free for the assertions.
import { afterAll, describe, expect, it } from "vitest";
import { openDb, migrate, appendRunEvent, type Db } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { AgentStore, AgentFooter, AgentDetail, renderGridCell, type ThemeAdapter } from "@spider/ui";
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
      return strip(footer.render(120).join("\n"));
    };
    const cell = (): string => {
      const agent = store.snapshot().find((a) => a.runId === runId);
      expect(agent).toBeDefined();
      return strip(renderGridCell(idTheme, { agent: agent!, width: 120, height: 4, focused: false, pinned: false, now: Date.now() }).join("\n"));
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
    // The footer shows the name; the grid and detail show live activity.
    expect(runningFrame).toContain("scout-alpha");
    expect(cell()).toContain("grepping repo for RunEventTailer");
    const detail = new AgentDetail(runId, idTheme, { viewport: () => ({ safeHeight: 18 }), requestRender: () => {} });
    detail.update({ kind: "loaded", run: store.getById(runId), events: [] });
    const detailFrame = strip(detail.render(120).join("\n"));
    expect(detailFrame).toContain("grepping repo for RunEventTailer");
    expect(runningFrame).not.toContain("grepping repo for RunEventTailer");
    // footer has NO status glyph anymore (status is colour-only)
    expect(runningFrame).not.toContain("✓");

    // --- lifecycle: terminal (done) ---
    db.prepare(`UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?`).run(now + 10, runId);
    appendRunEvent(db, { runId, sessionId, ts: now + 10, type: "status", summary: "done" });

    const doneFrame = frame();
    // (b) terminal frame keeps the name (agent stays during the retention window)
    expect(doneFrame).toContain("scout-alpha");
    expect(doneFrame.length).toBeGreaterThan(0);

    store.stop();
  });
});
