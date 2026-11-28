import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { foregroundFromBackground } from "../ansi.js";
import { icon } from "../icons.js";
import { halfEdge, stripRow } from "../tool-card-edge.js";
import { compactCount, introDuration, type IntroTheme } from "./intro-header.js";
import { dockedHinge, HINGE_WIDTH } from "./hinge.js";

export interface DockedUsage {
  credits: number | null;
  calls: number;
  unpricedCalls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number | null;
}

export interface DockedFacts {
  changes: { added: number; removed: number; partial: boolean };
  timeMs: number;
  compactions: number;
  usage?: DockedUsage;
}

export function renderDocked(width: number, theme: IntroTheme, facts: DockedFacts): string[] {
  const { changes, timeMs, compactions, usage } = facts;
  const margin = width >= 24 ? 2 : 0;
  const strip = Math.min(96, width - 2 * margin);
  if (strip <= 0) return [];
  const side = strip >= 54;
  const artLeft = side ? 2 : Math.max(0, Math.floor((strip - HINGE_WIDTH) / 2));
  const textLeft = side ? HINGE_WIDTH + 5 : strip > 4 ? 2 : 0;
  const textWidth = Math.max(1, strip - textLeft - (strip > 4 ? 1 : 0));
  const fg = theme.fg.bind(theme);
  const bold = theme.bold.bind(theme);
  const dim = (text: string) => fg("dim", text);
  const available = !!usage?.calls;
  const rows: [label: string, value: string, details?: string][] = [
    ["Changes", fg("success", bold(`+${changes.added}`)) + " " + fg("error", bold(`−${changes.removed}`)), changes.partial ? "(partial)" : undefined],
    ["AI credits", available && usage.credits !== null ? bold(`~${usage.credits.toFixed(2)}`) : "unavailable", `(${introDuration(timeMs)})`],
    ["Tokens in", available ? bold(`${icon(undefined, "arrowUp")} ${compactCount(usage.input + usage.cacheRead + usage.cacheWrite)}`) : "unavailable",
      available ? `(${compactCount(usage.cacheRead)} cached, ${compactCount(usage.cacheWrite)} written)` : undefined],
    ["Tokens out", available ? bold(`${icon(undefined, "arrowDown")} ${compactCount(usage.output)}`) : "unavailable",
      available && usage.reasoning !== null ? `(${compactCount(usage.reasoning)} reasoning)` : undefined],
    ["Compactions", fg("accent", bold(String(compactions)))],
  ];
  const lines = [bold("Docked"), ""];
  for (const [label, value, details] of rows) {
    const pair = fg("muted", label.padEnd(13)) + value;
    if (details && visibleWidth(pair) + details.length + 1 <= textWidth) lines.push(pair + " " + dim(details));
    else {
      lines.push(...wrapTextWithAnsi(pair, textWidth));
      if (details) lines.push(...wrapTextWithAnsi(dim(details), textWidth));
    }
  }
  if (available) lines.push(...wrapTextWithAnsi(dim(usage.unpricedCalls ? "Cached usage · some calls unpriced" : "Cached usage"), textWidth));
  const art = strip >= HINGE_WIDTH ? dockedHinge(theme) : [];
  const image = art.map(line => " ".repeat(artLeft) + line);
  const content = side ? lines.map((line, i) => {
    const imageRow = image[i - Math.floor((lines.length - image.length) / 2)] ?? "";
    return imageRow + " ".repeat(textLeft - visibleWidth(imageRow)) + line;
  }) : [...image, ...lines.map(line => " ".repeat(textLeft) + line)];
  const indent = " ".repeat(margin), bg = theme.getBgAnsi("customMessageBg");
  const ink = foregroundFromBackground(bg);
  return [
    ...(ink ? [indent + halfEdge(ink, strip, "top")] : []),
    ...content.map(line => indent + stripRow(line, bg, strip)),
    ...(ink ? [indent + halfEdge(ink, strip, "bottom")] : []),
  ];
}
