// packages/host/src/render-result.ts
// pi `ToolDefinition.renderResult` for the spider tool. With renderShell:"default"
// pi paints the standard green/red tool shell and uses the tool `label` ("🕸 spider")
// as the title, so renderResult renders only the BODY (no header of its own — that
// would double the "spider"). `options.expanded` reflects the in-chat Ctrl+O toggle;
// `context.args` are the call params; `result.details` is the structured payload.
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
const SG: Record<string, string> = { queued: "○", running: "◆", paused: "■", done: "✓", failed: "✗", cancelled: "⚠" };

interface T { fg(tok: string, s: string): string; bold(s: string): string; italic(s: string): string; bg(tok: string, s: string): string; }
function mkTheme(theme: any): T {
  return {
    fg: (tok, s) => (typeof theme?.fg === "function" ? theme.fg(tok, s) : s),
    bold: (s) => (typeof theme?.bold === "function" ? theme.bold(s) : s),
    italic: (s) => (typeof theme?.italic === "function" ? theme.italic(s) : s),
    bg: (tok, s) => (typeof theme?.bg === "function" ? theme.bg(tok, s) : s),
  };
}
function clip(s: string, w: number): string { return visibleWidth(s) > w ? truncateToWidth(s, w, "…") : s; }
function shortModel(m?: string | null): string { if (!m) return "—"; return (m.split("/").pop() ?? m).replace(/^claude-/, ""); }
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

function textComponent(result: any): Component {
  const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
  const raw = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  return {
    render: (w: number) => raw.replace(ANSI, "").split("\n").map((l) => clip(l, w)),
    invalidate() {},
  };
}

interface RunLike { id?: string; name?: string; agent?: string; model?: string | null; thinking?: string | null; status?: string; task?: string; result?: string | null }

/** One run block, ONE header line: `◆ name · type · model · status` + expandable instructions. */
function runBlock(t: T, r: RunLike, width: number, expanded: boolean): string[] {
  const status = r.status ?? "running";
  const glyph = t.fg("toolTitle", SG[status] ?? "•");
  const name = t.bold(r.name ?? r.agent ?? "agent");
  const sep = t.fg("dim", "·");
  const thinkSeg = r.thinking ? ` ${sep} ${t.fg("muted", r.thinking)}` : "";
  const head = `  ${glyph} ${name} ${sep} ${t.italic(t.fg("toolTitle", r.agent ?? "worker"))} ${sep} ${t.fg("muted", shortModel(r.model))}${thinkSeg} ${sep} ${t.fg("muted", status)}`;
  const lines = [clip(head, width)];
  const task = (r.task ?? "").trim();
  if (task) {
    const body = expanded ? wrap(task, width - 6, 12) : [clip(task, width - 6)];
    for (let i = 0; i < body.length; i++) lines.push(`    ${t.fg("muted", (i === 0 ? "↳ " : "  ") + body[i])}`);
  }
  // Subagent output: collapsed to the first 2 lines by default, full on ctrl+o (expanded).
  const out = (r.result ?? "").trim();
  if (out) {
    const outLines = out.split("\n");
    const shown = expanded ? outLines : outLines.slice(0, 2);
    for (let i = 0; i < shown.length; i++) lines.push(`    ${t.fg("dim", (i === 0 ? "⤴ " : "  ") + clip(shown[i], width - 6))}`);
    if (!expanded && outLines.length > 2) lines.push(`    ${t.fg("dim", `  … (+${outLines.length - 2} more lines)`)}`);
  }
  return lines;
}

function renderRun(t: T, details: any, expanded: boolean): Component {
  const runs: RunLike[] = Array.isArray(details?.runs) ? details.runs : details?.run ? [details.run] : [];
  return {
    render(width: number): string[] {
      if (runs.length === 0) return ["", t.fg("muted", "   (no runs)")];
      const lines: string[] = [];
      const multi = runs.length > 1;
      for (const r of runs) { lines.push(...runBlock(t, r, width, expanded)); if (multi) lines.push(""); }
      const anyTask = runs.some((r) => (r.task ?? "").trim());
      const anyOut = runs.some((r) => (r.result ?? "").trim().split("\n").length > 2);
      if (!expanded && (anyTask || anyOut)) lines.push(t.fg("dim", `  ctrl+o to expand${anyOut ? " output" : " instructions"}`));
      return ["", ...lines.map((l) => (l === "" ? l : " " + l))];
    },
    invalidate() {},
  };
}

/** @spider/ui Components return { render } only; add invalidate for pi. */
function wrapBespoke(c: Component): Component {
  return { render: (w: number) => c.render(w), invalidate: () => c.invalidate?.() };
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
    case "run":
      return renderRun(t, details, expanded);
    case "remember": return wrapBespoke(renderRememberResult(details as StageResult));
    case "recall": return wrapBespoke(renderRecallResult(details as MemoryRecord[]));
    case "search": return wrapBespoke(renderSearchResult(details as any));
    case "import": return wrapBespoke(renderImportResult(details as any));
    case "control":
      if (sub === "pending") return wrapBespoke(renderPending(details as MemoryRecord[]));
      return textComponent(result);
    default:
      return textComponent(result);
  }
}

/** In-progress CALL title. renderCall REPLACES the title (pi does NOT prepend the tool
 *  label), so this renders the FULL header using the SAME 'toolTitle' colour pi uses for its
 *  own tool titles (glyph + all text). UI STANDARD: the action VERB (run/parallel/remember/
 *  recall/search/exec/…) is always italicised; separators, counts, and sub-commands are not. */
export function renderSpiderCall(args: any, theme: any, _context: any): Component {
  const t = mkTheme(theme);
  const action = String(args?.action ?? "");
  const verb = (v: string) => t.italic(t.fg("toolTitle", v)); // universal: verbs are italicised
  let suffix = verb(action || "run");
  if (action === "run") {
    const mode = Array.isArray(args?.pipeline) ? "pipeline"
      : Array.isArray(args?.chain) ? "chain"
      : Array.isArray(args?.tasks) ? "parallel" : "single";
    const n = Array.isArray(args?.tasks) ? args.tasks.length
      : Array.isArray(args?.chain) ? args.chain.length
      : Array.isArray(args?.pipeline) ? args.pipeline.length : 1;
    suffix = mode === "single"
      ? verb("run")
      : `${verb(mode)} ${t.fg("toolTitle", `· ${n} started`)}`;
  } else if (args?.sub || args?.command) {
    suffix = `${verb(action)} ${t.fg("toolTitle", `· ${args.sub ?? args.command}`)}`;
  }
  const line = `${t.fg("toolTitle", "🕸")}  ${t.fg("toolTitle", t.bold("spider"))} ${t.fg("toolTitle", "·")} ${suffix}`;
  return { render: (w: number) => [clip(line, w)], invalidate() {} };
}

/** Transcript renderer for the async `spider.subagent_done` message, styled to look like the
 *  spider TOOL CALL: the green (or red) tool shell + the tool title
 *  "🕸  spider · *subagent* · <name> · <status>", with the curated output rendered like
 *  truncated tool output. ctrl+o (options.expanded) reveals the COMPLETE output. */
export function renderSubagentDone(message: any, options: { expanded?: boolean }, theme: any): Component {
  const t = mkTheme(theme);
  const d = message?.details ?? {};
  const name = String(d.name ?? "subagent");
  const agent = String(d.agent ?? "worker");
  const model = d.model as string | null | undefined;
  const status = String(d.status ?? "done");
  const output = String(d.output ?? "").replace(/\s+$/, "");
  const bgTok = status === "done" ? "toolSuccessBg" : status === "running" || status === "queued" || status === "paused" ? "toolPendingBg" : "toolErrorBg";
  const sep = t.fg("toolTitle", "·");
  // Exact spider tool-title format: glyph + two spaces + bold "spider" + italic verb + name + status.
  // Footer/run-block format: glyph + bold "spider" + name + italic agent + model + status.
  const header = `${t.fg("toolTitle", "🕸")}  ${t.fg("toolTitle", t.bold("spider"))} ${sep} ${t.fg("toolTitle", name)} ${sep} ${t.italic(t.fg("toolTitle", agent))} ${sep} ${t.fg("muted", shortModel(model))} ${sep} ${t.fg("toolTitle", status)}`;
  const lines = output ? output.split("\n") : [];
  const CAP = 6;
  const expanded = options?.expanded === true;
  const shown = expanded ? lines : lines.slice(0, CAP);
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
  return {
    render(w: number): string[] {
      const rows: string[] = [header];
      if (shown.length) for (const l of shown) rows.push("  " + t.fg("toolOutput", clip(l, Math.max(1, w - 2))));
      else rows.push("  " + t.fg("toolOutput", "(no output)"));
      if (!expanded && lines.length > CAP) rows.push("  " + t.fg("dim", `… (+${lines.length - CAP} more lines) · ctrl+o to expand`));
      // Paint the tool shell across the full width so it reads as a spider tool block.
      return rows.map((r) => t.bg(bgTok, pad(r, w)));
    },
    invalidate() {},
  };
}
