import type { RunEvent } from "@spider/db-core";

export type AgentStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface RunRow {
  id: string; session_id: string; parent_run_id?: string | null;
  agent: string; role?: string | null; name?: string | null;
  status: AgentStatus; phase?: string | null; model?: string | null; task?: string | null;
  started_at?: number | null; ended_at?: number | null;
  step_count: number; token_count: number; result?: string | null;
}

export interface AgentSnapshot {
  runId: string; parentRunId?: string; name: string; agent: string; role?: string;
  status: AgentStatus; phase?: string; model?: string; task?: string;
  startedAt?: number; endedAt?: number;
  activity?: string; activityTool?: string;
  stepCount: number; tokenCount: number; recentActivity: string[];
}

export interface HandoffEdge { from: string; to: string; phase?: string; ts: number; }

export interface RunSource {
  listActive(): RunRow[];
  getRun(runId: string): RunRow | undefined;
  subscribe(fn: (e: RunEvent) => void): () => void;
}

export interface AgentActions {
  message(runId: string): void | Promise<void>;
  interrupt(runId: string): void | Promise<void>;
  resume(runId: string): void | Promise<void>;
  follow(runId: string): void;
}

export interface ThemeAdapter {
  fg(token: string, s: string): string;
  bg(token: string, s: string): string;
  bold(s: string): string;
  glyph: string;
}

export interface FooterModel {
  visible: AgentSnapshot[];
  overflow?: {
    running: number; queued: number; paused: number; done: number; failed: number; cancelled: number; hidden: number;
  };
}
export interface GridLayout { rows: number; cols: number; perPage: number; pages: number; page: number; }
export interface LineChange { index: number; line: string; }
export interface LineDiff { changed: LineChange[]; removedFrom?: number; lengthChanged: boolean; }

export const STATUS_GLYPH: Record<AgentStatus, string> = {
  queued: "○", running: "◆", paused: "■", done: "✓", failed: "✗", cancelled: "⚠",
};

export function statusToken(status: AgentStatus): string {
  switch (status) {
    case "done": return "success";
    case "failed": return "error";
    case "cancelled": return "warning";
    case "running": return "accent";
    default: return "muted"; // queued | paused
  }
}

export type { RunEvent };
