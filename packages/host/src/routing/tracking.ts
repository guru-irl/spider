import { appendEvent, type Db } from "@spider/db-core";

export const SPIDER_TOOL_NAME = "spider";

export function isExempt(tool: string): boolean {
  return tool === SPIDER_TOOL_NAME;
}

interface CallCorrelation { toolCallId?: string; parentToolCallId?: string }

function activityPayload(r: CallCorrelation & { payload?: unknown }): unknown {
  if (!r.toolCallId && !r.parentToolCallId) return r.payload;
  return {
    ...(r.payload && typeof r.payload === "object" ? r.payload : {}),
    ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
    ...(r.parentToolCallId ? { parentToolCallId: r.parentToolCallId } : {}),
  };
}

export interface IntentInput extends CallCorrelation {
  sessionId: string;
  tool: string;
  ts?: number;
  description?: string;
  payload?: unknown;
}

export interface ResultInput extends CallCorrelation {
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
    payload: activityPayload(r),
  });
  return true;
}

/** Edit/write already recorded line counts; attach the host's parent id in place. */
export function correlateResult(db: Db, r: ResultInput): void {
  if (!r.toolCallId || !r.parentToolCallId) return;
  db.withRetry(() => db.prepare(`UPDATE events SET payload = json_set(payload, '$.parentToolCallId', ?)
    WHERE id = (SELECT id FROM events WHERE session_id = ? AND tool = ? AND phase = 'after'
      AND json_extract(payload, '$.toolCallId') = ? ORDER BY id DESC LIMIT 1)`)
    .run(r.parentToolCallId, r.sessionId, r.tool, r.toolCallId));
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
    payload: activityPayload(r),
  });
  return true;
}
