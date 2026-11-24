/**
 * Adapted from pi-copy-button by Jonas Silva (MIT), commit fb8fb1f.
 * See NOTICE.md for attribution and licence. Pi exposes no assistant-render hook,
 * so this patches its assistant prototype and individual Markdown instances.
 */
import type { AssistantMessageComponent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, type Markdown, type TUI, type TuiMouseEvent, type TuiMouseEventResult, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Lexer, type MarkedToken, type Token } from "marked";
import { icon, type IconStyle } from "@spider/ui";
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
  iconStyle?: IconStyle;
};
type State = { options: CopyButtonsOptions; enabled: boolean };
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
const labels = (style?: IconStyle): Record<Format, string> => ({ text: `${icon(style, "copy")} text`, md: `${icon(style, "copy")} md` });
const DONE = "✓ copied";
const COLUMN = Math.max(...[...Object.values(labels("text")), ...Object.values(labels("nerd")), DONE].map(visibleWidth));
const GROUP_WIDTH = COLUMN * 2 + 1;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const pad = (text: string) => text + " ".repeat(Math.max(0, COLUMN - visibleWidth(text)));

function addButtons(md: Markdown, host: CopyButtonsHost, state: State, source: string, full: string | undefined): void {
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
  let out: { raw: string[]; copied: Copied | undefined; show: boolean; iconStyle?: IconStyle; lines: string[]; hits: Hit[] } | undefined;

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
    const next = base.render.call(md, width);
    sectionStart = undefined;
    if (next === raw) blocks = previous;
    raw = next;
    const show = state.enabled && state.options.isFullscreen();
    const iconStyle = state.options.iconStyle;
    if (!out || out.raw !== next || out.copied !== copied || out.show !== show || out.iconStyle !== iconStyle) {
      out = { raw: next, copied, show, iconStyle, ...decorate(next, blocks, copied, width, show, full, iconStyle) };
    }
    return out.lines;
  };
  self.handleMouse = event => {
    if (!state.enabled || !state.options.isFullscreen() || event.type !== "click" || event.button !== "left" || !out) return undefined;
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

function decorate(raw: string[], blocks: Block[], copied: Copied | undefined, width: number, show: boolean, full: string | undefined, iconStyle?: IconStyle): { lines: string[]; hits: Hit[] } {
  const LABELS = labels(iconStyle);
  const lines: string[] = [];
  const hits: Hit[] = [];
  const last = full === undefined ? -1 : raw.findLastIndex(line => stripTerminalSequences(line.replace(MARKER, "")).trim() !== "");
  const addRow = (clean: string, block: number) => {
    const col = Math.max(0, width - GROUP_WIDTH - 1);
    const body = clean.trimEnd();
    const bodyWidth = visibleWidth(body);
    if (bodyWidth + 2 > col) { lines.push(clean); clean = ""; }
    const prefix = clean ? body : "";
    const start = clean ? bodyWidth : 0;
    const text = copied?.block === block && copied.format === "text" ? DONE : LABELS.text;
    const md = copied?.block === block && copied.format === "md" ? DONE : LABELS.md;
    hits.push({ row: lines.length, start: col, end: col + COLUMN, block, format: "text" });
    hits.push({ row: lines.length, start: col + COLUMN + 1, end: col + GROUP_WIDTH, block, format: "md" });
    lines.push(`${prefix}${" ".repeat(col - start)}${dim(pad(text))} ${dim(pad(md))}${" ".repeat(Math.max(0, width - col - GROUP_WIDTH))}`);
  };
  for (const [row, line] of raw.entries()) {
    const marks = [...line.matchAll(MARKER)];
    const clean = marks.length ? line.replace(MARKER, "") : line;
    const block = marks.map(([, i]) => Number(i)).find(i => blocks[i] !== undefined);
    if (!show || width < GROUP_WIDTH + 1) { lines.push(clean); continue; }
    if (block !== undefined) addRow(clean, block);
    else if (row === last) { addRow(clean, blocks.length); continue; }
    else lines.push(clean);
    if (row === last && full !== undefined) addRow("", blocks.length);
  }
  return { lines, hits };
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
    const content = (args[0] as { content?: { type?: string; text?: string }[] } | undefined)?.content;
    if (!Array.isArray(content) || !Array.isArray(this.contentContainer?.children)) return;
    const text = content.filter(c => c.type === "text" && typeof c.text === "string" && c.text.trim()).map(c => c.text!);
    const children = this.contentContainer.children.filter((child): child is Markdown => child instanceof host.Markdown);
    for (const [i, child] of children.entries()) addButtons(child, host, state, text[i] ?? "", i === children.length - 1 ? text.join("\n\n") : undefined);
  };
}

export function registerCopyButtons(pi: Pick<ExtensionAPI, "on">, host: CopyButtonsHost, readConfig: (cwd: string) => Record<string, unknown>, copy: (text: string) => Promise<void>): void {
  pi.on("session_start", (_event, ctx) => {
    disableCopyButtons(host);
    if (process.env.PI_SUBAGENT_CHILD === "1" || ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      const config = readConfig(ctx.cwd);
      if (config["copyButtons.enabled"] === false) return;
      let tui: TUI | undefined;
      installCopyButtons(host, {
        isFullscreen: () => tui?.mode === "fullscreen",
        copy,
        iconStyle: config["ui.icons"] === "nerd" ? "nerd" : "text",
        requestRender: () => tui?.requestRender(),
        onError: error => ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
      });
      ctx.ui.setWidget("spider-copy-buttons", current => {
        tui = current;
        return { render: () => [], invalidate: () => {} };
      });
    } catch { disableCopyButtons(host); }
  });
  pi.on("session_shutdown", () => { disableCopyButtons(host); });
}

/** Disable a previous activation without undoing other extensions' prototype wrappers. */
export function disableCopyButtons(host: CopyButtonsHost): void {
  const proto = host.AssistantMessageComponent?.prototype as unknown as PatchedProto | undefined;
  if (proto?.[PATCH]) proto[PATCH].state.enabled = false;
}
