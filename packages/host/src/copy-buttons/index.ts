/**
 * Adapted from pi-copy-button by Jonas Silva (MIT), commit fb8fb1f.
 * See NOTICE.md for attribution and licence. Pi exposes no assistant-render hook,
 * so this patches its assistant prototype and individual Markdown instances.
 */
import type { ToolExecutionComponent, AssistantMessageComponent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Spacer, type Component, type Markdown, type TUI, type TuiMouseEvent, type TuiMouseEventResult, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Lexer, type MarkedToken, type Token } from "marked";
import { icon, type IconStyle } from "@spider/ui";
import { blocksToPlain } from "./plain.js";

type Format = "text" | "md";
type Block = Record<Format, string>;
type Hit = { row: number; start: number; end: number; block: number; format: Format };
type Copied = { block: number; format: Format };
type Seam = { group: object; internalBefore?: Seam; internalAfter?: Seam; externalBefore?: Seam; externalAfter?: Seam };
const SEAM = Symbol.for("spider.copy-buttons.seam");
type SeamedMarkdown = Markdown & { [SEAM]?: Seam };
export type CopyButtonsHost = {
  AssistantMessageComponent: typeof AssistantMessageComponent;
  ToolExecutionComponent: typeof ToolExecutionComponent;
  Markdown: typeof Markdown;
  Spacer: typeof Spacer;
};
export type CopyButtonsOptions = {
  isFullscreen: () => boolean;
  copy: (text: string) => Promise<void>;
  requestRender: () => void;
  onError: (error: unknown) => void;
  iconStyle?: IconStyle;
  border?: (text: string) => string;
};
type State = { options: CopyButtonsOptions; enabled: boolean; preparing?: boolean; hovered?: object; trackingMove?: boolean; hoverSeen?: boolean; detach?: () => void };
type MarkdownInternals = {
  // Pi's Markdown stores horizontal padding as a private runtime field.
  paddingX?: unknown;
  renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
  render(width: number): string[];
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};
type AssistantInternals = {
  contentContainer?: { children?: Component[] };
  isStreaming?: boolean;
  updateContent(...args: unknown[]): void;
};
type Patch = { original: AssistantInternals["updateContent"]; state: State; implementation?: AssistantInternals["updateContent"] };
const PATCH = Symbol.for("spider.copy-buttons.updateContent");
type PatchedProto = AssistantInternals & { [PATCH]?: Patch };

// OSC markers survive pi's line wrapping and are removed before display.
const mark = (i: number) => `\x1b]7799;${i}\x07`;
const MARKER = /\x1b\]7799;(\d+)\x07/g;
const labels = (style?: IconStyle): Record<Format, string> => ({ text: `${icon(style, "copy")} text`, md: `${icon(style, "copy")} md` });
const FRAME = { left: "▏", right: "▕", top: "▔", bottom: "▁", topLeft: "🭽", topRight: "🭾", bottomLeft: "🭼", bottomRight: "🭿" } as const;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

function formatTime(date: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)} ${time}`;
}

function addButtons(md: Markdown, host: CopyButtonsHost, state: State, source: string, full: string | undefined, timestamp: number, messageGroup: object): void {
  const self = md as unknown as MarkdownInternals;
  const base = host.Markdown.prototype as unknown as MarkdownInternals;
  if (self.handleMouse || typeof base.renderToken !== "function" || typeof base.render !== "function") return;
  const seam: Seam = { group: messageGroup };
  (md as SeamedMarkdown)[SEAM] = seam;
  let depth = 0;
  let blocks: Block[] = [];
  let sectionStart: number | undefined;
  const originalTokens = Lexer.lex(source.trim());
  let sourceIndex = 0;
  let raw: string[] | undefined;
  let copied: Copied | undefined;
  let timeKey: string | undefined;
  let formattedTime = "";
  let renderedPadding: number | undefined;
  let out: { raw: string[]; copied: Copied | undefined; show: boolean; frame: boolean; omitTop: boolean; sharedTop: boolean; width: number; padding: number; time: string; iconStyle?: IconStyle; lines: string[]; hits: Hit[] } | undefined;

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
    // The frame replaces Markdown's side padding in both hover states.
    const frame = state.enabled && state.options.isFullscreen() && width >= 3;
    const paddingX = self.paddingX;
    const readablePadding = typeof paddingX === "number" && Number.isSafeInteger(paddingX) && paddingX >= 0 ? paddingX : undefined;
    const renderPadding = readablePadding === undefined ? undefined : frame ? 0 : readablePadding;
    if (renderPadding !== undefined && renderPadding !== renderedPadding) md.invalidate();
    renderedPadding = renderPadding;
    if (frame && readablePadding !== undefined) self.paddingX = 0;
    let next: string[];
    try { next = base.render.call(md, frame ? width - 2 : width); }
    finally { if (frame && readablePadding !== undefined) self.paddingX = paddingX; }
    sectionStart = undefined;
    if (next === raw) blocks = previous;
    raw = next;
    const show = frame && state.hovered === messageGroup;
    const omitTop = frame && !!(seam.internalBefore ?? seam.externalBefore);
    const after = seam.internalAfter ?? seam.externalAfter;
    const sharedTop = frame && !!after && after.group !== messageGroup && state.hovered === after.group;
    if (frame) {
      const date = new Date(timestamp);
      const today = new Date();
      const key = `${today.toDateString()}|${date.getTimezoneOffset()}`;
      if (key !== timeKey) {
        timeKey = key;
        formattedTime = formatTime(date);
      }
    }
    const time = frame ? formattedTime : "";
    const padding = renderPadding ?? 1;
    const iconStyle = state.options.iconStyle;
    if (!out || out.raw !== next || out.copied !== copied || out.show !== show || out.frame !== frame || out.omitTop !== omitTop || out.sharedTop !== sharedTop || out.width !== width || out.padding !== padding || out.time !== time || out.iconStyle !== iconStyle) {
      out = { raw: next, copied, show, frame, omitTop, sharedTop, width, padding, time, iconStyle, ...decorate(next, blocks, copied, width, padding, show, frame, omitTop, sharedTop, full, time, state.options.border ?? dim, iconStyle) };
    }
    return out.lines;
  };
  self.handleMouse = event => {
    if (!state.enabled || !state.options.isFullscreen()) return undefined;
    if (event.type === "move") {
      if (state.trackingMove) state.hoverSeen = true;
      // A shared seam belongs to the reply whose frame is currently visible.
      if (out?.sharedTop && event.y === out.lines.length - 1) return undefined;
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

function decorate(raw: string[], blocks: Block[], copied: Copied | undefined, width: number, padding: number, show: boolean, frame: boolean, omitTop: boolean, sharedTop: boolean, full: string | undefined, time: string, border: (text: string) => string, iconStyle?: IconStyle): { lines: string[]; hits: Hit[] } {
  const LABELS = labels(iconStyle);
  const textWidth = visibleWidth(LABELS.text);
  const mdWidth = visibleWidth(LABELS.md);
  const gap = "   ";
  const groupWidth = textWidth + gap.length + mdWidth;
  const lines: string[] = [];
  const hits: Hit[] = [];
  const innerWidth = frame ? width - 2 : width;
  const last = full === undefined ? -1 : raw.findLastIndex(line => stripTerminalSequences(line.replace(MARKER, "")).trim() !== "");
  let finalBlock: number | undefined;
  const actionRow = (block: number, bottom: boolean, preceding?: number) => {
    const fill = (count: number) => bottom ? border(FRAME.bottom.repeat(count)) : " ".repeat(count);
    if (!show) return " ".repeat(innerWidth);
    const bothFit = preceding !== undefined && groupWidth * 2 + gap.length <= innerWidth;
    const shown = bothFit ? [preceding, block] : [block];
    const totalWidth = groupWidth * shown.length + gap.length * (shown.length - 1);
    // For a final block, time is dropped before either action pair.
    const timeText = (preceding === undefined || bothFit) && totalWidth + 1 + visibleWidth(time) + padding * 2 <= innerWidth ? time : "";
    const inset = Math.min(padding, Math.floor((innerWidth - totalWidth) / 2));
    const start = innerWidth - inset - totalWidth;
    const groups = shown.map((item, index) => {
      const x = start + index * (groupWidth + gap.length);
      const mdStart = x + textWidth + gap.length;
      hits.push({ row: lines.length + (omitTop ? 0 : 1), start: x + 1, end: x + textWidth + 1, block: item, format: "text" });
      hits.push({ row: lines.length + (omitTop ? 0 : 1), start: mdStart + 1, end: mdStart + mdWidth + 1, block: item, format: "md" });
      const text = copied?.block === item && copied.format === "text" ? `${icon(iconStyle, "copied")} text` : LABELS.text;
      const md = copied?.block === item && copied.format === "md" ? `${icon(iconStyle, "copied")} md` : LABELS.md;
      return `${dim(text)}${fill(gap.length)}${dim(md)}`;
    });
    return `${fill(inset)}${dim(timeText)}${fill(start - inset - visibleWidth(timeText))}${groups.join(fill(gap.length))}${fill(inset)}`;
  };
  for (const [row, line] of raw.entries()) {
    const marks = [...line.matchAll(MARKER)];
    const clean = marks.length ? line.replace(MARKER, "") : line;
    const block = marks.map(([, i]) => Number(i)).find(i => blocks[i] !== undefined);
    lines.push(clean);
    if (!frame || innerWidth < groupWidth) continue;
    if (block !== undefined && row === last) finalBlock = block;
    else if (block !== undefined) lines.push(actionRow(block, false));
  }
  if (!frame || lines.length === 0) return { lines, hits };
  const edge = (text: string) => show ? border(text) : " ".repeat(visibleWidth(text));
  const bottom = sharedTop ? border(`${FRAME.topLeft}${FRAME.top.repeat(innerWidth)}${FRAME.topRight}`)
    : full !== undefined && last >= 0 && innerWidth >= groupWidth
      ? `${edge(FRAME.bottomLeft)}${actionRow(blocks.length, true, finalBlock)}${edge(FRAME.bottomRight)}`
      : edge(`${FRAME.bottomLeft}${FRAME.bottom.repeat(innerWidth)}${FRAME.bottomRight}`);
  return {
    lines: [...(omitTop ? [] : [edge(`${FRAME.topLeft}${FRAME.top.repeat(innerWidth)}${FRAME.topRight}`)]), ...lines.map(line => `${edge(FRAME.left)}${line}${edge(FRAME.right)}`), bottom],
    hits,
  };
}

function clearHover(state: State): void {
  if (!state.hovered) return;
  state.hovered = undefined;
  state.options.requestRender();
}

type SpacingPatch = { suppress: (width: number) => boolean; skipped: boolean };
const SPACING = Symbol.for("spider.copy-buttons.spacing");
type SpacedComponent = Component & { [SPACING]?: SpacingPatch };

// A following tool owns its leading spacer, and Pi inserts a sibling spacer
// before user messages. Suppress only the row already supplied by a reply.
function patchFollowingSpace(component: SpacedComponent, suppress: (width: number) => boolean): void {
  const existing = component[SPACING];
  if (existing) { existing.suppress = suppress; return; }
  const patch: SpacingPatch = { suppress, skipped: false };
  component[SPACING] = patch;
  const render = component.render;
  component.render = function (width) {
    const lines = render.call(this, width);
    patch.skipped = patch.suppress(width) && lines.length > 0 && stripTerminalSequences(lines[0]).trim() === "";
    return patch.skipped ? lines.slice(1) : lines;
  };
  const handleMouse = component.handleMouse;
  if (handleMouse) component.handleMouse = function (event) {
    return handleMouse.call(this, patch.skipped ? { ...event, y: event.y + 1, height: event.height + 1 } : event);
  };
}

function reconcileTranscriptSeams(tui: TUI, host: CopyButtonsHost, state: State): void {
  const root = tui as unknown as { children?: Component[] };
  const lists: Component[][] = [];
  const assistants: AssistantInternals[] = [];
  const seen = new Set<object>();
  const visit = (item: object) => {
    if (seen.has(item)) return;
    seen.add(item);
    if (item instanceof host.AssistantMessageComponent) assistants.push(item as unknown as AssistantInternals);
    const children = (item as { children?: Component[] }).children;
    if (!Array.isArray(children)) return;
    lists.push(children);
    children.forEach(visit);
  };
  visit(root);
  for (const assistant of assistants) {
    for (const child of assistant.contentContainer?.children ?? []) {
      const seam = (child as SeamedMarkdown)[SEAM];
      if (seam) { seam.externalBefore = undefined; seam.externalAfter = undefined; }
    }
  }
  const boundary = (component: Component | undefined, first: boolean): Seam | undefined => {
    if (!(component instanceof host.AssistantMessageComponent)) return undefined;
    const children = (component as unknown as AssistantInternals).contentContainer?.children ?? [];
    const child = first ? children.find(item => !(item instanceof host.Spacer)) : children.at(-1);
    return child && (child as SeamedMarkdown)[SEAM];
  };
  const previousBoundary = (children: Component[], index: number): Seam | undefined => {
    let previous = index - 1;
    while (previous >= 0 && children[previous] instanceof host.AssistantMessageComponent &&
      (children[previous] as unknown as AssistantInternals).contentContainer?.children?.length === 0) previous--;
    return boundary(children[previous], false);
  };
  for (const children of lists) {
    for (let i = 1; i < children.length; i++) {
      const previous = previousBoundary(children, i);
      if (!previous) continue;
      const current = children[i];
      const next = boundary(current, true);
      if (next) { previous.externalAfter = next; next.externalBefore = previous; }
      if (current instanceof host.Spacer || current instanceof host.ToolExecutionComponent) {
        patchFollowingSpace(current, width => {
          const index = children.indexOf(current);
          return state.enabled && state.options.isFullscreen() && width >= 3 && index > 0 && !!previousBoundary(children, index);
        });
      }
    }
  }
}

// Pi consumes fullscreen mouse input before extension listeners. Observe its
// viewport dispatch without consuming or changing the event.
function observeViewport(tui: TUI, host: CopyButtonsHost, state: State): () => void {
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
    if (state.enabled) reconcileTranscriptSeams(tui, host, state);
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

/** Install a stable wrapper; each reload replaces its implementation and state. */
export function installCopyButtons(host: CopyButtonsHost, options: CopyButtonsOptions): void {
  const proto = host.AssistantMessageComponent?.prototype as unknown as PatchedProto | undefined;
  const markdown = host.Markdown?.prototype as unknown as MarkdownInternals | undefined;
  if (!proto || typeof proto.updateContent !== "function" || !markdown || typeof markdown.renderToken !== "function" || typeof markdown.render !== "function") return;
  const previous = proto[PATCH];
  if (previous) disableCopyButtons(host);
  // The legacy wrapper may be captured by another extension. Leave the stack
  // intact and wrap it once, with the old wrapper's captured state disabled.
  const patch: Patch = previous?.implementation ? previous : { original: proto.updateContent, state: { options, enabled: true } };
  patch.state = { options, enabled: true };
  // Existing Markdown instances must follow the current state across reloads.
  const state = new Proxy({} as State, {
    get: (_target, key) => Reflect.get(patch.state, key),
    set: (_target, key, value) => Reflect.set(patch.state, key, value),
  });
  patch.implementation = function (this: AssistantInternals, ...args: unknown[]) {
    patch.original.apply(this, args);
    if ((!state.enabled && !state.preparing) || this.isStreaming) return;
    const message = args[0] as { content?: { type?: string; text?: string }[]; timestamp: number } | undefined;
    const content = message?.content;
    if (!Array.isArray(content) || !Array.isArray(this.contentContainer?.children)) return;
    const text = content.filter(c => c.type === "text" && typeof c.text === "string" && c.text.trim()).map(c => c.text!);
    const children = this.contentContainer.children.filter((child): child is Markdown => child instanceof host.Markdown);
    const messageGroup = {};
    for (const [i, child] of children.entries()) addButtons(child, host, state, text[i] ?? "", i === children.length - 1 ? text.join("\n\n") : undefined, message!.timestamp, messageGroup);
    // Pi reserves a spacer before a visible message and after thinking. The
    // frame's top row supplies that space when the next child is a reply.
    const all = this.contentContainer.children;
    for (let i = 0; i + 1 < all.length; i++) {
      const child = all[i];
      const current = (child as SeamedMarkdown)[SEAM];
      const next = (all[i + 1] as SeamedMarkdown)[SEAM];
      if (current && next) { current.internalAfter = next; next.internalBefore = current; }
      if (!(child instanceof host.Spacer) || !next) continue;
      const render = child.render;
      child.render = width => state.enabled && state.options.isFullscreen() && width >= 3 ? [] : render.call(child, width);
    }
  };
  if (!previous?.implementation) {
    proto[PATCH] = patch;
    proto.updateContent = function (this: AssistantInternals, ...args: unknown[]) {
      proto[PATCH]!.implementation!.apply(this, args);
    };
  }
}

export function registerCopyButtons(pi: Pick<ExtensionAPI, "on">, host: CopyButtonsHost, readConfig: (cwd: string) => Record<string, unknown>, copy: (text: string) => Promise<void>): void {
  const proto = host.AssistantMessageComponent?.prototype as unknown as PatchedProto | undefined;
  // Pi rebuilds the transcript after extension load but before session_start.
  installCopyButtons(host, { isFullscreen: () => false, copy, requestRender: () => {}, onError: () => {} });
  const state = proto?.[PATCH]?.state;
  if (state) { state.enabled = false; state.preparing = true; }
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
        border: text => ctx.ui.theme?.fg("borderMuted", text) ?? dim(text),
        onError: error => ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
      });
      ctx.ui.setWidget("spider-copy-buttons", current => {
        tui = current;
        const state = (host.AssistantMessageComponent.prototype as unknown as PatchedProto)[PATCH]?.state;
        if (state) state.detach?.();
        const detach = state && observeViewport(current, host, state);
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
    state.preparing = false;
    state.hovered = undefined;
    state.detach?.();
    state.detach = undefined;
  }
}
