import { openDbAt, type Db } from "@spider/db-core";
import { RunStore } from "./run-store.js";
import { emitIntent, emitToolResult, emitStatus } from "./run-events.js";

export function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

export function makeChildReporter(db: Db, ctx: { runId: string; sessionId: string }) {
  const store = new RunStore(db);
  return {
    onToolStart(tool: string, payload?: unknown) {
      emitIntent(db, { ...ctx, tool, payload });
    },
    onToolEnd(tool: string, payload?: unknown) {
      emitToolResult(db, { ...ctx, tool, payload });
    },
    onStatus(status: string, summary?: string) {
      emitStatus(db, { ...ctx, status, summary });
    },
    onShutdown(status: "done" | "error" | "interrupted", result?: string) {
      const runStatus = status === "done" ? "done" : status === "error" ? "failed" : "cancelled";
      store.finish(ctx.runId, { status: runStatus, result });
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
  const sessionId = (typeof pi?.getSessionName === "function" ? pi.getSessionName() : undefined) ?? runId;
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
