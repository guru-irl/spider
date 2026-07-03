import { appendEvent, type Db } from "@spider/db-core";

export const SPIDER_TOOL_NAME = "spider";

export function isExempt(tool: string): boolean {
  return tool === SPIDER_TOOL_NAME;
}

export interface IntentInput {
  sessionId: string;
  tool: string;
  ts?: number;
  description?: string;
  payload?: unknown;
}

export interface ResultInput {
  sessionId: string;
  tool: string;
  ts?: number;
  description?: string;
  added?: number;
  removed?: number;
  flagged?: string[];
  payload?: unknown;
}

export function recordIntent(db: Db, r: IntentInput): boolean {
  if (isExempt(r.tool)) return false;
  appendEvent(db, {
    sessionId: r.sessionId,
    ts: r.ts ?? Date.now(),
    phase: "before",
    tool: r.tool,
    description: r.description ?? null,
    payload: r.payload,
  });
  return true;
}

export function recordResult(db: Db, r: ResultInput): boolean {
  if (isExempt(r.tool)) return false;
  appendEvent(db, {
    sessionId: r.sessionId,
    ts: r.ts ?? Date.now(),
    phase: "after",
    tool: r.tool,
    description: r.description ?? null,
    added: r.added ?? null,
    removed: r.removed ?? null,
    flagged: r.flagged ?? null,
    payload: r.payload,
  });
  return true;
}
