import { openDbAt, type Db } from "@spider/db-core";
import { RunStore } from "./run-store";
import { emitIntent, emitToolResult, emitStatus, emitMessage } from "./run-events";
import { thinkingFromModel, stripThinkingSuffix } from "./pi-args";

export function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}
/** A concise label for a tool call from its args (path/command/pattern/…). */
function summarizeToolArgs(tool: string, args: any): string {
  const a = args && typeof args === "object" ? (args as Record<string, any>) : {};
  const pick = firstString(a.path, a.file, a.filePath, a.command, a.pattern, a.query, a.url, a.name, a.action);
  return pick ? `${tool} ${pick.replace(/\s+/g, " ").slice(0, 100)}` : tool;
}
function extractText(result: any): string {
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join(" ");
}
function summarizeResult(tool: string, result: any, isError: boolean): string {
  const prev = extractText(result).replace(/\s+/g, " ").trim().slice(0, 120);
  return `${isError ? "✗" : "✓"} ${tool}${prev ? " — " + prev : ""}`;
}
/** Assistant prose (text blocks only) from a finalized message. */
function extractAssistantText(msg: any): string {
  if (!msg || msg.role !== "assistant") return "";
  const content = msg.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("").trim();
  return "";
}

export function makeChildReporter(db: Db, ctx: { runId: string; sessionId: string }) {
  const store = new RunStore(db);
  return {
    onToolStart(tool: string, summary?: string, payload?: unknown): void {
      emitIntent(db, { ...ctx, tool, summary, payload });
    },
    onToolEnd(tool: string, summary?: string, payload?: unknown): void {
      emitToolResult(db, { ...ctx, tool, summary, payload });
    },
    /** Assistant prose — recorded so the detail view can show the full live conversation. */
    onMessage(text: string): void {
      emitMessage(db, { ...ctx, summary: text, payload: { text } });
    },
    onStatus(status: string, summary?: string): void {
      emitStatus(db, { ...ctx, status, summary });
    },
    /** pi fires turn_start with a 0-based turnIndex; persist turns as step_count. */
    onTurn(turns: number): void {
      store.updateProgress(ctx.runId, { stepCount: turns });
    },
    /** Record the child's actual model once (subagents spawned without an explicit
     *  model would otherwise show '—' in the UI). */
    onModel(model: string): void {
      // The reported id may carry a thinking suffix (e.g. "prov/opus:high"); keep the model
      // column clean and record the child's real thinking level when present.
      const th = thinkingFromModel(model);
      store.updateProgress(ctx.runId, { model: stripThinkingSuffix(model), ...(th ? { thinking: th } : {}) });
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
  const wire = (evt: string, fn: (e: any, ctx?: any) => void) => {
    try {
      const off = pi.on(evt, fn);
      if (typeof off === "function") offs.push(off);
    } catch {
      // ignore wiring failures
    }
  };
  let modelSeen = false;
  const captureModel = (evtCtx: any) => {
    if (modelSeen) return;
    try {
      // Event handlers get an ExtensionContext whose CURRENT model is the `.model` property
      // (getModel() lives on a different ctx shape); fall back to getModel() defensively.
      const m = evtCtx?.model ?? (typeof evtCtx?.getModel === "function" ? evtCtx.getModel() : undefined);
      if (m?.id) { rep.onModel(String(m.id)); modelSeen = true; }
    } catch { /* model not resolvable yet */ }
  };
  wire("tool_execution_start", (e) => rep.onToolStart(e?.toolName, summarizeToolArgs(e?.toolName, e?.args), { id: e?.toolCallId }));
  wire("tool_execution_end", (e) => rep.onToolEnd(e?.toolName, summarizeResult(e?.toolName, e?.result, !!e?.isError), { id: e?.toolCallId, isError: !!e?.isError }));
  wire("message_end", (e) => { const text = extractAssistantText(e?.message); if (text) rep.onMessage(text); });
  wire("turn_start", (e, ctx) => { rep.onTurn((e?.turnIndex ?? 0) + 1); captureModel(ctx); });
  wire("agent_start", (_e, ctx) => { rep.onStatus("running"); captureModel(ctx); });
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
