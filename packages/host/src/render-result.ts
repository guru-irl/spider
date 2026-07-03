// packages/host/src/render-result.ts
// pi `ToolDefinition.renderResult` for the spider tool. pi calls this with
//   renderResult: (result, options, theme, context) => Component
// where `options.expanded` reflects the in-chat expand toggle (Ctrl+O),
// `context.args` are the spider call params ({ action, name, task, tasks, ... }),
// `result.details` is the handler's structured payload and `result.content` the
// model-facing text. Every spider result is rendered with the 🕸 glyph header plus
// an action-specific body; `run` shows agent name(s), a grey #run-id, status, and
// instructions that expand under Ctrl+O.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@spider/ui";
import {
  renderRememberResult,
  renderRecallResult,
  renderPending,
  type StageResult,
  type MemoryRecord,
} from "@spider/memory";
import { renderSearchResult, renderImportResult } from "@spider/context";

const ANSI = /\x1b\[[0-9;]*m/g;
const GLYPH = "🕸";
const SG: Record<string, string> = { queued: "○", running: "◆", paused: "■", done: "✓", failed: "✗", cancelled: "⚠" };
const STOK: Record<string, string> = { done: "success", failed: "error", cancelled: "warning", running: "accent", queued: "muted", paused: "muted" };

interface T { fg(tok: string, s: string): string; bold(s: string): string; }
function mkTheme(theme: any): T {
  return {
    fg: (tok, s) => (typeof theme?.fg === "function" ? theme.fg(tok, s) : s),
    bold: (s) => (typeof theme?.bold === "function" ? theme.bold(s) : s),
  };
}
function clip(s: string, w: number): string { return visibleWidth(s) > w ? truncateToWidth(s, w, "…") : s; }
function wrap(text: string, w: number, max: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const out: string[] = []; let cur = "";
  for (const word of words) {
    const cand = cur ? cur + " " + word : word;
    if (visibleWidth(cand) > w && cur) { out.push(cur); cur = word; } else { cur = cand; }
    if (out.length >= max) { cur = ""; break; }
  }
  if (cur && out.length < max) out.push(cur);
  return out.slice(0, max).map((l) => clip(l, w));
}
function headerLine(t: T, action: string, summary: string): string {
  return `${t.fg("accent", GLYPH)} ${t.bold("spider")} ${t.fg("dim", "·")} ${t.fg("accent", action)}${summary ? t.fg("muted", " · " + summary) : ""}`;
}

/** Compose a 🕸 header above any body component so EVERY spider result is glyphed. */
function withHeader(t: T, action: string, summary: string, body: Component): Component {
  return {
    render: (w: number) => [clip(headerLine(t, action, summary), w), ...body.render(w)],
    invalidate: () => body.invalidate?.(),
  };
}

function textComponent(result: any): Component {
  const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
  const raw = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  return {
    render: (w: number) => raw.replace(ANSI, "").split("\n").map((l) => clip(l, w)),
    invalidate() {},
  };
}

interface RunLike { id?: string; name?: string; agent?: string; status?: string; task?: string }

/** Render one run's block: `▸ name  status · #id` + expandable instructions. */
function runBlock(t: T, r: RunLike, width: number, expanded: boolean, indent: string): string[] {
  const status = r.status ?? "running";
  const glyph = t.fg(STOK[status] ?? "muted", SG[status] ?? "•");
  const name = t.bold(r.name ?? r.agent ?? "agent");
  const id = t.fg("dim", "#" + String(r.id ?? "").slice(0, 8));
  const head = clip(`${indent}${glyph} ${name}  ${t.fg(STOK[status] ?? "muted", status)} ${t.fg("dim", "·")} ${id}`, width);
  const lines = [head];
  const task = (r.task ?? "").trim();
  if (task) {
    const body = expanded ? wrap(task, width - indent.length - 4, 12) : [clip(task, width - indent.length - 4)];
    for (let i = 0; i < body.length; i++) lines.push(`${indent}  ${t.fg("muted", (i === 0 ? "↳ " : "  ") + body[i])}`);
  }
  return lines;
}

function renderRun(t: T, details: any, expanded: boolean): Component {
  const runs: RunLike[] = Array.isArray(details?.runs) ? details.runs : details?.run ? [details.run] : [];
  return {
    render(width: number): string[] {
      if (runs.length === 0) return [t.fg("muted", "  (no runs)")];
      const lines: string[] = [];
      const multi = runs.length > 1;
      for (const r of runs) { lines.push(...runBlock(t, r, width, expanded, multi ? "  " : "  ")); if (multi) lines.push(""); }
      const anyTask = runs.some((r) => (r.task ?? "").trim());
      if (!expanded && anyTask) lines.push(t.fg("dim", "  ctrl+o to expand instructions"));
      return lines;
    },
    invalidate() {},
  };
}

export function renderSpiderResult(
  result: any,
  options: any,
  theme: any,
  context: any,
): Component {
  const t = mkTheme(theme);
  const expanded = options?.expanded === true;
  const action = String(context?.args?.action ?? "");
  const sub = String(context?.args?.sub ?? context?.args?.command ?? "");
  const details = result?.details;

  switch (action) {
    case "run": {
      const mode = Array.isArray(context?.args?.pipeline) ? "pipeline"
        : Array.isArray(context?.args?.chain) ? "chain"
        : Array.isArray(context?.args?.tasks) ? "parallel" : "single";
      const n = Array.isArray(details?.runs) ? details.runs.length : details?.run ? 1 : 0;
      const summary = mode === "single" ? "" : `${mode} · ${n} ${context?.args?.async ? "started" : "run(s)"}`;
      return withHeader(t, "run", summary, renderRun(t, details, expanded));
    }
    case "remember": return withHeader(t, "remember", "", wrapBespoke(renderRememberResult(details as StageResult)));
    case "recall": return withHeader(t, "recall", "", wrapBespoke(renderRecallResult(details as MemoryRecord[])));
    case "search": return withHeader(t, "search", "", wrapBespoke(renderSearchResult(details as any)));
    case "import": return withHeader(t, "import", "", wrapBespoke(renderImportResult(details as any)));
    case "control":
      if (sub === "pending") return withHeader(t, "control", "pending", wrapBespoke(renderPending(details as MemoryRecord[])));
      return withHeader(t, "control", sub, textComponent(result));
    default:
      return withHeader(t, action || "spider", sub, textComponent(result));
  }
}

/** @spider/ui Components return { render } only; add invalidate for pi. */
function wrapBespoke(c: Component): Component {
  return { render: (w: number) => c.render(w), invalidate: () => c.invalidate?.() };
}
