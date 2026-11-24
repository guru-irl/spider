/**
 * Adapted from pi-copy-button by Jonas Silva (MIT), commit fb8fb1f.
 * See NOTICE.md for attribution and licence. Pi exposes no assistant-render hook,
 * so this patches its assistant prototype and individual Markdown instances.
 */
import type { AssistantMessageComponent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, type Markdown, type TUI, type TuiMouseEvent, type TuiMouseEventResult, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Lexer, type MarkedToken, type Token } from "marked";
import { blocksToPlain } from "./plain.js";

type Format = "text" | "md";
type Block = Record<Format, string>;
type Hit = { row: number; start: number; end: number; block: number; format: Format };
type Copied = { block: number; format: Format };
export type CopyButtonsHost = { AssistantMessageComponent: typeof AssistantMessageComponent; Markdown: typeof Markdown };
export type CopyButtonsOptions = {
  isFullscreen: () => boolean;
  copy: (text: string) => Promise<void>;
  requestRender: () => void;
  onError: (error: unknown) => void;
  border?: (text: string) => string;
};
type State = { options: CopyButtonsOptions; enabled: boolean; hovered?: object; trackingMove?: boolean; hoverSeen?: boolean; detach?: () => void };
type MarkdownInternals = {
  renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
  render(width: number): string[];
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};
type AssistantInternals = {
  contentContainer?: { children?: Component[] };
  isStreaming?: boolean;
  updateContent(...args: unknown[]): void;
};
type Patch = { original: AssistantInternals["updateContent"]; state: State };
const PATCH = Symbol.for("spider.copy-buttons.updateContent");
type PatchedProto = AssistantInternals & { [PATCH]?: Patch };

// OSC markers survive pi's line wrapping and are removed before display.
const mark = (i: number) => `\x1b]7799;${i}\x07`;
const MARKER = /\x1b\]7799;(\d+)\x07/g;
const LABELS: Record<Format, string> = { text: "⧉ text", md: "⧉ md" };
const DONE = "✓ copied";
const COLUMN = Math.max(...[...Object.values(LABELS), DONE].map(visibleWidth));
const GROUP_WIDTH = COLUMN * 2 + 1;
const TIME_WIDTH = 12;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const pad = (text: string) => text + " ".repeat(Math.max(0, COLUMN - visibleWidth(text)));

function formatTime(date: Date, today: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return date.toDateString() === today.toDateString()
    ? time
    : `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)} ${time}`;
}

function addButtons(md: Markdown, host: CopyButtonsHost, state: State, source: string, full: string | undefined, timestamp: number, messageGroup: object): void {
  const self = md as unknown as MarkdownInternals;
  const base = host.Markdown.prototype as unknown as MarkdownInternals;
  if (self.handleMouse || typeof base.renderToken !== "function" || typeof base.render !== "function") return;
  let depth = 0;
  let blocks: Block[] = [];
  let sectionStart: number | undefined;
  const originalTokens = Lexer.lex(source.trim());
  let sourceIndex = 0;
  let raw: string[] | undefined;
  let copied: Copied | undefined;
  let timeKey: string | undefined;
  let formattedTime = "";
  let out: { raw: string[]; copied: Copied | undefined; show: boolean; frame: boolean; width: number; time: string; lines: string[]; hits: Hit[] } | undefined;

  const addBlock = (block: Block, lines: string[]) => {
    const last = lines.findLastIndex(line => line !== "");
    if (!block.md || last < 0) return;
    lines[last] = mark(blocks.push(block) - 1) + lines[last];
  };
  self.renderToken = (token, width, nextTokenType, styleContext) => {
    const top = depth++ === 0;
    try {
      const lines = base.renderToken.call(md, token, width, nextTokenType, styleContext);
      if (!top) return lines;
      let index = sourceIndex;
      if (originalTokens[index]?.type !== token.type) {
        index = originalTokens.findIndex((candidate, i) => i >= sourceIndex && candidate.type === token.type && candidate.raw.replaceAll("\t", "   ") === token.raw);
      }
      if (index < 0 || !originalTokens[index]) return lines;
      sourceIndex = index + 1;
      const sourceToken = originalTokens[index];
      if (token.type === "hr") {
        if (sectionStart !== undefined) {
          const section = originalTokens.slice(sectionStart, index);
          addBlock({ md: section.map(t => t.raw).join("").trim(), text: blocksToPlain(section) }, lines);
        }
        sectionStart = index + 1;
        return lines;
      }
      const t = sourceToken as MarkedToken;
      if (t.type === "code") addBlock({ md: t.raw.trimEnd(), text: t.text }, lines);
      if (t.type === "blockquote") addBlock({ md: t.raw.trimEnd(), text: blocksToPlain(t.tokens) }, lines);
      return lines;
    } finally { depth--; }
  };
  self.render = width => {
    const previous = blocks;
    blocks = [];
    sectionStart = undefined;
    sourceIndex = 0;
    // Reserve the frame in both hover states so its appearance never reflows text.
    const frame = state.enabled && state.options.isFullscreen() && width >= 3;
    const next = base.render.call(md, frame ? width - 2 : width);
    sectionStart = undefined;
    if (next === raw) blocks = previous;
    raw = next;
    const show = frame && state.hovered === messageGroup;
    if (frame) {
      const date = new Date(timestamp);
      const today = new Date();
      const key = `${today.toDateString()}|${date.getTimezoneOffset()}`;
      if (key !== timeKey) {
        timeKey = key;
        formattedTime = formatTime(date, today);
      }
    }
    const time = frame ? formattedTime : "";
    if (!out || out.raw !== next || out.copied !== copied || out.show !== show || out.frame !== frame || out.width !== width || out.time !== time) {
      out = { raw: next, copied, show, frame, width, time, ...decorate(next, blocks, copied, width, show, frame, full, time, state.options.border ?? dim) };
    }
    return out.lines;
  };
  self.handleMouse = event => {
    if (!state.enabled || !state.options.isFullscreen()) return undefined;
    if (event.type === "move") {
      if (state.trackingMove) state.hoverSeen = true;
      if (state.hovered !== messageGroup) {
        state.hovered = messageGroup;
        state.options.requestRender();
      }
      return undefined;
    }
    if (event.type !== "click" || event.button !== "left" || state.hovered !== messageGroup || !out) return undefined;
    const hit = out.hits.find(h => h.row === event.y && event.x >= h.start && event.x < h.end);
    const block = hit && (hit.block === blocks.length && full !== undefined
      ? { md: full, text: blocksToPlain(Lexer.lex(full)) } : blocks[hit.block]);
    if (!hit || !block) return undefined;
    const done: Copied = { block: hit.block, format: hit.format };
    try {
      void state.options.copy(block[hit.format]).then(() => {
        copied = done;
        state.options.requestRender();
        setTimeout(() => {
          if (copied === done) copied = undefined;
          state.options.requestRender();
        }, 1500);
      }, error => state.options.onError(error));
    } catch (error) { state.options.onError(error); }
    return { handled: true };
  };
}

function decorate(raw: string[], blocks: Block[], copied: Copied | undefined, width: number, show: boolean, frame: boolean, full: string | undefined, time: string, border: (text: string) => string): { lines: string[]; hits: Hit[] } {
  const lines: string[] = [];
  const hits: Hit[] = [];
  const innerWidth = frame ? width - 2 : width;
  const last = full === undefined ? -1 : raw.findLastIndex(line => stripTerminalSequences(line.replace(MARKER, "")).trim() !== "");
  const addRow = (clean: string, block: number) => {
    const col = Math.max(0, innerWidth - GROUP_WIDTH - 1);
    const body = clean.trimEnd();
    const bodyWidth = visibleWidth(body);
    // Reserve action space even while hidden. Stack the date only when needed.
    const timeWidth = Math.min(TIME_WIDTH, Math.max(0, col - 1));
    const timeCol = Math.max(0, col - timeWidth - 1);
    if (bodyWidth > 0 && bodyWidth + 2 > timeCol) { lines.push(clean); clean = ""; }
    const prefix = clean ? body : "";
    const start = clean ? bodyWidth : 0;
    const stackedTime = visibleWidth(time) > timeWidth;
    if (stackedTime) {
      lines.push(show ? `${" ".repeat(Math.max(0, innerWidth - visibleWidth(time)))}${dim(time)}` : " ".repeat(innerWidth));
    }
    if (!show) {
      lines.push(clean || " ".repeat(innerWidth));
      return;
    }
    const text = copied?.block === block && copied.format === "text" ? DONE : LABELS.text;
    const md = copied?.block === block && copied.format === "md" ? DONE : LABELS.md;
    hits.push({ row: lines.length + 1, start: col + 1, end: col + COLUMN + 1, block, format: "text" });
    hits.push({ row: lines.length + 1, start: col + COLUMN + 2, end: col + GROUP_WIDTH + 1, block, format: "md" });
    const timeText = time && !stackedTime ? `${" ".repeat(timeWidth - visibleWidth(time))}${time} ` : "";
    lines.push(`${prefix}${" ".repeat(col - start - visibleWidth(timeText))}${dim(timeText)}${dim(pad(text))} ${dim(pad(md))}${" ".repeat(Math.max(0, innerWidth - col - GROUP_WIDTH))}`);
  };
  for (const [row, line] of raw.entries()) {
    const marks = [...line.matchAll(MARKER)];
    const clean = marks.length ? line.replace(MARKER, "") : line;
    const block = marks.map(([, i]) => Number(i)).find(i => blocks[i] !== undefined);
    if (!frame || innerWidth < GROUP_WIDTH + 1) { lines.push(clean); continue; }
    if (block !== undefined) addRow(clean, block);
    else if (row === last) { addRow(clean, blocks.length); continue; }
    else lines.push(clean);
    if (row === last && full !== undefined) addRow("", blocks.length);
  }
  if (!frame || lines.length === 0) return { lines, hits };
  const edge = (text: string) => show ? border(text) : " ".repeat(visibleWidth(text));
  return {
    lines: [edge(`┌${"─".repeat(innerWidth)}┐`), ...lines.map(line => `${edge("│")}${line}${edge("│")}`), edge(`└${"─".repeat(innerWidth)}┘`)],
    hits,
  };
}

function clearHover(state: State): void {
  if (!state.hovered) return;
  state.hovered = undefined;
  state.options.requestRender();
}

// Pi consumes fullscreen mouse input before extension listeners. Observe its
// viewport dispatch without consuming or changing the event.
function observeViewport(tui: TUI, state: State): () => void {
  const viewport = tui as unknown as { handleViewportInput?: (data: string) => unknown; doRender?: () => void; readonly viewportTop?: number };
  const original = viewport.handleViewportInput;
  if (typeof original !== "function") return () => {};
  let top = viewport.viewportTop;
  const wrapped = function (this: unknown, data: string): unknown {
    const match = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(data);
    const button = match ? Number(match[1]) : data.length === 6 && data.startsWith("\x1b[M") ? data.charCodeAt(3) - 32 : 0;
    const motion = !!match && match[2] === "M" && (button & 32) !== 0 && (button & 64) === 0;
    if (!state.enabled) return original.call(this, data);
    if (data === "\x1b[O" || (button & 64) !== 0) clearHover(state);
    top = viewport.viewportTop;
    if (motion) {
      state.trackingMove = true;
      state.hoverSeen = false;
    }
    try { return original.call(this, data); }
    finally {
      if (motion) {
        state.trackingMove = false;
        if (!state.hoverSeen) clearHover(state);
      }
    }
  };
  viewport.handleViewportInput = wrapped;
  const request = tui.requestRender;
  let columns = tui.terminal.columns;
  let rows = tui.terminal.rows;
  const resized = function (this: TUI, force?: boolean): void {
    if (columns !== tui.terminal.columns || rows !== tui.terminal.rows || top !== viewport.viewportTop) {
      columns = tui.terminal.columns;
      rows = tui.terminal.rows;
      top = viewport.viewportTop;
      if (state.enabled) clearHover(state);
    }
    request.call(this, force);
  };
  tui.requestRender = resized;
  // Follow-end can move the viewport inside layout, after requestRender.
  const draw = viewport.doRender;
  const drawn = function (this: unknown): void {
    const before = viewport.viewportTop;
    draw?.call(this);
    top = viewport.viewportTop;
    if (state.enabled && before !== top) clearHover(state);
  };
  if (draw) viewport.doRender = drawn;
  return () => {
    if (viewport.handleViewportInput === wrapped) viewport.handleViewportInput = original;
    if (tui.requestRender === resized) tui.requestRender = request;
    if (viewport.doRender === drawn) viewport.doRender = draw;
  };
}

/** Install once per host prototype; reload updates the shared options rather than wrapping again. */
export function installCopyButtons(host: CopyButtonsHost, options: CopyButtonsOptions): void {
  const proto = host.AssistantMessageComponent?.prototype as unknown as PatchedProto | undefined;
  const markdown = host.Markdown?.prototype as unknown as MarkdownInternals | undefined;
  if (!proto || typeof proto.updateContent !== "function" || !markdown || typeof markdown.renderToken !== "function" || typeof markdown.render !== "function") return;
  if (proto[PATCH]) { proto[PATCH].state.options = options; proto[PATCH].state.enabled = true; return; }
  const state: State = { options, enabled: true };
  const original = proto.updateContent;
  proto[PATCH] = { original, state };
  proto.updateContent = function (this: AssistantInternals, ...args: unknown[]) {
    original.apply(this, args);
    if (!state.enabled || this.isStreaming) return;
    const message = args[0] as { content?: { type?: string; text?: string }[]; timestamp: number } | undefined;
    const content = message?.content;
    if (!Array.isArray(content) || !Array.isArray(this.contentContainer?.children)) return;
    const text = content.filter(c => c.type === "text" && typeof c.text === "string" && c.text.trim()).map(c => c.text!);
    const children = this.contentContainer.children.filter((child): child is Markdown => child instanceof host.Markdown);
    const messageGroup = {};
    for (const [i, child] of children.entries()) addButtons(child, host, state, text[i] ?? "", i === children.length - 1 ? text.join("\n\n") : undefined, message!.timestamp, messageGroup);
  };
}

export function registerCopyButtons(pi: Pick<ExtensionAPI, "on">, host: CopyButtonsHost, readConfig: (cwd: string) => Record<string, unknown>, copy: (text: string) => Promise<void>): void {
  pi.on("session_start", (_event, ctx) => {
    disableCopyButtons(host);
    if (process.env.PI_SUBAGENT_CHILD === "1" || ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      if (readConfig(ctx.cwd)["copyButtons.enabled"] === false) return;
      let tui: TUI | undefined;
      installCopyButtons(host, {
        isFullscreen: () => tui?.mode === "fullscreen",
        copy,
        requestRender: () => tui?.requestRender(),
        border: text => ctx.ui.theme?.fg("borderMuted", text) ?? dim(text),
        onError: error => ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
      });
      ctx.ui.setWidget("spider-copy-buttons", current => {
        tui = current;
        const state = (host.AssistantMessageComponent.prototype as unknown as PatchedProto)[PATCH]?.state;
        if (state) state.detach?.();
        const detach = state && observeViewport(current, state);
        if (state) state.detach = detach;
        return {
          render: () => [], invalidate: () => {},
          dispose: () => {
            if (state && state.detach === detach) {
              disableCopyButtons(host);
              state.options.requestRender();
            }
          },
        };
      });
    } catch { disableCopyButtons(host); }
  });
  pi.on("session_shutdown", () => { disableCopyButtons(host); });
}

/** Disable a previous activation without undoing other extensions' prototype wrappers. */
export function disableCopyButtons(host: CopyButtonsHost): void {
  const proto = host.AssistantMessageComponent?.prototype as unknown as PatchedProto | undefined;
  if (proto?.[PATCH]) {
    const state = proto[PATCH].state;
    state.enabled = false;
    state.hovered = undefined;
    state.detach?.();
    state.detach = undefined;
  }
}
