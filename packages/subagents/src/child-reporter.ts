import { openDbAt, type Db } from "@spider/db-core";
import { RunStore } from "./run-store";
import { emitIntent, emitToolResult, emitStatus } from "./run-events";

export function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

export function makeChildReporter(db: Db, ctx: { runId: string; sessionId: string }) {
  const store = new RunStore(db);
  return {
    onToolStart(tool: string, payload?: unknown): void {
      emitIntent(db, { ...ctx, tool, payload });
    },
    onToolEnd(tool: string, payload?: unknown): void {
      emitToolResult(db, { ...ctx, tool, payload });
    },
    onStatus(status: string, summary?: string): void {
      emitStatus(db, { ...ctx, status, summary });
    },
    /** pi fires turn_start with a 0-based turnIndex; persist turns as step_count. */
    onTurn(turns: number): void {
      store.updateProgress(ctx.runId, { stepCount: turns });
    },
    onShutdown(status: "done" | "error" | "interrupted", result?: string): void {
      const runStatus = status === "done" ? "done" : status === "error" ? "failed" : "cancelled";
      store.finish(ctx.runId, { status: runStatus, result });
      emitStatus(db, { ...ctx, status: runStatus, summary: result });
    },
  };
}

export function attachChildReporter(pi: any): (() => void) | undefined {
  if (!isSubagentChild()) return undefined;
  const dbPath = process.env.PI_SPIDER_DB_PATH;
  const runId = process.env.PI_SUBAGENT_RUN_ID;
  if (!dbPath || !runId) return undefined;
  let db: Db;
  try {
    db = openDbAt(dbPath, "project");
  } catch {
    return undefined;
  }
  // Tag run_events with the OWNING spider session so the UI's per-session bus filter
  // keeps them. The parent passes PI_SPIDER_SESSION_ID; getSessionName() throws under
  // headless -p --mode json, and the runId fallback would be filtered out by the UI.
  let sessionId = process.env.PI_SPIDER_SESSION_ID ?? "";
  if (!sessionId) {
    sessionId = runId;
    try {
      const n = typeof pi?.getSessionName === "function" ? pi.getSessionName() : undefined;
      if (n) sessionId = n;
    } catch {
      // no resolvable session in child mode; runId is a fine stable key
    }
  }
  const rep = makeChildReporter(db, { runId, sessionId });
  const offs: Array<() => void> = [];
  const wire = (evt: string, fn: (e: any) => void) => {
    try {
      const off = pi.on(evt, fn);
      if (typeof off === "function") offs.push(off);
    } catch {
      // ignore wiring failures
    }
  };
  wire("tool_execution_start", (e) => rep.onToolStart(e?.toolName, { id: e?.toolCallId }));
  wire("tool_execution_end", (e) => rep.onToolEnd(e?.toolName, { id: e?.toolCallId }));
  wire("turn_start", (e) => rep.onTurn((e?.turnIndex ?? 0) + 1));
  wire("agent_start", () => rep.onStatus("running"));
  wire("session_shutdown", () => {
    try {
      rep.onShutdown("done");
    } finally {
      try {
        db.close();
      } catch {
        // ignore close failures
      }
    }
  });
  return () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        // ignore unsubscribe failures
      }
    }
  };
}
