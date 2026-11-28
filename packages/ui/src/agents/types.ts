import type { RunEvent } from "@spider/db-core";
import { icon, type IconStyle } from "../icons.js";
import { robotFrame, robotPulse } from "../components/spinner.js";

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
  // isError is undefined for non-tool activity, false for successful tool results.
  activity?: string; activityTool?: string; activityIsError?: boolean;
  stepCount: number; tokenCount: number; cost?: number; usageCosts?: RunUsageCosts; costText?: string; compactionCount?: number; recentActivity: string[]; recentActivityErrors?: (boolean | undefined)[];
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
  spiderGlyphs?: boolean;
  activityTint?(text: string, strength: number): string;
}

export function agentGlyph(theme: ThemeAdapter): string {
  return icon(theme.iconStyle, "agent");
}

/** Child reports mark failed tools with `✗` (stored in run events); older or current text icons may lead too. */
const FAILURE_MARKERS = [...new Set(["✗", "\u{274C}", icon("text", "failure")])];

export function activityText(theme: ThemeAdapter, text: string, isError: boolean | undefined): string {
  if (isError === undefined) return text;
  const marker = (isError ? FAILURE_MARKERS : [icon("text", "success")]).find(m => text.startsWith(`${m} `));
  return marker ? icon(theme.iconStyle, isError ? "failure" : "success") + text.slice(marker.length) : text;
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
  queued: icon("text", "queued"), running: icon("text", "active"), paused: icon("text", "paused"), done: icon("text", "success"), failed: icon("text", "failure"), cancelled: icon("text", "warning"),
};

export function statusGlyph(theme: ThemeAdapter, status: AgentStatus): string {
  const role = { queued: "queued", running: "active", paused: "paused", done: "success", failed: "failure", cancelled: "warning" } as const;
  return icon(theme.iconStyle, role[status]);
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

export function renderAgentStatus(theme: ThemeAdapter, agent: AgentSnapshot, now: number): string {
  if (agent.status !== "running") return theme.fg(statusToken(agent.status), statusGlyph(theme, agent.status));
  const elapsed = Math.max(0, now - (agent.startedAt ?? 0));
  if (theme.iconStyle === "nerd" && theme.spiderGlyphs) return theme.fg("accent", robotFrame(agent.runId, elapsed));
  const glyph = agentGlyph(theme);
  const strength = robotPulse(agent.runId, elapsed);
  return theme.activityTint?.(glyph, strength) ?? theme.fg(strength < 0.5 ? "dim" : "accent", glyph);
}

export type { RunEvent };
