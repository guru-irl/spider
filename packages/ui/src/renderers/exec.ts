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

/** RESULT body (no header — the spider call line already shows `🕸 spider · <kind>`).
 *  The full command is shown ABOVE the output in white (`text`): collapsed to its first line,
 *  fully expanded on ctrl+o. Then a status line and the output, `renderRun`-style (leading
 *  blank, 1-space indent, `⎿` gutter). */
export function renderExecResult(details: ExecDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const out: string[] = [""];

  // Command block — white, above the output. exec → the full script (per line); exec_file → the
  // path; batch → each command label. Collapsed shows the first line + a ctrl+o hint; ctrl+o
  // (expanded) shows every line.
  const cmdLines = (details.commands ?? []).flatMap((c) => String(c).split("\n"));
  if (cmdLines.length) {
    const shownCmd = expanded ? cmdLines : cmdLines.slice(0, 1);
    for (const c of shownCmd) out.push(truncateToWidth(` ${theme.fg("text", c)}`, width, "…"));
    const restCmd = cmdLines.length - shownCmd.length;
    if (restCmd > 0) out.push(truncateToWidth(` ${theme.fg("dim", `… +${restCmd} more line${restCmd === 1 ? "" : "s"} (ctrl+o)`)}`, width, ""));
  }

  const icon = statusIcon(theme, details.ok ? "ok" : "fail");
  const meta = [`exit ${details.exitCode}`, `${details.outLines} lines`];
  if (details.ms !== undefined) meta.push(`${details.ms}ms`);
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
