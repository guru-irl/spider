import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";

/** Shared render context for every pure spider renderer. */
export interface RenderCtx { theme: ThemeAdapter; width: number; expanded?: boolean; }

export type ExecKind = "exec" | "exec_file" | "batch";
export interface ExecDetails {
  kind: ExecKind; commands: string[]; ok: boolean; exitCode: number;
  outLines: number; ms?: number; preview: string[]; indexed?: { source: string; chunks: number };
}
export interface IndexDetails {
  kind: "index" | "fetch"; source: string; targets: string[];
  chunks: number; embedded: number; skipped?: number; urls?: string[];
}
export interface MemoryRecordView {
  uuid: string; category: string; content: string; link?: string;
  status: string; source: string; confidence?: number;
}
export interface MemoryCardDetails { mode: "remember" | "recall"; records: MemoryRecordView[]; staged: number; }
export interface TodoItemView { id: number; text: string; done: boolean; }
export interface TodoChecklistDetails { scope: string; items: TodoItemView[]; done: number; total: number; }
export interface RunView { runId: string; name: string; role?: string; status: string; model?: string; steps: number; tokens: number; phase?: string; }
export interface RunResultDetails { runs: RunView[]; pipeline: { from: string; to: string; phase?: string }[]; }
export interface MessageDetails { verb: "send" | "ask" | "reply" | "broadcast"; to?: string; from?: string; kind?: string; body: string; delivered: boolean; }

type St = "ok" | "fail" | "warn" | "on" | "off" | "paused";
const ICON: Record<St, { g: string; token: string }> = {
  ok: { g: "✓", token: "success" }, fail: { g: "✗", token: "error" }, warn: { g: "⚠", token: "warning" },
  on: { g: "●", token: "accent" }, off: { g: "○", token: "muted" }, paused: { g: "■", token: "muted" },
};

/** Status glyph in its semantic color (glyph + color, never color-only). */
export function statusIcon(theme: ThemeAdapter, status: St): string {
  const s = ICON[status];
  return theme.fg(s.token, s.g);
}

/** `label value` on one line, width-guaranteed (value right-truncated). */
export function kv(theme: ThemeAdapter, label: string, value: string, width: number): string {
  if (width < 3) return truncateToWidth(label, width, "");
  return truncateToWidth(`${theme.fg("muted", label)} ${theme.fg("text", value)}`, width, "");
}

/** A 🕸-ruled titled card. OVERLAY-ONLY: use this for standalone surfaces mounted via
 *  ctx.ui.custom (no outer tool shell). NEVER in a tool-result renderer — pi's tool shell
 *  already shows `🕸 spider · <action>`, so a second 🕸 header double-heads the output.
 *  See docs/output-ui-guidelines.md. Every returned line is ≤ width visible cells. */
export function card(theme: ThemeAdapter, title: string, lines: string[], width: number): string[] {
  const head = `${theme.fg("accent", "🕸")} ${theme.bold(theme.fg("accent", title))} `;
  const fill = Math.max(0, width - visibleWidth(head));
  const rule = truncateToWidth(head + theme.fg("dim", "─".repeat(fill)), width, "");
  const out = [rule];
  for (const l of lines) out.push(truncateToWidth(l, width, ""));
  return out;
}

/** A glyph-free section rule for grouping lines INSIDE a tool-result body: `label ─────`
 *  (muted label + dim rule, no 🕸). This is the tool-result counterpart to card() — it adds
 *  structure without repeating the tool shell's header. See docs/output-ui-guidelines.md. */
export function sectionRule(theme: ThemeAdapter, label: string, width: number): string {
  const head = `${theme.fg("muted", label)} `;
  const fill = Math.max(0, width - visibleWidth(head));
  return truncateToWidth(head + theme.fg("dim", "─".repeat(fill)), width, "");
}
