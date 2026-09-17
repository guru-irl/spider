import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { ExecDetails, RenderCtx } from "./types.js";

const CALL_CAP = 10;

/** CALL-header variant (glyph + label). The spider host renders its own call title via
 *  renderSpiderCall, so this is used only where a standalone header is wanted. */
export function renderExecCall(
  details: Pick<ExecDetails, "kind" | "commands">,
  ctx: RenderCtx,
): string[] {
  const { theme, width } = ctx;
  const head = truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold("spider ")) + theme.fg("muted", details.kind),
    width, "",
  );
  const cmds = details.commands ?? [];
  const shown = cmds.slice(0, CALL_CAP);
  const body = shown.map((c) =>
    truncateToWidth(theme.fg("dim", "│ ") + theme.fg("toolOutput", c), width, ""),
  );
  const extra = cmds.length - shown.length;
  if (extra > 0) body.push(truncateToWidth(theme.fg("dim", `│ … +${extra} more`), width, ""));
  return [head, ...body];
}

/** RESULT body (no header — the spider call line already shows `🕸 spider · <kind>` AND the
 *  command). The result carries the OUTPUT. The command is repeated here only when expanded
 *  (ctrl+o), where the full script is worth seeing; showing it collapsed would duplicate the
 *  call header line for line. Then a status line and the output, `renderRun`-style (leading
 *  blank, 1-space indent, `⎿` gutter). */
export function renderExecResult(details: ExecDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const out: string[] = [""];

  // Command block — EXPANDED ONLY. The call header already shows the first lines while the
  // command runs; on ctrl+o we show the whole script, which the header deliberately clips.
  if (expanded) {
    const cmdLines = (details.commands ?? []).flatMap((c) => String(c).split("\n"));
    for (const c of cmdLines) out.push(truncateToWidth(` ${theme.fg("text", c)}`, width, "…"));
  }

  // While running we do not know the exit code, so claiming "✓ exit 0" would be a lie that
  // looks like success. Show a running marker and every line streamed so far — the whole
  // point of streaming is watching it arrive, so the collapsed 1-line preview is wrong here.
  if (details.running) {
    out.push(truncateToWidth(` ${theme.fg("muted", "● running…")}`, width, ""));
    for (const p of details.preview ?? []) {
      out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", p)}`, width, ""));
    }
    return out;
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
    out.push(truncateToWidth(` ${icon} ${theme.fg("muted", metaParts.join(" · "))}`, width, ""));
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(0, 1);
    for (const p of shown) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", p)}`, width, ""));
    const rest = preview.length - shown.length;
    if (rest > 0) out.push(truncateToWidth(` ${theme.fg("muted", `⎿ … ${rest} more`)}`, width, ""));
    return out;
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
    out.push(truncateToWidth(
      indeterminate
        ? ` ${statusIcon(theme, "on")} ${theme.fg("muted", `outcome unknown · ${details.outLines} lines`)}`
        : ` ${statusIcon(theme, "on")} ${theme.fg("muted", `detached · pid ${d.pid ?? "?"} · exit unknown · ${details.outLines} lines so far`)}`,
      width, ""));
    if (d.jobDir) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("muted", `logs: ${d.jobDir}`)}`, width, ""));
    // m-1: both sinks now word this row's receipt disclosure identically —
    // the model-facing text (actions/exec.ts's `shape()`) already says
    // "receipt: <path>  (recorded outcome when available)" for BOTH the
    // `timeout` and `unknown` cases; the UI card previously said something
    // different ("status: <path> (appears when it exits)") for `timeout`
    // only, even though the underlying uncertainty is the same shape.
    if (d.receipt) out.push(truncateToWidth(
      ` ${theme.fg("dim", "⎿ ")}${theme.fg("muted", `receipt: ${d.receipt}  (recorded outcome when available)`)}`,
      width, ""));
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(-1);
    for (const p of shown) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", p)}`, width, ""));
    return out;
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
    const meta = [label, `${details.outLines} lines`];
    if (details.ms !== undefined) meta.push(`${details.ms}ms`);
    meta.push("logs retained");
    out.push(truncateToWidth(` ${icon} ${theme.fg("muted", meta.join(" · "))}`, width, ""));
    out.push(truncateToWidth(
      ` ${theme.fg("dim", "⎿ ")}${theme.fg("muted", `job dir: ${details.retained.jobDir}${details.retained.reason ? ` — ${details.retained.reason}` : ""}`)}`,
      width, ""));
    if (details.retained.receipt) {
      out.push(truncateToWidth(
        ` ${theme.fg("dim", "⎿ ")}${theme.fg("muted", `receipt: ${details.retained.receipt}  (recorded outcome when available)`)}`,
        width, ""));
    }
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(0, 1);
    for (const p of shown) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", p)}`, width, ""));
    const rest = preview.length - shown.length;
    if (rest > 0) out.push(truncateToWidth(` ${theme.fg("muted", `⎿ … ${rest} more`)}`, width, ""));
    return out;
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
    const metaParts = [`${label}`, `${details.outLines} lines`];
    if (known && details.unknownCount) metaParts.push(`${details.unknownCount} unknown`);
    out.push(truncateToWidth(
      ` ${icon} ${theme.fg("muted", metaParts.join(" · "))}`,
      width, ""));
    const preview = details.preview ?? [];
    const shown = expanded ? preview : preview.slice(0, 1);
    for (const p of shown) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", p)}`, width, ""));
    return out;
  }

  const icon = statusIcon(theme, details.ok ? "ok" : "fail");
  const meta = [`exit ${details.exitCode}`, `${details.outLines} lines`];
  if (details.ms !== undefined) meta.push(`${details.ms}ms`);
  // M-c: mixed batch failure+unknown discloses BOTH facts, not just the
  // aggregate numeric failure.
  if (details.unknownCount) meta.push(`${details.unknownCount} unknown`);
  out.push(truncateToWidth(` ${icon} ${theme.fg("muted", meta.join(" · "))}`, width, ""));
  const preview = details.preview ?? [];
  const shown = expanded ? preview : preview.slice(0, 1);
  for (const p of shown) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", p)}`, width, ""));
  const rest = preview.length - shown.length;
  if (rest > 0) out.push(truncateToWidth(` ${theme.fg("muted", `⎿ … ${rest} more`)}`, width, ""));
  if (details.indexed) {
    out.push(truncateToWidth(
      ` ${theme.fg("dim", "⎿ ")}${theme.fg("muted", `indexed → ${details.indexed.source} (${details.indexed.chunks} chunks)`)}`,
      width, ""));
  }
  return out;
}
