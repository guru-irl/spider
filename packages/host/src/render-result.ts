// packages/host/src/render-result.ts
// pi `ToolDefinition.renderResult` for the spider tool. With renderShell:"default"
// pi paints the standard green/red tool shell and uses the tool `label` ("🕸 spider")
// as the title, so renderResult renders only the BODY (no header of its own — that
// would double the "spider"). `options.expanded` reflects the in-chat Ctrl+O toggle;
// `context.args` are the call params; `result.details` is the structured payload.
import { truncateToWidth, visibleWidth, Box, Spacer, Container } from "@earendil-works/pi-tui";
import type { Component } from "@spider/ui";
import { renderExecResult, renderIndexResult, renderMessageResult, renderTodoChecklist, renderStats, renderInsights, renderModels, renderConfig, sectionRule, type ExecDetails, type ExecKind, type IndexDetails, type MessageDetails, type TodoChecklistDetails, type StatsSummary, type InsightGraphView, type ThemeAdapter } from "@spider/ui";
import {
  renderRememberResult,
  renderRecallResult,
  renderPending,
  type StageResult,
  type MemoryRecord,
} from "@spider/memory";
import { renderImportResult } from "@spider/context";
import type { ModelEntry } from "@spider/models";
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

/** Build a ThemeAdapter (fg/bg/bold/glyph) for the pure @spider/ui renderers from the host `T`. */
function adaptTheme(t: T): ThemeAdapter {
  return { fg: (tok, s) => t.fg(tok, s), bg: (tok, s) => t.bg(tok, s), bold: (s) => t.bold(s), italic: (s) => t.italic(s), glyph: "🕸" };
}

const SEARCH_GLYPH: Record<string, string> = { memory: "◆", content: "▪", todo: "▣", message: "✉" };

/** Unified-search hits rendered in the parallel-run style (renderRun/runBlock): a leading
 *  blank, a muted count line, then one 2-line block per hit — `n. ◆ title · kind · source`
 *  plus a single-line (collapsed) or wrapped (expanded) snippet. No Panel border, no repeated
 *  🕸 header (the spider call line already shows `🕸 spider · search`). */
function renderSearch(t: T, rows: any, expanded: boolean): Component {
  const list: any[] = Array.isArray(rows) ? rows : [];
  return {
    render(width: number): string[] {
      if (list.length === 0) return ["", t.fg("muted", "   (no results)")];
      const sep = t.fg("dim", "·");
      const lines: string[] = [t.fg("muted", `  ${list.length} result${list.length === 1 ? "" : "s"}`)];
      list.forEach((r, i) => {
        const glyph = t.fg("toolTitle", SEARCH_GLYPH[String(r?.kind)] ?? "•");
        const num = t.fg("dim", `${i + 1}.`);
        const title = t.bold(String(r?.title || "untitled"));
        const kind = t.italic(t.fg("toolTitle", String(r?.kind ?? "")));
        const src = r?.source ? ` ${sep} ${t.fg("muted", String(r.source))}` : "";
        lines.push(clip(`  ${num} ${glyph} ${title} ${sep} ${kind}${src}`, width));
        const snippet = String(r?.snippet ?? "").replace(/\s+/g, " ").trim();
        if (snippet) {
          if (expanded) {
            const body = wrap(snippet, width - 7, 8);
            for (let j = 0; j < body.length; j++) lines.push(`     ${t.fg("dim", (j === 0 ? "↳ " : "  ") + body[j])}`);
          } else {
            lines.push(`     ${t.fg("dim", "↳ " + clip(snippet, Math.max(1, width - 7)))}`);
          }
        }
      });
      if (!expanded && list.some((r) => String(r?.snippet ?? "").length > 0)) {
        lines.push(t.fg("dim", "  ctrl+o to expand"));
      }
      return ["", ...lines];
    },
    invalidate() {},
  };
}

/** Health-check output for `control doctor`. The call line already shows
 *  `🕸 spider · control · doctor`, so this renders only a status line + the checks
 *  (markdown heading/blank lines dropped, `- ` bullets stripped) with a `⎿` gutter. */
function renderDoctor(t: T, details: any): Component {
  const ok = details?.ok !== false;
  const raw: string[] = Array.isArray(details?.lines) ? details.lines : [];
  const checks = raw
    .map((l) => String(l))
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
  return {
    render(width: number): string[] {
      const glyph = t.fg("toolTitle", ok ? "✓" : "✗");
      const out = ["", clip(` ${glyph} ${t.fg("muted", ok ? "all checks passed" : "issues found")}`, width)];
      for (const c of checks) {
        const idx = c.indexOf(":");
        if (idx > 0) {
          const label = t.bold(c.slice(0, idx));
          const rest = t.fg("muted", c.slice(idx + 1).trim());
          out.push(clip(` ${t.fg("dim", "⎿ ")}${label}${t.fg("dim", ":")} ${rest}`, width));
        } else {
          out.push(clip(` ${t.fg("dim", "⎿ ")}${t.fg("muted", c)}`, width));
        }
      }
      return out;
    },
    invalidate() {},
  };
}

/** `control insights` — render the organism learning graph (nodes/edges/stats) as a 🕸
 *  insights card. Never throws on a missing/partial graph. */
function renderControlInsights(t: T, details: any, expanded: boolean): Component {
  const th = adaptTheme(t);
  const g: InsightGraphView = details && Array.isArray(details.nodes)
    ? details
    : { nodes: [], edges: [], stats: { nodes: 0, edges: 0, linkedPct: 0 } };
  return { render: (w: number) => ["", ...renderInsights(g, th, w, expanded)], invalidate() {} };
}

/** `control stats` — render the StatsSummary details as a body-only stats view (leading blank
 *  for the gutter style; the tool shell owns the header). Never throws on a missing/partial summary. */
function renderControlStats(t: T, details: any): Component {
  const th = adaptTheme(t);
  const summary: StatsSummary = details ?? { tokenSavings: { indexedChunks: 0, estTokensSaved: 0 }, rowCounts: {}, models: [] };
  return { render: (w: number) => ["", ...renderStats(summary, th, w)], invalidate() {} };
}

/** `control models` — render the copilot catalog (tier-grouped, availability + role defaults)
 *  as a body-only models view. The `--set` path returns only a confirmation payload; render that as
 *  a single status line. Never throws on a missing/partial payload. */
function renderControlModels(t: T, details: any, _expanded: boolean): Component {
  const th = adaptTheme(t);
  if (details && details.catalog === undefined && (details.ok !== undefined || details.error !== undefined)) {
    const line = details.ok
      ? th.fg("accent", "●") + " " + th.fg("text", `set ${String(details.role ?? "")} → ${String(details.ref ?? "")}`)
      : th.fg("error", "✗") + " " + th.fg("text", String(details.error ?? "failed"));
    return { render: (w: number) => ["", truncateToWidth(line, w, "")], invalidate() {} };
  }
  const catalog: ModelEntry[] = Array.isArray(details?.catalog) ? details.catalog : [];
  const defaults: Record<string, string> = (details?.defaults as Record<string, string>) ?? {};
  return { render: (w: number) => ["", ...renderModels(catalog, defaults, th, w)], invalidate() {} };
}

/** `control config` — render the schema × current values as a body-only config view. The `set`
 *  path returns only a confirmation payload; render that as a single status line. Never throws. */
function renderControlConfig(t: T, details: any, _expanded: boolean): Component {
  const th = adaptTheme(t);
  if (details && details.config && typeof details.config === "object") {
    return { render: (w: number) => ["", ...renderConfig(details.config, th, w)], invalidate() {} };
  }
  if (details && (details.ok !== undefined || details.error !== undefined)) {
    const line = details.error
      ? th.fg("error", "✗") + " " + th.fg("text", String(details.error))
      : th.fg("accent", "●") + " " + th.fg("text", `set ${String(details.key ?? "")} → ${String(details.value ?? "")}`);
    return { render: (w: number) => ["", truncateToWidth(line, w, "")], invalidate() {} };
  }
  return textComponent({ details });
}

/** `control memory consolidate` — body-only active-memory list: a `memory · N active · X chars`
 *  rule, then one `◆ [category] content` line per active entry. Never throws on a partial payload. */
function renderControlMemory(t: T, details: any): Component {
  const th = adaptTheme(t);
  const entries: any[] = Array.isArray(details?.entries) ? details.entries : [];
  const usage = Number(details?.usage ?? 0);
  return {
    render(w: number): string[] {
      const out = ["", sectionRule(th, `memory · ${entries.length} active · ${usage} chars`, w)];
      if (!entries.length) out.push(truncateToWidth(th.fg("dim", " (no active memories)"), w, ""));
      for (const e of entries) {
        const cat = th.fg("accent", `[${String(e?.category ?? "?")}]`);
        out.push(truncateToWidth(` ${th.fg("dim", "◆")} ${cat} ${th.fg("text", String(e?.content ?? ""))}`, w, ""));
      }
      return out;
    },
    invalidate() {},
  };
}

/** Map the raw executor result(s) → ExecDetails for renderExecResult. */
function toExecDetails(action: string, args: any, details: any): ExecDetails {
  const kind = action as ExecKind;
  if (action === "batch") {
    const arr: any[] = Array.isArray(details) ? details : [];
    const ok = arr.length > 0 && arr.every((r) => Number(r?.exitCode ?? 0) === 0);
    const outLines = arr.reduce((n, r) => n + String(r?.stdout ?? "").split("\n").filter(Boolean).length, 0);
    const preview = arr.flatMap((r) => String(r?.stdout ?? "").split("\n").filter(Boolean)).slice(-8);
    const commands = (args?.commands ?? []).map((c: any) => String(c?.label ?? c?.code ?? c?.language ?? "cmd"));
    return { kind, commands, ok, exitCode: ok ? 0 : 1, outLines, preview };
  }
  const r = details ?? {};
  const outArr = String(r.stdout ?? "").split("\n").filter(Boolean);
  const cmd = action === "exec_file" ? String(args?.path ?? "file") : String(args?.code ?? "");
  return { kind, commands: [cmd], ok: Number(r.exitCode ?? 0) === 0, exitCode: Number(r.exitCode ?? 0), outLines: outArr.length, preview: outArr.slice(-8) };
}

/** Map the indexContent result → IndexDetails for renderIndexResult (index action only). */
function toIndexDetails(args: any, details: any): IndexDetails {
  const r = details ?? {};
  const target = args?.path ? String(args.path) : "content";
  const chunks = Number(r.chunkCount ?? 0);
  return { kind: "index", source: String(r.source ?? args?.source ?? "untitled"), targets: [target], chunks, embedded: chunks };
}

/** Map the runFetch result → IndexDetails (kind:"fetch") for renderIndexResult. */
function toFetchDetails(_args: any, details: any): IndexDetails {
  const sources: string[] = Array.isArray(details?.sources) ? details.sources.map(String) : [];
  const urls: string[] = Array.isArray(details?.urls) ? details.urls.map(String) : [];
  const source = sources.length === 1 ? sources[0] : `${details?.count ?? sources.length} source(s)`;
  const chunks = Number(details?.chunks ?? 0);
  return { kind: "fetch", source, targets: sources, chunks, embedded: Number(details?.embedded ?? chunks), urls };
}

/** Map the intercom message args+result → MessageDetails for renderMessageResult. */
function toMessageDetails(args: any, details: any): MessageDetails {
  const kind = String(args?.kind ?? "");
  const verb: MessageDetails["verb"] = kind === "ask" ? "ask" : kind === "reply" ? "reply" : kind === "broadcast" ? "broadcast" : "send";
  return { verb, to: args?.to ? String(args.to) : undefined, kind: kind || undefined, body: String(args?.message ?? ""), delivered: details?.delivered === true };
}

/** Normalize the todo action's varied `details` (single Todo | Todo[] | SessionSummary[] |
 *  SessionGroup[] | {ok}) into a TodoChecklistDetails for renderTodoChecklist. Never throws. */
function toTodoDetails(args: any, details: any): TodoChecklistDetails {
  const toItem = (x: any) => ({ id: Number(x?.seq ?? x?.id ?? 0), text: String(x?.text ?? ""), done: x?.done === true });
  let items: { id: number; text: string; done: boolean }[] = [];
  let scope = "session";
  if (Array.isArray(details)) {
    if (details.length && Array.isArray(details[0]?.todos)) {
      // view → SessionGroup[]: flatten, label each todo with its session
      scope = "all";
      for (const g of details) {
        const label = String(g?.name ?? g?.session ?? "");
        for (const td of (g?.todos ?? [])) items.push({ ...toItem(td), text: `[${label}] ${td?.text ?? ""}` });
      }
    } else if (details.length && details[0]?.total !== undefined && details[0]?.session !== undefined) {
      // sessions → SessionSummary[]
      scope = "sessions";
      items = details.map((s: any, i: number) => ({
        id: i + 1,
        text: `${s?.current ? "▸ " : ""}${s?.name ?? s?.session} — ${s?.done ?? 0}/${s?.total ?? 0}`,
        done: (s?.total ?? 0) > 0 && (s?.done ?? 0) >= (s?.total ?? 0),
      }));
    } else {
      // list → Todo[]
      items = details.map(toItem);
    }
  } else if (details && (details.seq !== undefined || details.text !== undefined)) {
    // add/toggle → single Todo
    items = [toItem(details)];
  }
  const done = items.filter((it) => it.done).length;
  return { scope, items, done, total: items.length };
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
    case "exec":
    case "exec_file":
    case "batch": {
      const d = toExecDetails(action, context?.args, details);
      const th = adaptTheme(t);
      return { render: (w: number) => renderExecResult(d, { theme: th, width: w, expanded }), invalidate() {} };
    }
    case "index": {
      const d = toIndexDetails(context?.args, details);
      const th = adaptTheme(t);
      return { render: (w: number) => renderIndexResult(d, { theme: th, width: w, expanded }), invalidate() {} };
    }
    case "fetch": {
      const d = toFetchDetails(context?.args, details);
      const th = adaptTheme(t);
      return { render: (w: number) => renderIndexResult(d, { theme: th, width: w, expanded }), invalidate() {} };
    }
    case "message": {
      const d = toMessageDetails(context?.args, details);
      const th = adaptTheme(t);
      return { render: (w: number) => renderMessageResult(d, { theme: th, width: w }), invalidate() {} };
    }
    case "remember": return wrapBespoke(renderRememberResult(details as StageResult));
    case "recall": return wrapBespoke(renderRecallResult(details as MemoryRecord[]));
    case "todo": {
      const d = toTodoDetails(context?.args, details);
      const th = adaptTheme(t);
      return { render: (w: number) => renderTodoChecklist(d, { theme: th, width: w }), invalidate() {} };
    }
    case "search": return renderSearch(t, details, expanded);
    case "import": return wrapBespoke(renderImportResult(details as any));
    case "control":
      if (sub === "pending") return wrapBespoke(renderPending(details as MemoryRecord[]));
      if (sub === "doctor") return renderDoctor(t, details);
      if (sub === "stats") return renderControlStats(t, details);
      if (sub === "models") return renderControlModels(t, details, expanded);
      if (sub === "config") return renderControlConfig(t, details, expanded);
      if (sub === "insights") return renderControlInsights(t, details, expanded);
      if (sub === "migrate") return wrapBespoke(renderImportResult(details as any));
      if (sub === "consolidate") return renderControlMemory(t, details);
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
  } else if (action === "exec" || action === "exec_file" || action === "batch") {
    // The command / file / code is rendered in the RESULT body (above the output, white,
    // truncated, ctrl+o to expand) — NOT on the header line. Keep the header to the bare verb.
    suffix = verb(action);
  }
  const line = `${t.fg("toolTitle", "🕸")}  ${t.fg("toolTitle", t.bold("spider"))} ${t.fg("toolTitle", "·")} ${suffix}`;
  return { render: (w: number) => [clip(line, w)], invalidate() {} };
}

/** Transcript renderer for the async `spider.subagent_done` message. Reuses pi's OWN tool-shell
 *  primitives (a Spacer + a Box painted with the toolSuccessBg/toolErrorBg background, exactly as
 *  ToolExecutionComponent does) wrapping the SAME renderers a live spider tool call uses
 *  (renderSpiderCall for the title + renderSpiderResult for the body) — so the completion is
 *  pixel-identical to a real spider run result. ctrl+o (options.expanded) expands the output. */
export function renderSubagentDone(message: any, options: { expanded?: boolean }, theme: any): Component {
  const d = message?.details ?? {};
  const status = String(d.status ?? "done");
  const isError = status === "failed" || status === "cancelled";
  const bgFn = isError
    ? (text: string) => (typeof theme?.bg === "function" ? theme.bg("toolErrorBg", text) : text)
    : (text: string) => (typeof theme?.bg === "function" ? theme.bg("toolSuccessBg", text) : text);
  const expanded = options?.expanded === true;
  // Feed the same shape a real `spider run` produces: a title (renderCall) + a single run block
  // (renderResult) carrying the child's name/agent/model/status and its output as the result.
  const args = { action: "run" };
  const result = { details: { run: { name: d.name, agent: d.agent, model: d.model, thinking: d.thinking, status, result: d.output } } };
  const box = new Box(1, 1, bgFn);
  box.addChild(renderSpiderCall(args, theme, {}) as any);
  box.addChild(renderSpiderResult(result, { expanded }, theme, { args }) as any);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(box as any);
  return container as unknown as Component;
}
