import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderProgressBar } from "../components/progress-bar";
import { Spinner } from "../components/spinner";
import { formatDuration } from "./footer";
import { STATUS_GLYPH, statusToken } from "./types";
import type { AgentSnapshot, ThemeAdapter } from "./types";

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

/** Short, grey run-id shown as a subheading under the name. */
export function shortId(runId: string): string {
  return "#" + runId.slice(0, 8);
}

/** Greedy word-wrap plain text to `width` columns, capped at `maxLines` (last line …-truncated). */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? cur + " " + w : w;
    if (visibleWidth(cand) > width && cur) { lines.push(cur); cur = w; } else { cur = cand; }
    if (lines.length >= maxLines) { cur = ""; break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines).map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
}

export function renderGridCell(
  theme: ThemeAdapter,
  opts: { agent: AgentSnapshot; width: number; height: number; focused: boolean; pinned: boolean; now: number; spinner: Spinner; expanded?: boolean },
): string[] {
  const { agent: a, width, height, focused, pinned, now, spinner, expanded } = opts;
  const glyph = a.status === "running" ? spinner.frame(now) : STATUS_GLYPH[a.status];
  const marker = focused ? "▸ " : "  ";
  const pin = pinned ? " 📌" : "";
  const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? now) - a.startedAt;

  // line 0 — NAME as the primary heading.
  const header = fit(`${marker}${theme.fg(statusToken(a.status), glyph)} ${theme.glyph} ${theme.bold(a.name)}${pin}`, width);
  // line 1 — dim/grey run-id subheading + status + elapsed.
  const sub = fit("  " + theme.fg("dim", `${shortId(a.runId)} · ${a.status} · ${formatDuration(elapsedMs)}`), width);

  const bodyRows = Math.max(0, height - 3); // header, sub, footer
  const body: string[] = [];
  const task = (a.task ?? "").trim();
  if (expanded && task) {
    // Ctrl+O: full instructions, wrapped across the body.
    const wrapped = wrapText(task, Math.max(1, width - 2), bodyRows);
    for (let i = 0; i < bodyRows; i++) body.push(wrapped[i] ? "  " + theme.fg("muted", wrapped[i]) : "");
  } else {
    // Collapsed: 1-line truncated instructions, then the recent-activity tail.
    if (task && bodyRows > 0) body.push(fit("  " + theme.fg("muted", "↳ " + task), width));
    const actRows = bodyRows - body.length;
    const tail = a.recentActivity.slice(-actRows);
    for (let i = 0; i < actRows; i++) body.push(tail[i] ? fit("    " + theme.fg("dim", tail[i]), width) : "");
  }

  const bar = renderProgressBar(theme, { value: a.stepCount, max: Math.max(a.stepCount, 1), width: Math.max(1, width - 8) });
  const phaseLabel = theme.fg("dim", (a.phase ? a.phase + " " : "") + `${a.stepCount}⋯${a.tokenCount}t`);
  const footer = fit(`${bar} ${phaseLabel}`, width);

  const lines = [header, sub, ...body, footer];
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}
