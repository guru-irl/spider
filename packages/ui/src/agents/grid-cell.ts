import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderProgressBar } from "../components/progress-bar.js";
import { Spinner } from "../components/spinner.js";
import { formatDuration } from "./footer.js";
import { STATUS_GLYPH, statusToken } from "./types.js";
import type { AgentSnapshot, ThemeAdapter } from "./types.js";

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

export function renderGridCell(
  theme: ThemeAdapter,
  opts: { agent: AgentSnapshot; width: number; height: number; focused: boolean; pinned: boolean; now: number; spinner: Spinner },
): string[] {
  const { agent: a, width, height, focused, pinned, now, spinner } = opts;
  const glyph = a.status === "running" ? spinner.frame(now) : STATUS_GLYPH[a.status];
  const marker = focused ? "▸ " : "  ";
  const pin = pinned ? "📌" : "";
  const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? now) - a.startedAt;
  const header = fit(
    `${marker}${theme.fg(statusToken(a.status), glyph)} ${theme.glyph} ${theme.bold(a.name)}${pin} ` +
      theme.fg("muted", `· ${a.status} · ${formatDuration(elapsedMs)}`),
    width,
  );

  const bodyRows = Math.max(0, height - 2);
  const tail = a.recentActivity.slice(-bodyRows);
  const body: string[] = [];
  for (let i = 0; i < bodyRows; i++) {
    const s = tail[i];
    body.push(s ? fit("  " + theme.fg("muted", s), width) : "");
  }

  const bar = renderProgressBar(theme, { value: a.stepCount, max: Math.max(a.stepCount, 1), width: Math.max(1, width - 8) });
  const phaseLabel = theme.fg("dim", (a.phase ? a.phase + " " : "") + `${a.stepCount}⋯${a.tokenCount}t`);
  const footer = fit(`${bar} ${phaseLabel}`, width);

  const lines = [header, ...body, footer];
  // Guarantee exactly `height` lines.
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}
