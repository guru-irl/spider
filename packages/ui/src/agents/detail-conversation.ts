import { sliceByColumn, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { icon } from "../icons.js";
import { formatDuration } from "./footer";
import { activityText, type AgentSnapshot, type StoredRunEvent, type ThemeAdapter } from "./types";

export interface SourceAnchor { eventId: number; textOffset: number; }
export interface ConversationBlock { key: string; eventId?: number; text: string; assistantMessage: boolean; }
export interface WrappedRow { text: string; anchor?: SourceAnchor; }

function recordedTime(payload: unknown): string | undefined {
  const ms = (payload as { durationMs?: unknown } | null | undefined)?.durationMs;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** Project only recorded content. A live activity has a local, uncounted key. */
export function projectConversation(
  events: readonly StoredRunEvent[], run: AgentSnapshot, theme: ThemeAdapter,
): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  for (const event of events) {
    const time = recordedTime(event.payload);
    let text: string | undefined;
    switch (event.type) {
      case "message": {
        const parts: string[] = [];
        if (event.summary) parts.push(theme.fg("text", event.summary));
        if (time !== undefined) parts.push(theme.fg("dim", `response time ${time}`));
        if (parts.length) text = parts.join("\n");
        break;
      }
      case "tool_intent":
        text = theme.fg("accent", `${icon(theme.iconStyle, "message")} ${event.summary ?? event.tool ?? "tool"}`);
        break;
      case "tool_result":
        if (event.summary || time !== undefined) {
          const isError = (event.payload as { isError?: unknown } | undefined)?.isError === true;
          const summary = activityText(theme, event.summary || event.tool || "tool", isError);
          text = theme.fg("muted", `${time === undefined ? "" : `tool time ${time} · `}${summary}`);
        }
        break;
      case "handoff":
        if (event.summary) {
          const arrow = icon("text", "arrowRight");
          const parts = event.summary.split(arrow);
          const isRolePair = parts.length === 2 && parts[0] === (run.role ?? run.agent) && /^\S+$/.test(parts[1]!);
          const summary = isRolePair && theme.italic ? `${theme.italic(parts[0]!)}${arrow}${theme.italic(parts[1]!)}` : event.summary;
          text = theme.fg("accent", `${icon(theme.iconStyle, "handoff")} ${summary}`);
        }
        break;
      case "warning":
        if (event.summary) text = theme.fg("warning", `${icon(theme.iconStyle, "warning")} ${event.summary}`);
        break;
    }
    if (text !== undefined) {
      blocks.push({ key: `event:${event.id}`, eventId: event.id, text, assistantMessage: event.type === "message" });
    }
  }
  if (run.status === "running" && run.activity) {
    blocks.push({ key: "activity", text: theme.fg("accent", `${icon(theme.iconStyle, "select")} ${activityText(theme, run.activity, run.activityIsError)}`), assistantMessage: false });
  }
  return blocks;
}

interface Cell { text: string; plain: string; offset: number; width: number; }
interface LineBreak { newline: true; text: string; nextOffset: number; }
type Unit = Cell | LineBreak;

// Match the terminal sequences that pi's public stripTerminalSequences removes.
// Keep them at the corresponding plain-text offset so segmentation happens on
// the complete visible text, even when a style changes inside a grapheme.
const terminalSequence = /\x1b(?:\[[^\x1b]*?[mGKHJ]|[\]_](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\))/y;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function splitStyled(text: string): { plain: string; codes: Map<number, string> } {
  let plain = "";
  const codes = new Map<number, string>();
  for (let i = 0; i < text.length;) {
    terminalSequence.lastIndex = i;
    const match = text[i] === "\x1b" ? terminalSequence.exec(text) : null;
    if (match && stripTerminalSequences(match[0]) === "") {
      codes.set(plain.length, (codes.get(plain.length) ?? "") + match[0]);
      i += match[0].length;
    } else {
      plain += text[i];
      i++;
    }
  }
  return { plain, codes };
}

function styledUnits(text: string, width: number): { units: Unit[]; tail: string; length: number } {
  const { plain, codes } = splitStyled(text);
  const units: Unit[] = [];
  let logicalColumn = 0;
  for (const { segment, index } of graphemes.segment(plain)) {
    let styled = "";
    let controls = "";
    for (let i = index; i < index + segment.length; i++) {
      const code = codes.get(i) ?? "";
      controls += code;
      styled += code + plain[i];
    }
    if (segment === "\n" || segment === "\r" || segment === "\r\n") {
      units.push({ newline: true, text: controls, nextOffset: index + segment.length });
      logicalColumn = 0;
    } else if (segment === "\t") {
      const count = 4 - logicalColumn % 4;
      for (let i = 0; i < count; i++) units.push({ text: (i === 0 ? controls : "") + " ", plain: " ", offset: index, width: 1 });
      logicalColumn += count;
    } else {
      const actualWidth = visibleWidth(segment);
      logicalColumn += actualWidth;
      const tooWide = actualWidth > width;
      units.push({ text: tooWide ? controls + "�" : styled, plain: tooWide ? "�" : segment,
        offset: index, width: tooWide ? 1 : actualWidth });
    }
  }
  return { units, tail: codes.get(plain.length) ?? "", length: plain.length };
}

function wrapBlock(block: ConversationBlock, width: number): WrappedRow[] {
  const { units, tail, length } = styledUnits(block.text, width);
  const lines: string[] = [];
  const offsets: number[] = [];
  let current = "";
  let column = 0;
  let start = 0;
  const finish = (nextOffset: number) => {
    lines.push(current);
    offsets.push(start);
    current = "";
    column = 0;
    start = nextOffset;
  };
  const append = (cell: Cell) => {
    if (column > 0 && column + cell.width > width) finish(cell.offset);
    current += cell.text;
    column += cell.width;
  };

  for (let i = 0; i < units.length;) {
    const unit = units[i]!;
    if ("newline" in unit) {
      current += unit.text;
      finish(unit.nextOffset);
      i++;
      continue;
    }
    if (/^\s+$/u.test(unit.plain)) {
      append(unit);
      i++;
      continue;
    }
    let end = i;
    let wordWidth = 0;
    while (end < units.length) {
      const next = units[end]!;
      if ("newline" in next || /^\s+$/u.test(next.plain)) break;
      wordWidth += next.width;
      end++;
    }
    if (wordWidth <= width && column > 0 && column + wordWidth > width) finish(unit.offset);
    while (i < end) append(units[i++] as Cell);
  }
  current += tail;
  finish(length);

  // Each line already fits. Pi restores the active ANSI state across our
  // inserted breaks without trimming indentation or boundary whitespace.
  const styled = wrapTextWithAnsi(lines.join("\n"), width);
  return styled.map((text, i) => ({
    text: visibleWidth(text) <= width ? text : sliceByColumn(text, 0, width, true),
    ...(block.eventId === undefined ? {} : { anchor: { eventId: block.eventId, textOffset: offsets[i]! } }),
  }));
}

export function wrapConversation(blocks: readonly ConversationBlock[], textWidth: number): WrappedRow[] {
  const width = Number.isFinite(textWidth) ? Math.max(1, Math.floor(textWidth)) : 1;
  return blocks.flatMap(block => wrapBlock(block, width));
}

/** Locate the row containing a source position, or the nearest surviving event. */
export function resolveAnchor(anchor: SourceAnchor, previousRows: readonly WrappedRow[], nextRows: readonly WrappedRow[]): number {
  if (!nextRows.length) return 0;
  let candidate = -1;
  let bestOffset = -1;
  for (let i = 0; i < nextRows.length; i++) {
    const source = nextRows[i]!.anchor;
    if (source?.eventId !== anchor.eventId) continue;
    if (candidate < 0) candidate = i;
    if (source.textOffset <= anchor.textOffset && source.textOffset > bestOffset) {
      candidate = i;
      bestOffset = source.textOffset;
    }
  }
  if (candidate >= 0) return candidate;

  const order: number[] = [];
  for (const row of previousRows) {
    const id = row.anchor?.eventId;
    if (id !== undefined && !order.includes(id)) order.push(id);
  }
  const oldIndex = order.indexOf(anchor.eventId);
  if (oldIndex < 0) return 0;
  for (let distance = 1; distance < order.length; distance++) {
    const nextId = order[oldIndex + distance];
    const nextIndex = nextRows.findIndex(row => row.anchor?.eventId === nextId && nextId !== undefined);
    if (nextIndex >= 0) return nextIndex;
    const previousId = order[oldIndex - distance];
    if (previousId !== undefined) {
      for (let i = nextRows.length - 1; i >= 0; i--) {
        if (nextRows[i]!.anchor?.eventId === previousId) return i;
      }
    }
  }
  return 0;
}
