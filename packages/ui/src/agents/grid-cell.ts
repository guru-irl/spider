import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, shortModel } from "./footer";
import { activityText, renderAgentStatus } from "./types";
import { icon } from "../icons.js";
import type { AgentSnapshot, ThemeAdapter } from "./types";

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

/** Short, grey run-id (kept for the detail view / callers that want it). */
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
  opts: { agent: AgentSnapshot; width: number; height: number; focused: boolean; pinned: boolean; now: number },
): string[] {
  const { agent: a, width, height, focused, pinned, now } = opts;
  const marker = focused ? `${icon(theme.iconStyle, "select")} ` : "  ";
  const pin = pinned ? ` ${icon(theme.iconStyle, "pin")}` : "";
  const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? now) - a.startedAt;
  const turns = a.stepCount === 1 ? "1 turn" : `${a.stepCount} turns`;

  // line 0 — activity or status mark, NAME.
  const header = fit(`${marker}${renderAgentStatus(theme, a, now)} ${theme.bold(a.name)}${pin}`, width);
  // line 1 — type · model · turns · elapsed (status is conveyed by the glyph colour).
  const role = a.role ?? a.agent;
  const meta = fit("  " + theme.fg("dim", `${theme.italic?.(role) ?? role} · ${shortModel(a.model)} · ${turns} · ${formatDuration(elapsedMs)}`), width);

  const bodyRows = Math.max(0, height - 2); // header, meta
  const body: string[] = [];
  const task = (a.task ?? "").trim();
  if (task && bodyRows > 0) body.push(fit("  " + theme.fg("muted", `${icon(theme.iconStyle, "task")} ` + task), width));
  const actRows = bodyRows - body.length;
  const tail = a.recentActivity.slice(-actRows);
  const errors = a.recentActivityErrors?.slice(-actRows);
  for (let i = 0; i < actRows; i++) body.push(tail[i] ? fit("    " + theme.fg("dim", activityText(theme, tail[i], errors?.[i])), width) : "");

  const lines = [header, meta, ...body];
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}
