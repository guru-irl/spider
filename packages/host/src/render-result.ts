// packages/host/src/render-result.ts
// pi `ToolDefinition.renderResult` for the spider tool. With renderShell:"default"
// pi paints the standard tool shell and renderCall supplies its title, so
// renderResult renders only the BODY. `options.expanded` reflects the in-chat Ctrl+O toggle;
// `context.args` are the call params; `result.details` is the structured payload.
import { truncateToWidth, visibleWidth, stripTerminalSequences, type Component as PiComponent } from "@earendil-works/pi-tui";
import { icon, type Component, type IconStyle } from "@spider/ui";
import { isAgentModelRole, cachedLines, shortModel, renderRoleAccent, formatRunUsage, renderErrorResult, renderExecCall, renderExecResult, renderIndexResult, renderMessageResult, renderKillResult, renderTodoChecklist, renderStats, renderInsights, renderModels, renderConfig, renderBindResult, renderMigrateResult, renderEscalation, statusIcon, fitResultLines, cardDetailIndent, flushLeft, type ExecDetails, type ExecKind, type IndexDetails, type MessageDetails, type KillDetails, type TodoChecklistDetails, type BindDetails, type MigrateDetails, type StatsSummary, type InsightGraphView, type EscalationDetails, type ThemeAdapter, type RunUsageCosts, type RunCostFormatter } from "@spider/ui";
import {
  renderRememberResult,
  renderRecallResult,
  renderPending,
  type StageResult,
  type MemoryRecord,
} from "@spider/memory";
import { renderImportResult, isKnownFailureOutcome, foregroundTimedOut, isExecError } from "@spider/context";
import type { ModelEntry } from "@spider/models";
import { renderSkillList, renderSkillView, renderDistill, renderCurateResult, type DrainReport, type SkillRow } from "@spider/organism";
import { UI_CONFIG_SCHEMA, modelThinkingDisplay } from "./ui-thinking";
import { createHalfBox } from "./input-band/box.js";
import { reopenBackground } from "./input-band/ansi.js";
import { toToolResult } from "./result";
import { makeRunCostFormatter } from "./run-credits";
import { restoreExecDetails } from "./exec-session-storage";
import { piTheme } from "./agents/theme-adapter";

interface T { fg(tok: string, s: string): string; bold(s: string): string; italic(s: string): string; bg(tok: string, s: string): string; iconStyle?: IconStyle; modelName?: (model: string) => string | undefined; roleTint?: ThemeAdapter["roleTint"]; }
function mkTheme(theme: any, iconStyle?: IconStyle): T {
  // Theme.fg/bg THROW on a token the active theme lacks; swallow it so one unknown token never
  // aborts a whole render (pi's CustomMessageComponent would silently fall back to raw content).
  const guard = (fn: any, tok: string, s: string): string => {
    if (typeof fn !== "function") return s;
    try { return fn(tok, s); } catch { return s; }
  };
  const roleTint = typeof theme?.fg === "function" ? piTheme(theme, iconStyle).roleTint : undefined;
  return {
    iconStyle,
    roleTint: roleTint ? (hex, s, strength) => { try { return roleTint(hex, s, strength); } catch { return guard(theme?.fg?.bind(theme), "accent", s); } } : undefined,
    fg: (tok, s) => guard(theme?.fg?.bind(theme), tok, s),
    bold: (s) => { try { return typeof theme?.bold === "function" ? theme.bold(s) : s; } catch { return s; } },
    italic: (s) => { try { return typeof theme?.italic === "function" ? theme.italic(s) : s; } catch { return s; } },
    bg: (tok, s) => guard(theme?.bg?.bind(theme), tok, s),
  };
}
function cardBackground(context: any): string {
  return context?.cardBackground ?? (context?.isPartial ? "toolPendingBg" : context?.isError ? "toolErrorBg" : "toolSuccessBg");
}

/** A Box wraps its children, so an SGR reset inside a child must reopen its background. */
function restoreCardBackground(lines: string[], theme: any, background: string): string[] {
  const marker = "\0";
  const sample = mkTheme(theme).bg(background, marker);
  const open = sample.slice(0, sample.indexOf(marker));
  return open ? lines.map(line => reopenBackground(line, open)) : lines;
}

function clip(s: string, w: number): string { return visibleWidth(s) > w ? truncateToWidth(s, w, "…") : s; }
function nonblankLines(text: string): string[] { return text.split(/\r?\n/u).filter(line => stripTerminalSequences(line).trim()); }
function textComponent(result: any, expanded = false): Component {
  const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
  const raw = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  const lines = nonblankLines((expanded ? raw : raw.replace(/\x1b\[[0-9;]*m/g, "")).trim());
  if (lines.length) lines[0] = lines[0].replace(/^(?:[ \t]*\x1b\[[0-9;]*m)*[ \t]*/u, prefix => prefix.replace(/[ \t]/gu, ""));
  return {
    render: (w: number) => fitResultLines(lines.map(line => line.trim() ? ` ${line}` : ""), w, expanded, 3),
    invalidate() {},
  };
}

function plainBody(text: string, expanded = false): Component {
  // The tool title already identifies the surface; drop only its duplicate heading.
  return textComponent({ content: [{ type: "text", text: text.replace(/^## [^\n]*\n?/, "") }] }, expanded);
}

interface RunLike { token_count?: number; cost?: number; usageCosts?: RunUsageCosts; costText?: string; compactionCount?: number; id?: string; name?: string; agent?: string; model?: string | null; thinking?: string | null; status?: string; task?: string; result?: string | null }

/** Wrap the text after a row marker, with continuations in column 3. */
function cardRow(prefix: string, text: string, width: number, expanded: boolean): string[] {
  return fitResultLines([prefix + text], width, expanded, 3);
}

function runBlock(t: T, r: RunLike, width: number, expanded: boolean, formatRunCost: RunCostFormatter, includeSubject: boolean): string[] {
  const status = r.status ?? "running";
  const glyph = t.fg(status === "failed" ? "error" : status === "cancelled" ? "warning" : status === "done" ? "success" : "toolTitle",
    status === "failed" ? icon(t.iconStyle, "failure")
      : status === "cancelled" ? icon(t.iconStyle, "warning")
      : icon(t.iconStyle, status === "done" ? "success" : status === "running" ? "running" : "open"));
  const agent = r.agent ?? "worker";
  const sep = ` ${t.fg("dim", "·")} `;
  const subjects: string[] = [];
  if (includeSubject) {
    if (r.name && r.name !== agent) subjects.push(t.bold(r.name));
    subjects.push(t.italic(renderRoleAccent(adaptTheme(t), agent, agent)));
  }
  // Unlike the indented detail rows, this full-width row gets its lead cell from the box.
  const base = glyph + (subjects.length ? ` ${subjects.join(sep)}` : "");
  const usage = ["done", "failed", "cancelled"].includes(status) && ((r.token_count ?? 0) > 0 || (r.compactionCount ?? 0) > 0)
    ? (subjects.length ? sep : " ") + t.fg("dim", formatRunUsage(r.token_count ?? 0, r.cost, r.compactionCount, r.costText ?? (r.usageCosts ? formatRunCost(r.usageCosts) : undefined)))
    : "";
  const model = t.fg("muted", shortModel(r.model, t.modelName));
  let left = base + usage;
  let right = model + (r.thinking ? sep + t.fg("muted", r.thinking) : "");
  const fits = () => visibleWidth(left) + 1 + visibleWidth(right) <= width;
  if (!fits()) left = base;
  if (!fits()) right = model;
  if (!fits()) right = truncateToWidth(model, Math.max(0, width - visibleWidth(base) - 1), "…");
  const header = right ? left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) + right : left;
  const lines = cardRow("", header, width, expanded);
  const taskLines = nonblankLines((r.task ?? "").trim());
  if (taskLines.length) {
    const [first, ...rest] = taskLines;
    lines.push(...cardRow(`   ${t.fg("muted", icon(t.iconStyle, "task"))} `, t.fg("muted", first), width, expanded));
    if (expanded) for (const line of rest) lines.push(...cardRow("   ", t.fg("muted", line), width, true));
  }
  const out = (r.result ?? "").trim();
  if (out) {
    const outLines = nonblankLines(out);
    const shown = expanded ? outLines : outLines.slice(0, 2);
    for (const [i, line] of shown.entries()) {
      const marker = i === 0 ? `${t.fg("dim", icon(t.iconStyle, "result"))} ` : "";
      lines.push(...cardRow(`   ${marker}`, t.fg("dim", line), width, expanded));
    }
    const remaining = outLines.length - shown.length;
    if (remaining > 0) lines.push(clip(`   ${t.fg("dim", `… ${remaining} more line${remaining === 1 ? "" : "s"}`)}`, width));
  }
  return lines;
}

/** Caps and unverified/off levels are visible, not hidden in serialized details. */
function thinkingNoticeLines(t: T, details: any, width: number, expanded: boolean): string[] {
  const diagnostics: any[] = Array.isArray(details?.thinkingDiagnostics) ? details.thinkingDiagnostics : [];
  return [...new Set(diagnostics.filter(info => info?.effective === "off" || info?.requested !== info?.effective)
    .map(info => info?.notice).filter((notice): notice is string => typeof notice === "string"))]
    .flatMap(notice => cardRow(" ", t.fg("muted", notice), width, expanded));
}

function renderRun(t: T, details: any, expanded: boolean, formatRunCost: RunCostFormatter = makeRunCostFormatter(() => undefined), includeSubject = true): Component {
  const runs: RunLike[] = Array.isArray(details?.runs) ? details.runs : details?.run ? [details.run] : [];
  return {
    render(width: number): string[] {
      const lines = runs.length ? [] : [t.fg("muted", " (no runs)")];
      for (const [i, run] of runs.entries()) {
        if (i > 0) lines.push("");
        lines.push(...runBlock(t, run, width, expanded, formatRunCost, includeSubject));
      }
      lines.push(...thinkingNoticeLines(t, details, width, expanded));
      const anyTask = runs.some((r) => nonblankLines(r.task ?? "").length > 0);
      const anyOut = runs.some((r) => nonblankLines(r.result ?? "").length > 2);
      if (!expanded && (anyTask || anyOut)) lines.push(t.fg("dim", ` ctrl+o to expand${anyOut ? " output" : " instructions"}`));
      return fitResultLines(lines, width, expanded, 3);
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
  return { fg: (tok, s) => t.fg(tok, s), bg: (tok, s) => t.bg(tok, s), bold: (s) => t.bold(s), italic: (s) => t.italic(s), glyph: icon(t.iconStyle, "agent"), iconStyle: t.iconStyle, modelName: t.modelName, roleTint: t.roleTint };
}

const SEARCH_GLYPH = { memory: "active", content: "content", todo: "todo", message: "message" } as const;

/** Render each search hit with its snippet under the shared result count. */
function renderSearch(t: T, rows: any, expanded: boolean): Component {
  const list: any[] = Array.isArray(rows) ? rows : [];
  return {
    render(width: number): string[] {
      if (!list.length) return fitResultLines([t.fg("muted", " (no results)")], width, expanded, 3);
      const sep = t.fg("dim", "·");
      const lines = [t.fg("muted", ` ${list.length} result${list.length === 1 ? "" : "s"}`)];
      const indent = cardDetailIndent(t.iconStyle);
      for (const [i, hit] of list.entries()) {
        if (i > 0) lines.push("");
        const role = SEARCH_GLYPH[String(hit?.kind) as keyof typeof SEARCH_GLYPH] ?? "bullet";
        const glyph = t.fg("toolTitle", icon(t.iconStyle, role));
        const title = t.bold(String(hit?.title || "untitled"));
        const kind = t.fg("toolTitle", String(hit?.kind ?? ""));
        const source = hit?.source ? ` ${sep} ${t.fg("muted", String(hit.source))}` : "";
        lines.push(` ${t.fg("dim", `${i + 1}.`)} ${glyph} ${title} ${sep} ${kind}${source}`);
        const snippet = nonblankLines(String(hit?.snippet ?? "")).join("\n");
        if (snippet) lines.push(indent + t.fg("dim", expanded ? snippet : snippet.replace(/\s+/gu, " ").trim()));
      }
      if (!expanded && list.some(hit => hit?.snippet)) lines.push(t.fg("dim", " ctrl+o to expand"));
      return fitResultLines(lines, width, expanded, 3);
    },
    invalidate() {},
  };
}

/** Health-check output for `control doctor`. The call line supplies the title; this
 *  renders the status and checks under the title, without markdown headings or bullets. */
function renderDoctor(t: T, details: any, expanded: boolean): Component {
  // C-LOW: absence of evidence is neither a passing check nor a failure. Preserve an
  // explicit boolean and render a third, neutral state when malformed/empty input has
  // no `ok` field instead of claiming every check passed.
  const ok: boolean | undefined = details?.ok === true ? true : details?.ok === false ? false : undefined;
  const raw: string[] = Array.isArray(details?.lines) ? details.lines : [];
  const checks = raw
    .map((l) => String(l))
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
  return {
    render(width: number): string[] {
      const clipDoctor = (line: string, w: number) => expanded ? line : clip(line, w);
      const glyph = statusIcon(adaptTheme(t), ok === true ? "ok" : ok === false ? "fail" : "off");
      const summary = ok === true ? "all checks passed" : ok === false ? "issues found" : "check status unknown";
      const out = [clipDoctor(` ${glyph} ${t.fg("muted", summary)}`, width)];
      for (const c of checks) {
        const idx = c.indexOf(":");
        if (idx > 0) {
          const label = t.bold(c.slice(0, idx));
          const rest = t.fg("muted", c.slice(idx + 1).trim());
          out.push(clipDoctor(`${cardDetailIndent(t.iconStyle)}${label}${t.fg("dim", ":")} ${rest}`, width));
        } else {
          out.push(clipDoctor(`${cardDetailIndent(t.iconStyle)}${t.fg("muted", c)}`, width));
        }
      }
      return fitResultLines(out, width, expanded, 3);
    },
    invalidate() {},
  };
}

/** `control insights` — render the organism learning graph as a result body.
 *  Never throws on a missing or partial graph. */
function renderControlInsights(t: T, details: any, expanded: boolean): Component {
  const th = adaptTheme(t);
  const g: InsightGraphView = details && Array.isArray(details.nodes)
    ? details
    : { nodes: [], edges: [], stats: { nodes: 0, edges: 0, linkedPct: 0 } };
  return { render: (w: number) => renderInsights(g, th, w, expanded, true), invalidate() {} };
}

/** Render the stats summary below the tool title. */
function renderControlStats(t: T, details: any, expanded: boolean): Component {
  const th = adaptTheme(t);
  const summary: StatsSummary = details ?? { tokenSavings: { indexedChunks: 0, estTokensSaved: 0 }, rowCounts: {}, models: [] };
  return { render: (w: number) => renderStats(summary, th, w, expanded, true), invalidate() {} };
}

/** `control models` — render the copilot catalog (tier-grouped, availability + role defaults)
 *  as a body-only models view. The `--set` path returns only a confirmation payload; render that as
 *  a single status line. Never throws on a missing/partial payload. */
function renderControlModels(t: T, details: any, expanded: boolean): Component {
  const th = adaptTheme(t);
  if (details && details.catalog === undefined && (details.ok !== undefined || details.error !== undefined)) {
    const role = String(details.role ?? "");
    const roleLabel = isAgentModelRole(role) ? t.italic(role) : role;
    const line = details.ok
      ? statusIcon(th, "ok") + " " + th.fg("text", details.cleared === false
        ? `no local override for ${roleLabel}`
        : details.cleared ? `clear ${roleLabel} (local)`
        : `set ${roleLabel} ${icon(th.iconStyle, "arrowRight")} ${String(details.ref ?? "")} (global)`)
      : th.fg("error", icon(th.iconStyle, "failure")) + " " + th.fg("text", String(details.error ?? "failed"));
    const shadow = details.ok && details.shadowedBy
      ? `This worktree overrides it with ${String(details.shadowedBy.ref)} in ${String(details.shadowedBy.file)}` : "";
    return { render: (w: number) => fitResultLines([` ${line}`, ...(shadow ? [detailRow(t, shadow)] : []), ...renderConfigErrors(t, details)], w, expanded, 3), invalidate() {} };
  }
  const catalog: ModelEntry[] = Array.isArray(details?.catalog) ? details.catalog : [];
  const defaults: Record<string, string> = (details?.defaults as Record<string, string>) ?? {};
  const origins = details?.sources && details?.global ? { sources: details.sources, global: details.global } : undefined;
  return { render: (w: number) => [...renderModels(catalog, defaults, th, w, origins, expanded, modelThinkingDisplay(catalog, defaults), true), ...renderConfigErrors(t, details)], invalidate() {} };
}

function detailRow(t: T, text: string, color = "toolOutput"): string {
  return `${cardDetailIndent(t.iconStyle)}${t.fg(color, text)}`;
}

function renderConfigErrors(t: T, details: any): string[] {
  return Array.isArray(details?.errors) ? details.errors.map((error: unknown) => detailRow(t, String(error), "error")) : [];
}

/** Render current config values or a scoped set/unset confirmation. Never throws. */
function renderControlConfig(t: T, details: any, expanded: boolean): Component {
  const th = adaptTheme(t);
  if (details && details.config && typeof details.config === "object") {
    return { render: (w: number) => [...renderConfig(details.config, th, w, expanded, UI_CONFIG_SCHEMA, true), ...renderConfigErrors(t, details)], invalidate() {} };
  }
  if (details && (details.ok !== undefined || details.error !== undefined)) {
    const line = details.error
      ? th.fg("error", icon(th.iconStyle, "failure")) + " " + th.fg("text", String(details.error))
      : statusIcon(th, "ok") + " " + th.fg("text", `${details.op === "unset" ? "unset" : "set"} ${String(details.key ?? "")}${details.op === "unset" ? "" : ` ${icon(th.iconStyle, "arrowRight")} ${typeof details.value === "object" && details.value !== null ? JSON.stringify(details.value) : String(details.value ?? "")}`}${details.scope ? ` (${String(details.scope)})` : ""}${details.key === "ui.footer" ? " (applies from next session)" : ""}`);
    const destination = details.ok && details.file ? `Config file: ${String(details.file)}` : "";
    const shadow = details.ok && details.shadowedBy ? `Shadowed by ${String(details.shadowedBy)} config` : "";
    return { render: (w: number) => fitResultLines([` ${line}`, ...[destination, shadow].filter(Boolean).map(text => detailRow(t, text))], w, expanded, 3), invalidate() {} };
  }
  if (details?.key !== undefined) {
    const source = details.source === undefined || (details.value === undefined && details.source === "unset")
      ? "" : ` (${typeof details.source === "string" ? details.source : JSON.stringify(details.source)})`;
    return { render: () => [` ${String(details.key)}: ${details.value === undefined ? "(unset)" : typeof details.value === "object" && details.value !== null ? JSON.stringify(details.value) : String(details.value)}${source}`, ...renderConfigErrors(t, details)], invalidate() {} };
  }
  return plainBody("(no configuration)", expanded);
}

/** Active entries are named by category and content, not their storage IDs. */
function renderControlMemory(t: T, details: any, expanded: boolean): Component {
  const entries: any[] = Array.isArray(details?.entries) ? details.entries : [];
  return {
    render(w: number): string[] {
      const out = [t.fg("muted", ` ${entries.length} active · ${Number(details?.usage ?? 0)} chars`)];
      if (!entries.length) out.push(t.fg("dim", " (no active memories)"));
      for (const [i, entry] of entries.entries()) {
        if (i > 0) out.push("");
        out.push(` ${t.fg("dim", icon(t.iconStyle, "active"))} ${t.fg("accent", `[${String(entry?.category ?? "?")}]`)}`);
        const content = nonblankLines(String(entry?.content ?? "")).join("\n");
        if (content) out.push(detailRow(t, expanded ? content : content.replace(/\s+/gu, " ").trim()));
      }
      return fitResultLines(out, w, expanded, 3);
    },
    invalidate() {},
  };
}

function renderUpstreamWatch(t: T, details: any, expanded: boolean): Component {
  if (details?.marked) {
    const { package: name, ref, sha } = details.marked;
    return { render: w => fitResultLines([` ${t.fg("success", icon(t.iconStyle, "success"))} Marked ${name} reviewed at ${sha ?? ref}`], w, expanded, 3), invalidate() {} };
  }
  const packages: any[] = Array.isArray(details?.packages) ? details.packages : [];
  const rows = [` ${packages.length} packages checked · ${details?.todosAdded ?? 0} new cherry-pick todos`];
  for (const [i, pkg] of packages.entries()) {
    if (i > 0) rows.push("");
    const candidates: any[] = Array.isArray(pkg.candidates) ? pkg.candidates : [];
    const state = pkg.state === "up-to-date" ? "up to date" : pkg.state === "candidates" ? `${candidates.length} candidates` : String(pkg.state).replaceAll("-", " ");
    const glyph = statusIcon(adaptTheme(t), pkg.state === "up-to-date" ? "ok" : pkg.state === "candidates" ? "off" : "warn");
    rows.push(` ${glyph} ${pkg.package} · ${state}`);
    if (pkg.reason) rows.push(detailRow(t, String(pkg.reason).split("\n")[0]));
    for (const candidate of candidates) rows.push(detailRow(t, `${String(candidate.commit).slice(0, 7)} ${candidate.subject}`));
  }
  return { render: (w: number) => fitResultLines(rows, w, expanded, 3), invalidate() {} };
}

/** Match pi's truncateTail defaults and reverse byte accounting (core/tools/truncate.js).
 *  The stderr label is presentation only, so it does not consume the output cap. */
function expandedExecTail(action: string, details: any): NonNullable<ExecDetails["expandedOutput"]> {
  const entries = action === "batch" ? (Array.isArray(details) ? details : []) : [details];
  const rows: { text: string; stream: "stdout" | "stderr" }[] = [];
  for (const entry of entries) {
    for (const stream of ["stdout", "stderr"] as const) {
      const text = String(entry?.[stream] ?? "");
      const lines = text === "" ? [] : text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      for (const line of lines) rows.push({ text: line, stream });
    }
  }
  // pi's DEFAULT_MAX_LINES=2000, DEFAULT_MAX_BYTES=50*1024. Its tail includes
  // a partial last line when that line alone exceeds the byte cap.
  const maxLines = 2000;
  const maxBytes = 50 * 1024;
  let used = 0;
  let start = rows.length;
  while (start > 0 && rows.length - start < maxLines) {
    const bytes = Buffer.byteLength(rows[start - 1].text, "utf-8") + (start < rows.length ? 1 : 0);
    if (used + bytes > maxBytes) break;
    used += bytes;
    start--;
  }
  if (start === rows.length && rows.length) {
    const row = rows[start - 1];
    const buf = Buffer.from(row.text, "utf-8");
    let offset = buf.length - maxBytes;
    while (offset < buf.length && (buf[offset] & 0xc0) === 0x80) offset++;
    return { rows: [{ ...row, text: buf.subarray(offset).toString("utf-8") }], hidden: start - 1,
      partial: { line: rows.length, shownBytes: buf.length - offset, totalBytes: buf.length } };
  }
  return { rows: rows.slice(start), hidden: start };
}

/** Map the raw executor result(s) → ExecDetails for renderExecResult.
 *  `partialText` is set only while streaming: pi's partial updates carry the output in
 *  `content`, not `details`, so without it a running command renders as "exit 0 · 0 lines". */
function toExecDetails(action: string, args: any, details: any, partialText?: string): ExecDetails {
  const kind = action as ExecKind;
  if (partialText !== undefined) {
    const lines = partialText.split("\n").filter(Boolean);
    const cmd = action === "exec_file" ? String(args?.path ?? "file") : String(args?.code ?? "");
    return { kind, commands: [cmd], ok: true, exitCode: 0, outLines: lines.length, preview: lines.slice(-12), running: true };
  }
  if (action === "batch") {
    const arr: any[] = Array.isArray(details) ? details : [];
    // A-H1 (branch-review A-architecture.md): a batch entry whose `outcome` is a KNOWN
    // FAILURE (signal | spawn-error | aborted — I-1 gave signal/spawn-error `exitCode:
    // null`, never a fabricated number) must be counted as a failure here, exactly like a
    // real nonzero exitCode, never laundered into "unknown" just because it lacks a
    // numeric code. `isKnownFailureOutcome` is IMPORTED from `@spider/context` — this used
    // to be a local copy that silently omitted `"aborted"`, diverging from runExec's own
    // set (actions/exec.ts's `isExecError`); single-sourced so the two can never drift
    // again. Only an entry with NO recognized-failure outcome and a null exitCode (i.e.
    // `outcome === "unknown"`/`"timeout"`, or no `outcome` field at all — a conservative
    // default for any hypothetical shape that predates it) is genuinely unknown.
    const isNumericFail = (r: any) => typeof r?.exitCode === "number" && r.exitCode !== 0;
    const isKnownFailOutcome = (r: any) => isKnownFailureOutcome(r?.outcome);
    const isTimeoutFailure = (r: any) => foregroundTimedOut(r) && r?.outcome !== "unknown";
    const isUnknownEntry = (r: any) => r?.exitCode === null && !isKnownFailOutcome(r);
    // C-H2: a human-readable label for ONE entry's real failure — never a code that
    // entry did not itself produce. `aborted` always carries the real `137` sentinel
    // (executor.ts), so it is named explicitly rather than falling through to a bare
    // "exit 137" that reads like an ordinary numeric failure.
    const failLabel = (r: any): string => {
      const label = r?.outcome === "signal" ? `signal ${typeof r?.signal === "string" ? r.signal : "?"}`
        : r?.outcome === "spawn-error" ? "spawn error"
        : r?.outcome === "aborted" ? `aborted${typeof r?.exitCode === "number" ? ` · exit ${r.exitCode}` : ""}`
        : `exit ${r?.exitCode ?? "unknown"}`;
      return foregroundTimedOut(r) ? `timed out · ${label}` : label;
    };
    const anyNumericFail = arr.some(isNumericFail);
    const anyKnownFailOutcome = arr.some(isKnownFailOutcome);
    const anyFail = anyNumericFail || anyKnownFailOutcome || arr.some(isTimeoutFailure);
    const anyUnknown = arr.some(isUnknownEntry);
    const unknownCount = arr.filter(isUnknownEntry).length;
    // M-b: an EMPTY batch (no commands at all) is neutral/no-results, never the
    // self-contradictory "✗ exit 0" the old `ok=false, exitCode=0` combination
    // rendered. Routing it through `exitCode: null` reuses the same neutral
    // "unknown" rendering as any other indeterminate outcome.
    const empty = arr.length === 0;
    const ok = empty ? true : (!anyFail && !anyUnknown);
    const failEntries = arr.filter((r) => isNumericFail(r) || isKnownFailOutcome(r) || isTimeoutFailure(r));
    // C-H2: EVERY distinct failure kind present, in first-seen order, deduplicated —
    // never just the first. A numeric fail + a signal death used to collapse into one
    // fabricated "exit 1" that named neither honestly; a second/third distinct signal
    // used to vanish entirely once the first was found.
    const distinctFailures = Array.from(new Set(failEntries.map(failLabel)));
    // C-H2: NEVER fabricate a number the batch did not produce (the old
    // `anyNumericFail ? 1 : …` did exactly that, even for a single-command batch with
    // no aggregation to do at all — a lone entry exiting 127 rendered "exit 1").
    //  - Empty batch: nothing to report.
    //  - Exactly one command: no aggregation needed at all — forward its own real
    //    exitCode verbatim, whatever it genuinely is.
    //  - Multiple commands, nothing failing: 0 if every outcome is settled, else the
    //    existing neutral "unknown" (null).
    //  - Multiple commands WITH a failure: a single number is only honest when EVERY
    //    failing entry is a real numeric exit AND they all agree on the same value;
    //    otherwise there is no one "the batch's exit code" and this stays null —
    //    `failures` below carries the truth instead of a fabricated stand-in.
    const allNumericFailuresAgree = failEntries.length > 0 && !anyKnownFailOutcome && failEntries.every((r) => typeof r.exitCode === "number") && new Set(failEntries.map((r) => r.exitCode)).size === 1;
    const exitCode: number | null = empty
      ? null
      : arr.length === 1
        ? (arr[0]?.exitCode ?? null)
        : !anyFail
          ? (anyUnknown ? null : 0)
          : allNumericFailuresAgree
            ? failEntries[0].exitCode
            : null;
    const outLines = arr.reduce((n, r) => n + String(r?.stdout ?? "").split("\n").filter(Boolean).length, 0);
    const preview = arr.flatMap((r) => String(r?.stdout ?? "").split("\n").filter(Boolean)).slice(-8);
    const commands = (args?.commands ?? []).map((c: any) => String(c?.label ?? c?.code ?? c?.language ?? "cmd"));
    // The singular outcome/signal fields stay populated from the first failing entry —
    // still correct, informational data — but the renderer only NEEDS them (and only
    // trusts them alone) when there is exactly one distinct failure kind; `failures`
    // (every distinct kind) is what it falls back to the instant there is more than one.
    const firstFail = failEntries[0];
    return {
      kind, commands, ok, exitCode, outLines, preview,
      ...(distinctFailures.length === 1 && firstFail && foregroundTimedOut(firstFail) || arr.length === 1 && foregroundTimedOut(arr[0]) ? { timedOut: true } : {}),
      ...(arr.length > 1 && arr.some(r => isUnknownEntry(r) && foregroundTimedOut(r)) ? { timedOutUnknown: true } : {}),
      ...(firstFail?.outcome ? { outcome: firstFail.outcome as any } : {}),
      ...(typeof firstFail?.signal === "string" ? { signal: firstFail.signal } : {}),
      ...(distinctFailures.length > 0 ? { failures: distinctFailures } : {}),
      ...(unknownCount > 0 ? { unknownCount } : {}),
    };
  }
  const r = details ?? {};
  const outArr = String(r.stdout ?? "").split("\n").filter(Boolean);
  const cmd = action === "exec_file" ? String(args?.path ?? "file") : String(args?.code ?? "");

  // C-1/I-3: the structured discriminator (see executor.ts's ExecOutcome) is the
  // SINGLE thing this mapping branches on to decide "known vs unknown" — never
  // `exitCode === null` alone, which is null for several different situations
  // (signal death, spawn error, a deliberate timeout handoff, and a genuinely
  // indeterminate supervisor loss) that must never render identically. Falls
  // back to a conservative derivation for any hypothetical result predating
  // this field.
  const outcome: string =
    r.outcome ??
    (r.exitCode === null
      ? (r.retained === true ? "exited" : r.backgroundJob ? "timeout" : "unknown")
      : "exited");

  // R5/R3 (background-brief) + M-c: a DELIBERATELY detached timeout handoff
  // ("timeout") or a genuinely indeterminate outcome ("unknown", e.g. the
  // supervisor died before writing a receipt) both render neutrally — never a
  // fabricated ✓/exit 0 AND never a fabricated ✗ failure. The two are still
  // distinguished so the UI never claims a receipt "appears when it exits" for
  // a case where that might already be false. M-a: a `detached` handle is only
  // attached when there is an actual pid/job to disclose — never blank
  // placeholder path lines when no handle exists.
  if (r.exitCode === null && (outcome === "timeout" || outcome === "unknown")) {
    const job = r.backgroundJob;
    const hasHandle = !!job || typeof r.pid === "number";
    return {
      kind, commands: [cmd], ok: false, exitCode: null, outcome: outcome as any,
      outLines: outArr.length, preview: outArr.slice(-8), timedOut: foregroundTimedOut(r),
      ...(hasHandle ? {
        detached: {
          ...(typeof r.pid === "number" ? { pid: r.pid } : {}),
          jobId: String(job?.id ?? ""), jobDir: String(job?.dir ?? ""), receipt: String(job?.receipt ?? ""),
        },
      } : {}),
    };
  }
  // I-3: the command's outcome IS VERIFIABLY KNOWN (exited/signal/spawn-error/
  // aborted) but its directory was retained because its process group could
  // not be proven empty. Distinct from the branch above: `exitCode` may
  // legitimately still be `null` here (signal death, spawn error) — that must
  // never be coerced through `Number(null ?? 0)` into a fabricated `0`.
  if (r.retained === true) {
    const job = r.backgroundJob ?? {};
    const rawExit = r.exitCode;
    // m-3: an ABSENT exitCode field (distinct from an explicit `null`) is an
    // executor-unreachable shape today, but must still never be coerced into a
    // fabricated `0` — the same self-contradiction M-b already removed from
    // the empty-batch case. `null` here (not `0`) keeps this branch's own
    // "never fabricate 0" contract even for a shape no current caller emits.
    return {
      kind, commands: [cmd], ok: rawExit === 0 && !isExecError(r), exitCode: rawExit === undefined ? null : rawExit,
      outLines: outArr.length, preview: outArr.slice(-8), timedOut: foregroundTimedOut(r),
      outcome: outcome as any,
      ...(typeof r.signal === "string" ? { signal: r.signal } : {}),
      retained: {
        jobDir: String(job.dir ?? ""),
        reason: typeof r.retainedReason === "string" ? r.retainedReason : undefined,
        receipt: typeof job.receipt === "string" ? job.receipt : undefined,
      },
    };
  }
  // C-1: a KNOWN outcome that legitimately carries a `null` exitCode (a signal
  // death or spawn error whose process group WAS provably empty, so nothing
  // was retained and no handle survives) must still render as a visible, real
  // failure — never coerced to a fabricated `0`, and never the neutral
  // "unknown"/"timeout" wording used above (the outcome here IS known).
  if (r.exitCode === null) {
    return {
      kind, commands: [cmd], ok: false, exitCode: null, outcome: outcome as any,
      outLines: outArr.length, preview: outArr.slice(-8), timedOut: foregroundTimedOut(r),
      ...(typeof r.signal === "string" ? { signal: r.signal } : {}),
    };
  }
  // M1 (background-fix-review): `r.exitCode` is `number | null` repo-wide now —
  // the `null` case is fully handled above, so anything reaching here is either a
  // real number or a genuinely ABSENT field (a shape that never carries exitCode
  // at all), which defaults to 0.
  const rawExit = r.exitCode;
  const exitCode = Number(rawExit ?? 0);
  return { kind, commands: [cmd], ok: exitCode === 0 && !isExecError({ ...r, exitCode }), exitCode, outLines: outArr.length, preview: outArr.slice(-8), timedOut: foregroundTimedOut(r) };
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
function toMessageDetails(args: any, details: any, diagnostic = details?.error): MessageDetails {
  const kind = String(args?.kind ?? "");
  const verb: MessageDetails["verb"] = kind === "ask" ? "ask" : kind === "reply" ? "reply" : kind === "broadcast" ? "broadcast" : "send";
  const delivery = ["child-accepted", "broker-accepted", "queued", "unavailable", "delivered", "accepted but not confirmed", "no reply yet, delivery unknown", "refused"].includes(details?.delivery)
    ? details.delivery : typeof details?.error === "string" && !details?.queued ? "unavailable" : undefined;
  const targetName = details?.runName ?? details?.sessionName;
  let error = typeof diagnostic === "string" ? diagnostic : undefined;
  const runId = details?.runId;
  if (error && typeof runId === "string" && runId && typeof targetName === "string") {
    error = error.replaceAll(`Subagent ${runId}`, () => targetName)
      .replaceAll(`child ${runId}`, () => targetName)
      .replaceAll(runId, () => targetName)
      .replace(/^This run is owned by session [^;]+;/u, "This run is owned by another session;");
  }
  return {
    verb, to: args?.to ? String(args.to) : undefined, from: details?.from, targetName, kind: kind || undefined,
    body: nonblankLines(String(args?.message ?? "")).join("\n"), delivered: details?.delivered === true,
    delivery, transformed: details?.transformed === true, recipientAcknowledged: details?.recipientAcknowledged, error,
  };
}

/** Convert session metadata into labels; the stored IDs belong to the agent payload. */
function toTodoDetails(args: any, details: any): TodoChecklistDetails {
  const item = (x: any) => ({ id: Number(x?.seq ?? x?.id ?? 0), text: nonblankLines(String(x?.text ?? "")).join("\n"), done: x?.done === true });
  const label = (x: any) => x?.name || (x?.current ? "Current session" : "Unnamed session");
  const rows: any[] = Array.isArray(details) ? details : [];
  switch (args?.op) {
    case "add":
    case "toggle":
      return { kind: "item", item: item(details) };
    case "remove": {
      const current = details?.current ?? (args.session == null);
      return { kind: "removed", item: item(details), sessionName: current ? undefined : details?.name || "another session" };
    }
    case "clear":
      return { kind: "cleared", removed: details?.removed ?? 0, kept: details?.kept };
    case "view":
      return { kind: "list", groups: rows.map(group => ({ label: label(group), current: group.current, items: (group.todos ?? []).map(item) })) };
    case "sessions":
      return { kind: "sessions", sessions: rows.map(session => ({ label: label(session), done: session.done, total: session.total, current: session.current === true })) };
    default:
      return { kind: "list", groups: [{ items: rows.map(item) }] };
  }
}

function renderSpiderResultBody(
  result: any,
  options: any,
  theme: any,
  context: any,
): Component {
  const t = { ...mkTheme(theme, context?.iconStyle), modelName: context?.modelName };
  const expanded = options?.expanded === true;
  const action = String(context?.args?.action ?? "");
  const sub = String(context?.args?.sub ?? context?.args?.command ?? "");
  const details = result?.details;
  // Pi passes {content, details} here, with isError on context, not result.
  // Thrown errors have bare details. Rich results may also set context.isError
  // (exec exit != 0, doctor issues, etc.) and must retain their action cards.
  const bareDetails = details == null || (typeof details === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(details))
    && Reflect.ownKeys(details).length === 0);
  const rememberReceipt = action === "remember" || (action === "control" && context?.args?.command === "memory" && sub === "approve");
  const messageNote = action === "message" && details?.delivery !== "unavailable"
    && (details?.queued === true || ["child-accepted", "queued", "broker-accepted", "delivered", "accepted but not confirmed", "no reply yet, delivery unknown"].includes(details?.delivery));
  if ((context?.isError === true && bareDetails) || (details?.error != null && !messageNote) || (rememberReceipt && !details?.status)) {
    const content = Array.isArray(result?.content)
      ? result.content.filter((block: any) => block?.type === "text" && typeof block.text === "string")
        .map((block: any) => block.text).join("\n").trim()
      : "";
    const error = details?.error;
    const message = (error instanceof Error ? error.message : error != null ? String(error) : "").trim()
      || content || (typeof details?.message === "string" ? details.message : "")
      || "Call failed (no error message)";
    const th = adaptTheme(t);
    if (action === "message" && ["queued", "broker-accepted", "unavailable", "refused"].includes(details?.delivery)) {
      const d = toMessageDetails(context?.args, details, message);
      return { render: (width: number) => renderMessageResult(d, { theme: th, width, expanded }), invalidate() {} };
    }
    const displayMessage = action === "todo"
      ? message.replace(/\bsession "[0-9a-f]{8}(?:(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?"/giu, "the selected session")
      : message;
    return { render: (width: number) => renderErrorResult(displayMessage, { theme: th, width, expanded }), invalidate() {} };
  }

  switch (action) {
    case "run":
      return renderRun(t, details, expanded, context?.formatRunCost);
    case "exec":
    case "exec_file":
    case "batch": {
      // A partial update carries text in `content` and no `details`. Detect that and render
      // the running state; otherwise render the finished result.
      const isPartial = (options as { isPartial?: boolean } | undefined)?.isPartial === true;
      const partialText = isPartial
        ? (Array.isArray((result as any)?.content)
            ? (result as any).content.map((c: any) => String(c?.text ?? "")).join("")
            : "")
        : undefined;
      const restored = isPartial ? { details, valid: true } : restoreExecDetails(details, result?.content);
      if (!restored.valid) return textComponent(result, expanded);
      const d = toExecDetails(action, context?.args, restored.details, partialText);
      if (expanded && !isPartial) d.expandedOutput = expandedExecTail(action, restored.details);
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
      return { render: (w: number) => renderMessageResult(d, { theme: th, width: w, expanded }), invalidate() {} };
    }
    case "kill": {
      const th = adaptTheme(t);
      return { render: (w: number) => renderKillResult(details as KillDetails, { theme: th, width: w, expanded }), invalidate() {} };
    }
    case "remember": {
      const body = wrapBespoke(renderRememberResult(details as StageResult, expanded, adaptTheme(t)));
      return { render: (width: number) => fitResultLines([...body.render(width).filter(line => stripTerminalSequences(line).trim()), ...thinkingNoticeLines(t, details, width, expanded)], width, expanded, 3), invalidate: () => body.invalidate?.() };
    }
    case "recall": return wrapBespoke(renderRecallResult((details as MemoryRecord[]).map(record => ({ ...record, content: nonblankLines(record.content).join("\n") })), expanded));
    case "todo": {
      const d = toTodoDetails(context?.args, details);
      const th = adaptTheme(t);
      return { render: (w: number) => renderTodoChecklist(d, { theme: th, width: w, expanded }), invalidate() {} };
    }
    case "search": return renderSearch(t, details, expanded);
    case "skill": {
      const op = String(context?.args?.op ?? "list");
      if (op === "list") return plainBody(renderSkillList(Array.isArray(details) ? details : []), expanded);
      if (op === "distill") return plainBody(renderDistill(String(details?.prompt ?? "")), expanded);
      const text = renderSkillView((details?.row ?? details ?? undefined) as SkillRow | undefined);
      return plainBody(text.split("\n").filter(line => line.trim()).join("\n"), expanded);
    }
    case "notify": {
      if (details?.ok !== true) return textComponent(result, expanded);
      const publication = details.presentation === "panel-feed" ? " · panel feed" : "";
      return { render: w => fitResultLines([` ${t.fg("success", icon(t.iconStyle, "success"))} Notification stored${publication}`], w, expanded, 3), invalidate() {} };
    }
    case "import": return wrapBespoke(renderImportResult(details as any, expanded, t.iconStyle));
    case "control":
      if (sub === "pending") return wrapBespoke(renderPending(details as MemoryRecord[], expanded, adaptTheme(t)));
      if (sub === "doctor") return renderDoctor(t, details, expanded);
      if (sub === "stats") return renderControlStats(t, details, expanded);
      if (sub === "models") return renderControlModels(t, details, expanded);
      if (sub === "config") return renderControlConfig(t, details, expanded);
      if (sub === "insights") return renderControlInsights(t, details, expanded);
      if (sub === "migrate") {
        const th = adaptTheme(t);
        return { render: (w: number) => renderMigrateResult(details as MigrateDetails, { theme: th, width: w, expanded }), invalidate() {} };
      }
      if (sub === "bind" || sub === "unbind") {
        const th = adaptTheme(t);
        return { render: (w: number) => renderBindResult(details as BindDetails, { theme: th, width: w, expanded }), invalidate() {} };
      }
      if (context?.args?.command === "memory" && sub === "status") return renderControlMemory(t, details, expanded);
      if (context?.args?.command === "memory" && sub === "forget") {
        const archived = details?.ok === true && details?.removed?.status === "archived";
        const status = archived ? `archived memory${details.scope ? ` · ${details.scope}` : ""}` : "memory was not archived";
        const glyph = statusIcon(adaptTheme(t), archived ? "ok" : "fail");
        return { render: w => fitResultLines([` ${glyph} ${status}`], w, expanded, 3), invalidate() {} };
      }
      if (context?.args?.command === "memory" && sub === "approve") return wrapBespoke(renderRememberResult(details as StageResult, expanded, adaptTheme(t)));
      if (context?.args?.command === "memory" && sub === "reject") return {
        render: w => fitResultLines([` ${t.fg("success", icon(t.iconStyle, "success"))} Rejected pending memory`], w, expanded, 3), invalidate() {},
      };
      if (sub === "upstream-watch") return renderUpstreamWatch(t, details, expanded);
      if (context?.args?.command === "skill" && sub === "curate") return plainBody(renderCurateResult(details), expanded);
      return textComponent(result, expanded);
    default:
      return textComponent(result, expanded);
  }
}

function isExecAction(action: string): action is ExecKind {
  return action === "exec" || action === "exec_file" || action === "batch";
}

function execCallCommands(action: ExecKind, args: any): string[] {
  if (action === "exec_file") return [String(args?.path ?? "file")];
  if (action === "batch") return Array.isArray(args?.commands)
    ? args.commands.map((command: any) => String(command?.label ?? command?.code ?? command?.language ?? "cmd")) : [];
  return [String(args?.code ?? "")];
}

/** The tool and command messages share the same render-time width boundary. */
export function renderSpiderResult(result: any, options: any, theme: any, context: any): Component {
  const runs: RunLike[] = context?.args?.action === "run"
    ? Array.isArray(result?.details?.runs) ? result.details.runs : result?.details?.run ? [result.details.run] : []
    : [];
  const liveCosts = runs.flatMap(r => ["done", "failed", "cancelled"].includes(r.status ?? "running")
    && ((r.token_count ?? 0) > 0 || (r.compactionCount ?? 0) > 0) && r.costText == null && r.usageCosts ? [r.usageCosts] : []);
  // Completed run costs use the footer's live calibration, not just stored result details.
  const contentKey = (liveCosts.length && typeof context?.formatRunCost === "function") || (runs.length && typeof context?.modelName === "function")
    ? () => JSON.stringify([liveCosts.map(costs => context.formatRunCost?.(costs)), runs.map(run => run.model ? context.modelName?.(run.model) : undefined)]) : undefined;
  let body: Component | undefined;
  return cachedLines(width => {
    body ??= renderSpiderResultBody(result, options, theme, context);
    const action = String(context?.args?.action ?? "");
    const rows = body.render(width);
    const lines = isExecAction(action)
      ? [...(execCallCommands(action, context.args).some(command => command.trim()) ? [""] : []), ...rows]
      : fitResultLines(rows, width, options?.expanded === true, 3);
    return restoreCardBackground(lines, theme, cardBackground(context));
  }, () => {
    body?.invalidate?.();
    // Some bodies prepare styled strings when created. Rebuild them for the active theme.
    body = undefined;
  }, contentKey);
}

/** CALL title. renderCall replaces the tool label, so it renders the full header.
 *  The action is bold; an agent role is italic. Names, separators, and subcommands are plain. */
export function renderSpiderCall(args: any, theme: any, context: any): Component {
  return cachedLines((w: number) => {
    const t = mkTheme(theme, context?.iconStyle);
    const action = String(args?.action ?? "");
    const verb = (v: string) => t.fg("toolTitle", t.bold(v));
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
        : `${verb("run")} ${t.fg("toolTitle", `· ${mode} · ${n} started`)}`;
    } else if (isExecAction(action) && typeof args?.on === "string") {
      // The command goes below the title; remote calls also name their destination.
      suffix = `${verb(action)} ${t.fg("toolTitle", `· on ${args.on}`)}`;
    } else if (args?.sub || args?.command) {
      const subject = action === "control" && args.command === "memory" && args.sub ? `memory · ${args.sub}` : args.sub ?? args.command;
      suffix = `${verb(action)} ${t.fg("toolTitle", `· ${subject}`)}`;
    }
    if (context?.titleDetails?.length) {
      for (const detail of context.titleDetails as { text: string; agent: boolean }[]) {
        suffix += t.fg("toolTitle", " · ") + (detail.agent ? t.italic(renderRoleAccent(adaptTheme(t), detail.text, detail.text)) : t.fg("toolTitle", detail.text));
      }
    }
    const line = ` ${t.fg("toolTitle", icon(t.iconStyle, "spider"))} ${suffix}`;

    // The call is visible before a result exists. Keep the commands here in both modes.
    const lines = isExecAction(action)
      ? renderExecCall({ kind: action, commands: execCallCommands(action, args) }, { theme: adaptTheme(t), width: w, expanded: context?.expanded === true }, line)
      : [clip(line, w)];
    return restoreCardBackground(lines, theme, cardBackground(context));
  });
}

interface NotificationOptions { expanded?: boolean; outputPad?: number }

function runTitleDetails(name: unknown, agent: unknown): { text: string; agent: boolean }[] {
  const role = typeof agent === "string" && agent ? agent : undefined;
  const label = typeof name === "string" && name ? name : undefined;
  const details = [
    ...(label && label !== role ? [{ text: label, agent: false }] : []),
    ...(role ? [{ text: role, agent: true }] : []),
  ];
  return details.length ? details : [{ text: "subagent", agent: false }];
}

export function renderSubagentDone(message: any, options: NotificationOptions, theme: any, iconStyle?: IconStyle, modelName?: T["modelName"]): PiComponent {
  const d = message?.details ?? {};
  // C-LOW: a malformed completion event without status is not proof of `done`.
  const status = String(d.status ?? "unknown");
  const background = status === "failed" ? "toolErrorBg" : status === "done" ? "toolSuccessBg" : "toolPendingBg";
  const expanded = options?.expanded === true;
  const t = { ...mkTheme(theme, iconStyle), modelName };
  const run: RunLike = { name: d.name, agent: d.agent, model: d.model, thinking: d.thinking, status, result: d.output, token_count: d.tokenCount, cost: d.cost, costText: d.costText, compactionCount: d.compactionCount };
  const detail = renderRun(t, { run }, expanded, undefined, false);
  const box = createHalfBox(options.outputPad ?? 1, text => t.bg(background, text));
  box.addChild(flushLeft(renderSpiderCall({ action: "run" }, theme, {
    cardBackground: background, iconStyle, titleDetails: runTitleDetails(d.name, d.agent),
  })));
  box.addChild(flushLeft({
    render: (width: number) => {
      const lines = detail.render(width);
      if (d.chain?.outcome === "complete" || d.chain?.outcome === "stopped") {
        const headline = d.chain.outcome === "complete" ? "chain complete"
          : `chain stopped at step ${d.chain.step} of ${d.chain.total}: ${d.chain.cause}`;
        lines.push(...cardRow(cardDetailIndent(iconStyle), t.fg("toolTitle", headline), width, expanded));
      }
      return restoreCardBackground(lines, theme, background);
    },
    invalidate: () => detail.invalidate?.(),
  }));
  return cachedLines(width => box.render(width), () => box.invalidate(),
    modelName && run.model ? () => modelName(run.model!) : undefined);
}

/** Transcript renderer for the `spider.command` message a slash command emits. Renders the
 *  SAME title + body a real spider tool call produces — renderSpiderCall + renderSpiderResult over
 *  the dispatch result normalized via toToolResult (so control's {ok,lines}/{details} shapes both
 *  populate result.details) — wrapped in the tool box, so /spider, /stats, /doctor look
 *  identical to the tool result. ctrl+o (options.expanded) expands. */
export function renderCommandOutput(message: any, options: NotificationOptions, theme: any, iconStyle?: IconStyle, modelName?: T["modelName"]): PiComponent {
  const d = message?.details;
  const args = d?.args ?? { action: "command" };
  const result = d?.result ?? {};
  const expanded = options?.expanded === true;
  const normalized = toToolResult(result);
  const details = normalized.details as { warning?: string; delivery?: string; recipientAcknowledged?: boolean } | undefined;
  const pendingMessage = args.action === "message" && (
    ["queued", "child-accepted", "accepted but not confirmed", "no reply yet, delivery unknown"].includes(details?.delivery ?? "")
    || details?.delivery === "broker-accepted" && details.recipientAcknowledged !== true
  );
  const context = { args, expanded, isError: normalized.isError, isPartial: !normalized.isError && (Boolean(details?.warning) || pendingMessage), iconStyle, modelName };
  const background = cardBackground(context);
  const box = createHalfBox(options.outputPad ?? 1, text => mkTheme(theme).bg(background, text));
  const titleArgs = args.action ? args : { action: args.command ?? "command" };
  box.addChild(flushLeft(renderSpiderCall(titleArgs, theme, context)));
  if (d == null || (!args.action && typeof result.text === "string")) {
    const content = d == null ? message?.content : result.text;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
    const lines = nonblankLines(text).map(line => ` ${line.trim()}`);
    box.addChild(flushLeft({
      render: (width: number) => {
        const shown = expanded ? lines : lines.slice(0, 5);
        const remaining = lines.length - shown.length;
        return restoreCardBackground(fitResultLines([...shown, ...(remaining ? [` … ${remaining} more line${remaining === 1 ? "" : "s"}`] : [])], width, expanded, 3), theme, background);
      },
      invalidate() {},
    }));
  } else {
    box.addChild(flushLeft(renderSpiderResult(normalized, { expanded }, theme, context)));
  }
  const runDetails = normalized.details as { runs?: RunLike[]; run?: RunLike } | undefined;
  const runs: RunLike[] = args.action === "run" ? Array.isArray(runDetails?.runs) ? runDetails.runs
    : runDetails?.run ? [runDetails.run] : [] : [];
  return cachedLines(width => box.render(width), () => box.invalidate(),
    modelName && runs.length ? () => JSON.stringify(runs.map(run => run.model ? modelName(run.model) : undefined)) : undefined);
}

/** TUI-only receipt: proposed knowledge stays pending and never masquerades as completed user work. */
export function renderOrganismEntry(entry: unknown, options: NotificationOptions, theme: unknown, iconStyle?: IconStyle): Component {
  const report = (entry as { data?: DrainReport } | undefined)?.data;
  const state = report?.status ?? "unknown";
  const failed = state === "failed";
  const completed = state === "completed";
  const background = failed ? "toolErrorBg" : completed ? "toolSuccessBg" : "toolPendingBg";
  const box = createHalfBox(options.outputPad ?? 1, text => mkTheme(theme).bg(background, text));
  box.addChild(flushLeft(renderSpiderCall({ action: "organism" }, theme, { cardBackground: background, iconStyle })));
  box.addChild(flushLeft({
    render: (width: number) => {
      const t = mkTheme(theme);
      const marker = icon(iconStyle, failed ? "failure" : state === "partial" ? "warning" : completed ? "success" : "open");
      const color = failed ? "error" : state === "partial" ? "warning" : completed ? "success" : "muted";
      const lines = [` ${t.fg(color, marker)} ${state}`];
      const detail = (text: string) => `${cardDetailIndent(iconStyle)}${t.fg("toolOutput", text)}`;
      if (report) {
        lines.push(detail(`${report.memoryStaged} memories · ${report.skillsQueued === undefined && report.skillsStaged > 0 ? `${report.skillsStaged} skills staged` : `${report.skillsQueued ?? 0} skills queued`} · ${report.todosAdded} todos`));
        if (report.skipReason) lines.push(detail(report.skipReason));
        const errors = options?.expanded ? report.errors : report.errors.slice(0, 1);
        for (const error of errors) lines.push(detail(`${error.phase}: ${error.message}`));
        if (options?.expanded) lines.push(detail(`${report.modelCalls} model calls · ${report.reason} · ${report.finishedAt - report.startedAt} ms`));
        if (report.memoryStaged + report.skillsStaged > 0) {
          lines.push(detail("Review: spider control memory sub=pending · spider skill op=list"));
        }
      }
      return restoreCardBackground(fitResultLines(lines, width, options?.expanded === true, 3), theme, background);
    },
    invalidate() {},
  }));
  return cachedLines(width => box.render(width), () => box.invalidate());
}

/** Transcript renderer for `spider.escalation`. The full summary is always visible. */
export function renderEscalationMessage(message: any, options: NotificationOptions, theme: any, iconStyle?: IconStyle): PiComponent {
  const d = message?.details ?? {};
  const severity = d.severity === "blocked" || d.severity === "question" ? d.severity : "warning";
  const escalationDetails: EscalationDetails = { severity, summary: typeof d.summary === "string" ? d.summary : "Escalation" };
  const background = severity === "blocked" ? "toolErrorBg" : "toolPendingBg";
  const th = adaptTheme(mkTheme(theme, iconStyle));
  const box = createHalfBox(options.outputPad ?? 1, text => th.bg(background, text));
  box.addChild(flushLeft(renderSpiderCall({ action: "escalation" }, theme, {
    iconStyle, cardBackground: background, titleDetails: runTitleDetails(d.name, d.agent),
  })));
  box.addChild(flushLeft({
    render: (w: number) => restoreCardBackground(renderEscalation(escalationDetails, { theme: th, width: w }), theme, background),
    invalidate() {},
  }));
  return cachedLines(width => box.render(width), () => box.invalidate());
}
