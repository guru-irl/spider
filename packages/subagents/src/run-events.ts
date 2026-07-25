import { appendRunEvent } from "@spider/db-core";
import type { Db } from "@spider/db-core";

export function emitIntent(db: Db, e: { runId: string; sessionId: string; tool: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "tool_intent", tool: e.tool, summary: e.summary, payload: e.payload });
}

export function emitToolResult(db: Db, e: { runId: string; sessionId: string; tool: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "tool_result", tool: e.tool, summary: e.summary, payload: e.payload });
}

export function emitStatus(db: Db, e: { runId: string; sessionId: string; status: string; summary?: string }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "status", summary: e.summary ?? e.status, payload: { status: e.status } });
}

export function emitHandoff(db: Db, e: { runId: string; sessionId: string; toRunId: string; phase?: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "handoff", summary: e.summary, payload: { toRunId: e.toRunId, phase: e.phase, ...(e.payload && typeof e.payload === "object" ? e.payload : {}) } });
}

export function emitEscalation(db: Db, e: { runId: string; sessionId: string; severity: "blocked" | "question" | "warning"; summary: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "escalation", summary: e.summary, payload: { severity: e.severity, ...(e.payload && typeof e.payload === "object" ? e.payload : {}) } });
}

export function emitMessage(db: Db, e: { runId?: string; sessionId: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "message", summary: e.summary, payload: e.payload });
}

export function emitLog(db: Db, e: { runId?: string; sessionId: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "log", summary: e.summary, payload: e.payload });
}
