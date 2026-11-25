import type { RunEvent } from "@spider/db-core";
import { icon, type IconStyle } from "../icons.js";

export type AgentStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

/** An event read from run_events, distinct from an unpersisted bus notification. */
export type StoredRunEvent = RunEvent & { id: number };

export type RunUsageCosts = readonly { provider?: string; cost: number }[];
export type RunCostFormatter = (costs: RunUsageCosts) => string;

export interface RunRow {
  id: string; session_id: string; parent_run_id?: string | null;
  agent: string; role?: string | null; name?: string | null;
  status: AgentStatus; phase?: string | null; model?: string | null; thinking?: string | null; task?: string | null;
  started_at?: number | null; ended_at?: number | null;
  step_count: number; token_count: number; cost?: number; usageCosts?: RunUsageCosts; costText?: string; compactionCount?: number; result?: string | null;
}

export interface AgentSnapshot {
  runId: string; parentRunId?: string; name: string; agent: string; role?: string;
  status: AgentStatus; phase?: string; model?: string; thinking?: string; task?: string;
  startedAt?: number; endedAt?: number;
  activity?: string; activityTool?: string; activityIsError?: boolean;
  stepCount: number; tokenCount: number; cost?: number; usageCosts?: RunUsageCosts; costText?: string; compactionCount?: number; recentActivity: string[]; recentActivityErrors?: boolean[];
}

export interface HandoffEdge { from: string; to: string; phase?: string; ts: number; }

export interface RunSource {
  listActive(): RunRow[];
  getRun(runId: string): RunRow | undefined;
  subscribe(fn: (e: RunEvent) => void): () => void;
  /** All run_events for one run, chronological — powers the detail conversation view. */
  listEvents?(runId: string): StoredRunEvent[];
}

export interface AgentActions {
  message(runId: string): void | Promise<void>;
  interrupt(runId: string): void | Promise<void>;
  resume(runId: string): void | Promise<void>;
  follow(runId: string): void;
  kill(runId: string): void | Promise<void>;
}

export interface ThemeAdapter {
  fg(token: string, s: string): string;
  bg(token: string, s: string): string;
  bold(s: string): string;
  italic?(s: string): string;
  glyph: string;
  iconStyle?: IconStyle;
}

export function agentGlyph(theme: ThemeAdapter): string {
  return theme.iconStyle === undefined ? theme.glyph : icon(theme.iconStyle, "agent");
}

/** Child reports mark failed tools with `✗` (stored in run events); older or current text icons may lead too. */
const FAILURE_MARKERS = [...new Set(["✗", icon("text", "failure")])];

export function activityText(theme: ThemeAdapter, text: string, isError: boolean | undefined): string {
  const marker = isError ? FAILURE_MARKERS.find(m => text.startsWith(`${m} `)) : undefined;
  return marker ? icon(theme.iconStyle, "failure") + text.slice(marker.length) : text;
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
  queued: "○", running: "◆", paused: "■", done: "✓", failed: icon("text", "failure"), cancelled: icon("text", "warning"),
};

export function statusGlyph(theme: ThemeAdapter, status: AgentStatus): string {
  return status === "failed" ? icon(theme.iconStyle, "failure")
    : status === "cancelled" ? icon(theme.iconStyle, "warning") : STATUS_GLYPH[status];
}

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
