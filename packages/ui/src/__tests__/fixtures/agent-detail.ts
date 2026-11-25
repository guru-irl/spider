import type { ConversationBlock } from "../../agents/detail-conversation";
import type { AgentSnapshot, StoredRunEvent, ThemeAdapter } from "../../agents/types";

export const plainTheme: ThemeAdapter = {
  fg: (_token, text) => text,
  bg: (_token, text) => text,
  bold: text => text,
  glyph: "🕸",
};

export function storedEvent(id: number, summary: string): StoredRunEvent {
  return { id, runId: "r1", sessionId: "s", ts: id, type: "message", summary };
}

export function messageBlock(id: number, text: string): ConversationBlock {
  return { key: `event:${id}`, eventId: id, text, assistantMessage: true };
}

export function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    runId: "r1", name: "agent", agent: "worker", status: "running",
    stepCount: 0, tokenCount: 0, recentActivity: [], ...overrides,
  };
}
