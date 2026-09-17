// packages/host/src/render-result.ts
// pi `ToolDefinition.renderResult` for the spider tool. With renderShell:"default"
// pi paints the standard green/red tool shell and uses the tool `label` ("🕸 spider")
// as the title, so renderResult renders only the BODY (no header of its own — that
// would double the "spider"). `options.expanded` reflects the in-chat Ctrl+O toggle;
// `context.args` are the call params; `result.details` is the structured payload.
import { truncateToWidth, visibleWidth, Box, Spacer, Container } from "@earendil-works/pi-tui";
import type { Component } from "@spider/ui";
import { renderExecResult, renderIndexResult, renderMessageResult, renderKillResult, renderTodoChecklist, renderStats, renderInsights, renderModels, renderConfig, renderBindResult, renderMigrateResult, renderEscalation, sectionRule, type ExecDetails, type ExecKind, type IndexDetails, type MessageDetails, type KillDetails, type TodoChecklistDetails, type BindDetails, type MigrateDetails, type StatsSummary, type InsightGraphView, type EscalationDetails, type ThemeAdapter } from "@spider/ui";
import {
  renderRememberResult,
  renderRecallResult,
  renderPending,
  type StageResult,
  type MemoryRecord,
} from "@spider/memory";
import { renderImportResult, isKnownFailureOutcome } from "@spider/context";
import type { ModelEntry } from "@spider/models";
import { renderSkillList, renderSkillView, renderDistill, renderCurateResult, type DrainReport, type SkillRow } from "@spider/organism";
import { toToolResult } from "./result";
const ANSI = /\x1b\[[0-9;]*m/g;
const SG: Record<string, string> = { queued: "○", running: "◆", paused: "■", done: "✓", failed: "✗", cancelled: "⚠" };

interface T { fg(tok: string, s: string): string; bold(s: string): string; italic(s: string): string; bg(tok: string, s: string): string; }
function mkTheme(theme: any): T {
  // Theme.fg/bg THROW on a token the active theme lacks; swallow it so one unknown token never
  // aborts a whole render (pi's CustomMessageComponent would silently fall back to raw content).
  const guard = (fn: any, tok: string, s: string): string => {
    if (typeof fn !== "function") return s;
    try { return fn(tok, s); } catch { return s; }
  };
  return {
    fg: (tok, s) => guard(theme?.fg?.bind(theme), tok, s),
    bold: (s) => { try { return typeof theme?.bold === "function" ? theme.bold(s) : s; } catch { return s; } },
    italic: (s) => { try { return typeof theme?.italic === "function" ? theme.italic(s) : s; } catch { return s; } },
    bg: (tok, s) => guard(theme?.bg?.bind(theme), tok, s),
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

function plainBody(text: string): Component {
  // The tool title already identifies the surface; drop only its duplicate heading.
  return textComponent({ content: [{ type: "text", text: text.replace(/^## [^\n]*\n?/, "") }] });
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
      const glyph = t.fg(ok === undefined ? "dim" : "toolTitle", ok === true ? "✓" : ok === false ? "✗" : "○");
      const summary = ok === true ? "all checks passed" : ok === false ? "issues found" : "check status unknown";
      const out = ["", clip(` ${glyph} ${t.fg("muted", summary)}`, width)];
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
function renderControlMemory(t: T, details: any, expanded = false): Component {
  const th = adaptTheme(t);
  const entries: any[] = Array.isArray(details?.entries) ? details.entries : [];
  const usage = Number(details?.usage ?? 0);
  return {
    render(w: number): string[] {
      const out = ["", sectionRule(th, `memory · ${entries.length} active · ${usage} chars`, w)];
      if (!entries.length) out.push(truncateToWidth(th.fg("dim", " (no active memories)"), w, ""));
      for (const e of entries) {
        const cat = th.fg("accent", `[${String(e?.category ?? "?")}]`);
        out.push(truncateToWidth(` ${th.fg("dim", "◆")} ${cat} ${th.fg("text", String(e?.uuid ?? ""))}`, w, ""));
        for (const line of wrap(String(e?.content ?? ""), Math.max(1, w - 3), expanded ? 8 : 1)) {
          out.push(truncateToWidth(` ${th.fg("dim", "│ ")}${th.fg("text", line)}`, w, ""));
        }
      }
      return out;
    },
    invalidate() {},
  };
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
    const isUnknownEntry = (r: any) => r?.exitCode === null && !isKnownFailOutcome(r);
    // C-H2: a human-readable label for ONE entry's real failure — never a code that
    // entry did not itself produce. `aborted` always carries the real `137` sentinel
    // (executor.ts), so it is named explicitly rather than falling through to a bare
    // "exit 137" that reads like an ordinary numeric failure.
    const failLabel = (r: any): string =>
      r?.outcome === "signal" ? `signal ${typeof r?.signal === "string" ? r.signal : "?"}`
      : r?.outcome === "spawn-error" ? "spawn error"
      : r?.outcome === "aborted" ? `aborted · exit ${r?.exitCode}`
      : `exit ${r?.exitCode}`;
    const anyNumericFail = arr.some(isNumericFail);
    const anyKnownFailOutcome = arr.some(isKnownFailOutcome);
    const anyFail = anyNumericFail || anyKnownFailOutcome;
    const anyUnknown = arr.some(isUnknownEntry);
    const unknownCount = arr.filter(isUnknownEntry).length;
    // M-b: an EMPTY batch (no commands at all) is neutral/no-results, never the
    // self-contradictory "✗ exit 0" the old `ok=false, exitCode=0` combination
    // rendered. Routing it through `exitCode: null` reuses the same neutral
    // "unknown" rendering as any other indeterminate outcome.
    const empty = arr.length === 0;
    const ok = empty ? true : (!anyFail && !anyUnknown);
    const failEntries = arr.filter((r) => isNumericFail(r) || isKnownFailOutcome(r));
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
    const allNumericFailuresAgree = anyNumericFail && !anyKnownFailOutcome && new Set(failEntries.map((r) => r.exitCode)).size === 1;
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
      outLines: outArr.length, preview: outArr.slice(-8),
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
      kind, commands: [cmd], ok: rawExit === 0, exitCode: rawExit === undefined ? null : rawExit,
      outLines: outArr.length, preview: outArr.slice(-8),
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
      outLines: outArr.length, preview: outArr.slice(-8),
      ...(typeof r.signal === "string" ? { signal: r.signal } : {}),
    };
  }
  // M1 (background-fix-review): `r.exitCode` is `number | null` repo-wide now —
  // the `null` case is fully handled above, so anything reaching here is either a
  // real number or a genuinely ABSENT field (a shape that never carries exitCode
  // at all), which defaults to 0.
  const rawExit = r.exitCode;
  const exitCode = Number(rawExit ?? 0);
  return { kind, commands: [cmd], ok: exitCode === 0, exitCode, outLines: outArr.length, preview: outArr.slice(-8) };
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
  const delivery = ["broker-accepted", "queued", "unavailable"].includes(details?.delivery)
    ? details.delivery : typeof details?.error === "string" && !details?.queued ? "unavailable" : undefined;
  return {
    verb, to: args?.to ? String(args.to) : undefined, kind: kind || undefined,
    body: String(args?.message ?? ""), delivered: details?.delivered === true,
    delivery, recipientAcknowledged: details?.recipientAcknowledged,
    error: typeof details?.error === "string" ? details.error : undefined,
  };
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
  // Error payloads must not fall through into success-shaped zero-count cards.
  if (typeof details?.error === "string" && action !== "message") {
    return {
      render: (w: number) => ["", ...wrap(details.error, Math.max(1, w - 3), expanded ? 24 : 4)
        .map((line, i) => clip(` ${t.fg("error", i === 0 ? "✗ " : "  ")}${t.fg("toolOutput", line)}`, w))],
      invalidate() {},
    };
  }

  switch (action) {
    case "run":
      return renderRun(t, details, expanded);
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
      const d = toExecDetails(action, context?.args, details, partialText);
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
      return { render: (w: number) => renderKillResult(details as KillDetails, { theme: th, width: w }), invalidate() {} };
    }
    case "remember": return wrapBespoke(renderRememberResult(details as StageResult));
    case "recall": return wrapBespoke(renderRecallResult(details as MemoryRecord[]));
    case "todo": {
      const d = toTodoDetails(context?.args, details);
      const th = adaptTheme(t);
      return { render: (w: number) => renderTodoChecklist(d, { theme: th, width: w }), invalidate() {} };
    }
    case "search": return renderSearch(t, details, expanded);
    case "skill": {
      const op = String(context?.args?.op ?? "list");
      if (op === "list") return plainBody(renderSkillList(Array.isArray(details) ? details : []));
      if (op === "distill") return plainBody(renderDistill(String(details?.prompt ?? "")));
      return plainBody(renderSkillView((details?.row ?? details ?? undefined) as SkillRow | undefined));
    }
    case "import": return wrapBespoke(renderImportResult(details as any));
    case "control":
      if (sub === "pending") return wrapBespoke(renderPending(details as MemoryRecord[]));
      if (sub === "doctor") return renderDoctor(t, details);
      if (sub === "stats") return renderControlStats(t, details);
      if (sub === "models") return renderControlModels(t, details, expanded);
      if (sub === "config") return renderControlConfig(t, details, expanded);
      if (sub === "insights") return renderControlInsights(t, details, expanded);
      if (sub === "migrate") {
        const th = adaptTheme(t);
        return { render: (w: number) => renderMigrateResult(details as MigrateDetails, { theme: th, width: w }), invalidate() {} };
      }
      if (sub === "bind" || sub === "unbind") {
        const th = adaptTheme(t);
        return { render: (w: number) => renderBindResult(details as BindDetails, { theme: th, width: w }), invalidate() {} };
      }
      if (context?.args?.command === "memory" && sub === "status") return renderControlMemory(t, details, expanded);
      if (context?.args?.command === "memory" && sub === "forget") {
        const archived = details?.ok === true && details?.removed?.status === "archived";
        return {
          render: (w: number) => [
            "",
            clip(` ${t.fg(archived ? "success" : "error", archived ? "✓ archived memory" : "✗ memory was not archived")}`, w),
            clip(` ${t.fg("toolOutput", String(details?.uuid ?? ""))} ${t.fg("muted", String(details?.scope ?? ""))}`, w),
          ],
          invalidate() {},
        };
      }
      if (context?.args?.command === "memory" && sub === "approve") return wrapBespoke(renderRememberResult(details as StageResult));
      if (context?.args?.command === "memory" && sub === "reject") return {
        render: (w: number) => ["", clip(` ${t.fg("toolOutput", `Rejected pending memory ${details?.uuid ?? ""}`)}`, w)], invalidate() {},
      };
      if (context?.args?.command === "skill" && sub === "curate") return plainBody(renderCurateResult(details));
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
    // Keep the header line to the bare verb; the command goes BELOW it (see cmdLines).
    suffix = verb(action);
  }
  const line = `${t.fg("toolTitle", "🕸")}  ${t.fg("toolTitle", t.bold("spider"))} ${t.fg("toolTitle", "·")} ${suffix}`;

  // The call is rendered as soon as the tool is invoked; the result only lands when the
  // command EXITS. So anything not on the call is invisible for the whole run — which is
  // why a slow `npm run build` used to show as a bare "spider · exec" with no clue what
  // was executing. Put the command here, and let the result carry only the output.
  const cmdLines: string[] = [];
  if (action === "exec" || action === "exec_file" || action === "batch") {
    const raw =
      action === "exec_file"
        ? [String(args?.path ?? "file")]
        : action === "batch"
          ? (Array.isArray(args?.commands) ? args.commands : []).map((c: any) =>
              String(c?.label ?? c?.code ?? c?.language ?? "cmd"),
            )
          : String(args?.code ?? "").split("\n");
    const all = raw.flatMap((s: unknown) => String(s).split("\n")).filter((s: string) => s.trim() !== "");
    // Cap hard: the header must stay a header. The full script is available on the
    // result (ctrl+o), so nothing is lost by clipping here.
    const HEAD = 2;
    for (const c of all.slice(0, HEAD)) cmdLines.push(`${t.fg("dim", "│ ")}${t.fg("toolOutput", c)}`);
    const rest = all.length - Math.min(all.length, HEAD);
    if (rest > 0) cmdLines.push(`${t.fg("dim", `│ … +${rest} more line${rest === 1 ? "" : "s"}`)}`);
  }

  return {
    render: (w: number) => [clip(line, w), ...cmdLines.map((c) => clip(c, w))],
    invalidate() {},
  };
}

export function renderSubagentDone(message: any, options: { expanded?: boolean }, theme: any): Component {
  const d = message?.details ?? {};
  // C-LOW: a malformed completion event without status is not proof of `done`.
  const status = String(d.status ?? "unknown");
  const background = status === "failed" || status === "cancelled"
    ? "toolErrorBg"
    : status === "done"
      ? "toolSuccessBg"
      : "toolPendingBg";
  const bgFn = (text: string) => (typeof theme?.bg === "function" ? theme.bg(background, text) : text);
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

/** Transcript renderer for the `spider.command` message a slash command emits. Renders the
 *  SAME title + body a real spider tool call produces — renderSpiderCall + renderSpiderResult over
 *  the dispatch result normalized via toToolResult (so control's {ok,lines}/{details} shapes both
 *  populate result.details) — wrapped in the tool-success box, so /spider, /stats, /doctor look
 *  identical to the tool result. ctrl+o (options.expanded) expands. */
export function renderCommandOutput(message: any, options: { expanded?: boolean }, theme: any): Component {
  const d = message?.details ?? {};
  const args = d.args ?? { action: "control" };
  const result = d.result ?? {};
  const expanded = options?.expanded === true;
  const bgFn = (text: string) => { try { return typeof theme?.bg === "function" ? theme.bg("toolSuccessBg", text) : text; } catch { return text; } };
  const box = new Box(1, 1, bgFn);
  box.addChild(renderSpiderCall(args, theme, {}) as any);
  box.addChild(renderSpiderResult(toToolResult(result), { expanded }, theme, { args }) as any);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(box as any);
  return container as unknown as Component;
}

/** TUI-only receipt: proposed knowledge stays pending and never masquerades as completed user work. */
export function renderOrganismEntry(entry: unknown, options: { expanded?: boolean }, theme: unknown): Component {
  const report = (entry as { data?: DrainReport } | undefined)?.data;
  const state = report?.status ?? "unknown";
  const bad = state === "failed" || state === "partial";
  const background = bad ? "toolErrorBg" : state === "completed" ? "toolSuccessBg" : "toolPendingBg";
  const box = new Box(1, 1, text => mkTheme(theme).bg(background, text));
  box.addChild({
    render: (width: number) => {
      const t = mkTheme(theme);
      const icon = bad ? "⚠" : state === "completed" ? "✓" : "○";
      const lines = [t.fg(bad ? "error" : "toolTitle", `${icon} organism · ${state}`)];
      if (report) {
        lines.push(t.fg("toolOutput", `${report.memoryStaged} memories · ${report.skillsStaged} skills staged · ${report.todosAdded} todos`));
        if (report.skipReason) lines.push(t.fg("toolOutput", report.skipReason));
        const errors = options?.expanded ? report.errors : report.errors.slice(0, 1);
        for (const error of errors) lines.push(t.fg("toolOutput", `${error.phase}: ${error.message}`));
        if (options?.expanded) lines.push(t.fg("toolOutput", `${report.modelCalls} model calls · ${report.reason} · ${report.finishedAt - report.startedAt} ms`));
        if (report.memoryStaged + report.skillsStaged > 0) {
          lines.push(t.fg("toolOutput", "Review: spider control memory sub=pending · spider skill op=list"));
        }
      }
      return lines.map(line => clip(line, Math.max(0, width)));
    },
    invalidate() {},
  });
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(box);
  return container as unknown as Component;
}

/** Transcript renderer for `spider.escalation` custom messages. Escalations always use
 *  the error background (warnings/blocks are both urgent enough to warrant the red card). */
export function renderEscalationMessage(message: any, options: { expanded?: boolean }, theme: any): Component {
  const d = message?.details ?? {};
  const escalationDetails: EscalationDetails = {
    runId: d.runId,
    severity: d.severity ?? "warning",
    summary: d.summary ?? "Escalation",
    agent: d.agent ?? "worker",
    name: d.name ?? d.agent ?? "subagent",
    payload: d.payload,
  };
  const th = adaptTheme(mkTheme(theme));
  const bgFn = (text: string) => {
    try { return typeof theme?.bg === "function" ? theme.bg("toolErrorBg", text) : text; } catch { return text; }
  };
  const box = new Box(1, 1, bgFn);
  box.addChild({
    render: (w: number) => renderEscalation(escalationDetails, { theme: th, width: w, expanded: options?.expanded === true }),
    invalidate() {},
  } as any);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(box as any);
  return container as unknown as Component;
}
