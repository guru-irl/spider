import { truncateToWidth } from "@earendil-works/pi-tui";
import { icon as uiIcon } from "../icons.js";
import { fitResultLines, resultTrimmer, statusIcon } from "./types.js";
import type { ExecDetails, RenderCtx } from "./types.js";

const CALL_CAP = 2;

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function outputRows(details: ExecDetails, ctx: RenderCtx, collapsed: string[]): string[] {
  const { theme, width } = ctx;
  const full = ctx.expanded ? details.expandedOutput : undefined;
  if (!full) return collapsed.map((p) => truncateToWidth(` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("toolOutput", p)}`, width, ""));
  const rows: string[] = [];
  if (full.hidden) rows.push(` ${theme.fg("muted", `${uiIcon(theme.iconStyle, "gutter")} … ${full.hidden} earlier output line${full.hidden === 1 ? "" : "s"} hidden`)}`);
  const gutter = ` ${theme.fg("dim", uiIcon(theme.iconStyle, "gutter"))} `;
  let stream: "stdout" | "stderr" | undefined;
  for (const entry of full.rows) {
    if (entry.stream === "stderr" && stream !== "stderr") rows.push(gutter + theme.fg("muted", "stderr:"));
    rows.push(gutter + theme.fg("toolOutput", entry.text));
    stream = entry.stream;
  }
  if (full.partial) {
    const { line, shownBytes, totalBytes } = full.partial;
    rows.push(` ${theme.fg("muted", `[Showing last ${formatSize(shownBytes)} of line ${line} (line is ${formatSize(totalBytes)})]`)}`);
  }
  return rows;
}

/** Render the command preview below the call title. The host can supply a styled title with a destination. */
export function renderExecCall(
  details: Pick<ExecDetails, "kind" | "commands">,
  { theme, width, expanded = false }: RenderCtx,
  title?: string,
): string[] {
  const verb = theme.fg("toolTitle", details.kind);
  const head = title ?? `${theme.fg("toolTitle", uiIcon(theme.iconStyle, "spider"))} ${theme.fg("toolTitle", theme.bold("spider"))} ${theme.fg("toolTitle", "·")} ${theme.italic?.(verb) ?? verb}`;
  const all = (details.commands ?? []).flatMap(command => command.split(/\r?\n/u));
  const preview = all.filter(command => command.trim());
  const shown = expanded && preview.length ? all : preview.slice(0, CALL_CAP);
  const gutter = ` ${theme.fg("dim", uiIcon(theme.iconStyle, "gutter"))} `;
  const body = shown.map(command => gutter + theme.fg("toolOutput", command));
  const extra = preview.length - shown.length;
  if (extra > 0) body.push(gutter + theme.fg("dim", `… +${extra} more line${extra === 1 ? "" : "s"}`));
  return [truncateToWidth(head, width, "…"), ...fitResultLines(body, width, expanded, 3)];
}

/** Render the exit status and output. The call owns the command in both modes. */
export function renderExecResult(details: ExecDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const expanded = ctx.expanded === true;
  const trim = resultTrimmer(expanded);
  const out: string[] = [];
  const timeoutLabel = (label: string) => details.timedOut ? `timed out · ${label}` : label;

  // While running we do not know the exit code, so claiming "✓ exit 0" would be a lie that
  // looks like success. Show a running marker and every line streamed so far — the whole
  // point of streaming is watching it arrive, so the collapsed 1-line preview is wrong here.
  if (details.running) {
    out.push(trim(` ${theme.fg("muted", "● running…")}`, width, ""));
    for (const p of details.preview ?? []) {
      out.push(trim(` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("toolOutput", p)}`, width, ""));
    }
    return fitResultLines(out, width, expanded, 3);
  }

  // C-H2: a batch with MORE THAN ONE distinct failure kind has no single exitCode/
  // outcome/signal that can honestly represent it (unlike exec/exec_file, which only ever
  // have one result to report on). `failures` is only set by the host when the batch has
  // at least one failing entry; this branch only takes over rendering when there is more
  // than one DISTINCT kind — a single-kind batch keeps using the existing outcome/exitCode
  // paths below unchanged, so this never fabricates a code none of them produced and never
  // collapses multiple distinct failures down to just the first.
  if (details.failures && details.failures.length > 1) {
    const icon = statusIcon(theme, "fail");
    const metaParts = [details.failures.join(", "), `${details.outLines} lines`];
    if (details.unknownCount) metaParts.push(`${details.unknownCount} unknown`);
    if (details.timedOutUnknown) metaParts.push("timed out · outcome unknown");
    out.push(trim(` ${icon} ${theme.fg("muted", metaParts.join(" · "))}`, width, ""));
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(0, 1);
    out.push(...outputRows(details, ctx, shown));
    const rest = preview.length - shown.length;
    if (rest > 0) out.push(trim(` ${theme.fg("muted", `${uiIcon(theme.iconStyle, "gutter")} … ${rest} more`)}`, width, ""));
    return fitResultLines(out, width, expanded, 3);
  }

  // The command was detached at a timeout handoff and is still running somewhere: the
  // exit code is genuinely UNKNOWN, not 0 — a launch is not a success. Neutral marker
  // (no ✓/✗), the log/receipt paths so a caller knows where to look, and whatever
  // output streamed in before the handoff. C-1: also covers the genuinely
  // INDETERMINATE case (`outcome === "unknown"`, e.g. the supervisor died before
  // writing a receipt) — distinguished so this never claims a receipt "appears
  // when it exits" for an outcome that may already be settled.
  if (details.detached) {
    const d = details.detached;
    const indeterminate = details.outcome === "unknown";
    out.push(trim(
      indeterminate
        ? ` ${statusIcon(theme, "on")} ${theme.fg("muted", `${timeoutLabel("outcome unknown")} · ${details.outLines} lines`)}`
        : ` ${statusIcon(theme, "on")} ${theme.fg("muted", `detached · pid ${d.pid ?? "?"} · exit unknown · ${details.outLines} lines so far`)}`,
      width, ""));
    if (d.jobDir) out.push(trim(` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("muted", `logs: ${d.jobDir}`)}`, width, ""));
    // m-1: both sinks now word this row's receipt disclosure identically —
    // the model-facing text (actions/exec.ts's `shape()`) already says
    // "receipt: <path>  (recorded outcome when available)" for BOTH the
    // `timeout` and `unknown` cases; the UI card previously said something
    // different ("status: <path> (appears when it exits)") for `timeout`
    // only, even though the underlying uncertainty is the same shape.
    if (d.receipt) out.push(trim(
      ` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("muted", `receipt: ${d.receipt}  (recorded outcome when available)`)}`,
      width, ""));
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(-1);
    out.push(...outputRows(details, ctx, shown));
    return fitResultLines(out, width, expanded, 3);
  }

  // C-1/I-3: a KNOWN terminal outcome (exited/signal/spawn-error/aborted) whose
  // job directory was retained because its process group could not be proven
  // empty. Checked BEFORE the generic `exitCode === null` branch below so a
  // signal death/spawn error/abort with retained descendants is never shadowed
  // into the neutral "detached"/"exit unknown" wording — the outcome here IS
  // known, even when `exitCode` itself is legitimately `null`.
  if (details.retained) {
    const icon = statusIcon(theme, details.ok ? "ok" : "fail");
    const label =
      details.outcome === "signal" ? `signal ${details.signal ?? "?"}` :
      details.outcome === "spawn-error" ? "spawn error" :
      details.outcome === "aborted" ? `aborted · exit ${details.exitCode}` :
      `exit ${details.exitCode}`;
    const meta = [timeoutLabel(label), `${details.outLines} lines`];
    if (details.ms !== undefined) meta.push(`${details.ms}ms`);
    meta.push("logs retained");
    out.push(trim(` ${icon} ${theme.fg("muted", meta.join(" · "))}`, width, ""));
    out.push(trim(
      ` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("muted", `job dir: ${details.retained.jobDir}${details.retained.reason ? ` — ${details.retained.reason}` : ""}`)}`,
      width, ""));
    if (details.retained.receipt) {
      out.push(trim(
        ` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("muted", `receipt: ${details.retained.receipt}  (recorded outcome when available)`)}`,
        width, ""));
    }
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(0, 1);
    out.push(...outputRows(details, ctx, shown));
    const rest = preview.length - shown.length;
    if (rest > 0) out.push(trim(` ${theme.fg("muted", `${uiIcon(theme.iconStyle, "gutter")} … ${rest} more`)}`, width, ""));
    return fitResultLines(out, width, expanded, 3);
  }

  // M-c: a genuinely unknown exit code that ISN'T the detached-at-handoff shape
  // above (e.g. a batch entry whose outcome is unknown) must still render as
  // neutral UNKNOWN, never laundered into a ✗ failure just because it isn't a
  // clean 0. C-1: EXCEPT a KNOWN signal death or spawn error with NOTHING
  // retained (its process group WAS provably empty) — that outcome is known
  // and must render as a real, visible failure, never neutral.
  if (details.exitCode === null) {
    const known = details.outcome === "signal" || details.outcome === "spawn-error";
    const icon = known ? statusIcon(theme, "fail") : statusIcon(theme, "on");
    // M-b/m-4: an empty batch (no commands at all) is neutral "no commands",
    // not the generic "exit unknown" wording reserved for a genuinely
    // indeterminate single result — the two are different situations that
    // happen to share the same `exitCode: null` shape.
    const isEmptyBatch = details.kind === "batch" && (details.commands ?? []).length === 0;
    const label =
      details.outcome === "signal" ? `signal ${details.signal ?? "?"}` :
      details.outcome === "spawn-error" ? "spawn error" :
      isEmptyBatch ? "no commands" :
      "exit unknown";
    // F-1: a KNOWN signal/spawn-error batch failure that ALSO has at least one
    // genuinely unknown entry alongside it must disclose both facts — never
    // collapse the mix down to just the named failure.
    const metaParts = [timeoutLabel(label), `${details.outLines} lines`];
    if (known && details.unknownCount) metaParts.push(`${details.unknownCount} unknown`);
    if (details.timedOutUnknown) metaParts.push("timed out · outcome unknown");
    out.push(trim(
      ` ${icon} ${theme.fg("muted", metaParts.join(" · "))}`,
      width, ""));
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(0, 1);
    out.push(...outputRows(details, ctx, shown));
    return fitResultLines(out, width, expanded, 3);
  }

  const icon = statusIcon(theme, details.ok ? "ok" : "fail");
  const meta = [timeoutLabel(`exit ${details.exitCode}`), `${details.outLines} lines`];
  if (details.ms !== undefined) meta.push(`${details.ms}ms`);
  // M-c: mixed batch failure+unknown discloses BOTH facts, not just the
  // aggregate numeric failure.
  if (details.unknownCount) meta.push(`${details.unknownCount} unknown`);
  if (details.timedOutUnknown) meta.push("timed out · outcome unknown");
  out.push(trim(` ${icon} ${theme.fg("muted", meta.join(" · "))}`, width, ""));
  const preview = details.preview ?? [];
  const shown = expanded ? preview : preview.slice(0, 1);
  out.push(...outputRows(details, ctx, shown));
  const rest = preview.length - shown.length;
  if (rest > 0) out.push(trim(` ${theme.fg("muted", `${uiIcon(theme.iconStyle, "gutter")} … ${rest} more`)}`, width, ""));
  if (details.indexed) {
    out.push(trim(
      ` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("muted", `indexed → ${details.indexed.source} (${details.indexed.chunks} chunks)`)}`,
      width, ""));
  }
  return fitResultLines(out, width, expanded, 3);
}
