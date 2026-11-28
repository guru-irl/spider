/**
 * Adapted from pi-copy-button by Jonas Silva (MIT), commit fb8fb1f.
 * See NOTICE.md for attribution and licence. Pi exposes no assistant-render hook,
 * so this patches its assistant prototype and individual Markdown instances.
 */
import type { ToolExecutionComponent, AssistantMessageComponent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Spacer, type Component, type Markdown, type TUI, type TuiMouseEvent, type TuiMouseEventResult, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Token } from "marked";
import { icon, type IconStyle } from "@spider/ui";
import { layoutBlocks, markBlockEnd, replyTarget, sourceBoundaries, stripBlockMarkers, type BlockLayout, type CopyTarget } from "./block-layout.js";

type Format = "text" | "md";
type Hit = { row: number; start: number; end: number; target: CopyTarget; format: Format };
type Copied = { target: CopyTarget; format: Format };
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
type State = { activation: object; options: CopyButtonsOptions; enabled: boolean; preparing?: boolean; hovered?: object; trackingMove?: boolean; hoverSeen?: boolean; detach?: () => void };
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
type Patch = {
  original: AssistantInternals["updateContent"];
  state: State;
  implementation?: AssistantInternals["updateContent"];
  markdown?: typeof markdownHandlers;
  groups?: WeakMap<AssistantInternals, object>;
};
const PATCH = Symbol.for("spider.copy-buttons.updateContent");
type PatchedProto = AssistantInternals & { [PATCH]?: Patch };

// Copy labels share the Nerd icon's pad cell with the separator so hit columns stay fixed.
const COPY_BUTTON_SEPARATOR = " ";
const labels = (style?: IconStyle): Record<Format, string> => ({ text: `${icon(style, "copy").trimEnd()}${COPY_BUTTON_SEPARATOR}text`, md: `${icon(style, "copy").trimEnd()}${COPY_BUTTON_SEPARATOR}md` });
const FRAME = { left: "▏", right: "▕", top: "▔", bottom: "▁", topLeft: "🭽", topRight: "🭾", bottomLeft: "🭼", bottomRight: "🭿" } as const;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

function formatTime(date: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)} ${time}`;
}

type BindingContent = { source: string; full: string | undefined; timestamp: number };
type Drawing = {
  activation: object; layout: BlockLayout; copied?: Copied; show: boolean; omitTop: boolean; sharedTop: boolean;
  width: number; padding: number; time: string; iconStyle?: IconStyle; border: (text: string) => string;
  lines: string[]; hits: Hit[];
};
type MarkdownBinding = {
  md: Markdown;
  baseRender: MarkdownInternals["render"];
  seam: Seam;
  content?: BindingContent;
  renderedPadding?: number;
  targets?: { activation: object; blocks: ReturnType<typeof sourceBoundaries>; reply?: CopyTarget };
  layout?: { raw: string[]; value: BlockLayout };
  unframed?: { raw: string[]; lines: string[] };
  copied?: Copied;
  time?: { key: string; label: string };
  out?: Drawing;
};
const BINDING = Symbol.for("spider.copy-buttons.binding");
type BoundMarkdown = Markdown & { [BINDING]?: MarkdownBinding; [SEAM]?: Seam };

function bindMarkdown(md: BoundMarkdown, patch: Patch, group: object, content: BindingContent | undefined): void {
  let binding = md[BINDING];
  if (!binding) {
    const self = md as unknown as MarkdownInternals;
    if (self.handleMouse) return;
    const slot: MarkdownBinding = { md, baseRender: self.render, seam: { group } };
    md[BINDING] = binding = slot;
    const renderToken = self.renderToken;
    let depth = 0;
    self.renderToken = (token, width, nextTokenType, styleContext) => {
      const top = depth++ === 0;
      try {
        const lines = renderToken.call(md, token, width, nextTokenType, styleContext);
        return top ? markBlockEnd(token, lines) : lines;
      } finally { depth--; }
    };
    self.render = width => patch.markdown!.render(slot, patch.state, width);
    self.handleMouse = event => patch.markdown!.handleMouse(slot, patch.state, event);
    // A reused slot may already contain unmarked lines from before attachment.
    md.invalidate();
  }
  if (binding.content?.source !== content?.source || binding.content?.full !== content?.full || binding.content?.timestamp !== content?.timestamp) {
    binding.content = content;
    binding.targets = binding.layout = binding.out = binding.copied = binding.time = undefined;
  }
  binding.seam.group = group;
  binding.seam.internalBefore = binding.seam.internalAfter = binding.seam.externalBefore = binding.seam.externalAfter = undefined;
  md[SEAM] = content ? binding.seam : undefined;
}

function renderMarkdown(slot: MarkdownBinding, state: State, width: number): string[] {
  const { md, seam, content } = slot;
  const self = md as unknown as MarkdownInternals;
  const frame = !!content && state.enabled && state.options.isFullscreen() && width >= 3;
  const paddingX = self.paddingX;
  const readablePadding = typeof paddingX === "number" && Number.isSafeInteger(paddingX) && paddingX >= 0 ? paddingX : undefined;
  const renderPadding = frame && readablePadding !== undefined ? 0 : readablePadding;
  // Invalidate only when the padding mode changes, not on updates or hover.
  if (slot.renderedPadding !== undefined && renderPadding !== slot.renderedPadding) md.invalidate();
  slot.renderedPadding = renderPadding;
  if (frame && readablePadding !== undefined) self.paddingX = 0;
  let raw: string[];
  try { raw = slot.baseRender.call(md, frame ? width - 2 : width); }
  finally { if (frame && readablePadding !== undefined) self.paddingX = paddingX; }

  if (!frame) {
    slot.out = slot.layout = undefined;
    if (slot.unframed?.raw !== raw) slot.unframed = { raw, lines: raw.map(stripBlockMarkers) };
    return slot.unframed.lines;
  }
  slot.unframed = undefined;
  const { activation } = state;
  if (slot.targets?.activation !== activation) {
    slot.targets = {
      activation,
      blocks: sourceBoundaries(content.source),
      reply: content.full === undefined ? undefined : replyTarget(content.full),
    };
    slot.layout = slot.copied = undefined;
  }
  if (slot.layout?.raw !== raw) slot.layout = { raw, value: layoutBlocks(raw, slot.targets.blocks) };
  const layout = slot.layout.value;
  const show = state.hovered === seam.group;
  const omitTop = !!(seam.internalBefore ?? seam.externalBefore);
  const after = seam.internalAfter ?? seam.externalAfter;
  const sharedTop = !!after && after.group !== seam.group && state.hovered === after.group;
  const date = new Date(content.timestamp);
  const key = `${new Date().toDateString()}|${date.getTimezoneOffset()}`;
  if (key !== slot.time?.key) slot.time = { key, label: formatTime(date) };
  const time = slot.time.label;
  const padding = renderPadding ?? 1;
  const { iconStyle, border = dim } = state.options;
  const { copied, out } = slot;
  if (out && out.activation === activation && out.layout === layout && out.copied === copied && out.show === show && out.omitTop === omitTop && out.sharedTop === sharedTop && out.width === width && out.padding === padding && out.time === time && out.iconStyle === iconStyle && out.border === border) return out.lines;
  slot.out = { activation, layout, copied, show, omitTop, sharedTop, width, padding, time, iconStyle, border,
    ...decorate(layout, copied, width, padding, show, omitTop, sharedTop, slot.targets.reply, time, border, iconStyle) };
  return slot.out.lines;
}

function handleMarkdownMouse(slot: MarkdownBinding, state: State, event: TuiMouseEvent): TuiMouseEventResult | undefined {
  const { content, seam, out } = slot;
  if (!content || !state.enabled || !state.options.isFullscreen()) return undefined;
  if (event.type === "move") {
    if (state.trackingMove) state.hoverSeen = true;
    // A shared seam belongs to the reply whose frame is currently visible.
    if (out?.sharedTop && event.y === out.lines.length - 1) return undefined;
    if (state.hovered !== seam.group) {
      state.hovered = seam.group;
      state.options.requestRender();
    }
    return undefined;
  }
  if (event.type !== "click" || event.button !== "left" || state.hovered !== seam.group || out?.activation !== state.activation) return undefined;
  const hit = out.hits.find(h => h.row === event.y && event.x >= h.start && event.x < h.end);
  if (!hit) return undefined;
  const { target, format } = hit;
  const done: Copied = { target, format };
  try {
    void state.options.copy(format === "md" ? target.md : target.text()).then(() => {
      if (!state.enabled || slot.content !== content) return;
      slot.copied = done;
      state.options.requestRender();
      setTimeout(() => {
        if (slot.copied === done) {
          slot.copied = undefined;
          state.options.requestRender();
        }
      }, 1500);
    }, error => state.options.onError(error));
  } catch (error) { state.options.onError(error); }
  return { handled: true };
}

const markdownHandlers = { render: renderMarkdown, handleMouse: handleMarkdownMouse };

function decorate(layout: BlockLayout, copied: Copied | undefined, width: number, padding: number, show: boolean, omitTop: boolean, sharedTop: boolean, reply: CopyTarget | undefined, time: string, border: (text: string) => string, iconStyle?: IconStyle): { lines: string[]; hits: Hit[] } {
  const LABELS = labels(iconStyle);
  const textWidth = visibleWidth(LABELS.text);
  const mdWidth = visibleWidth(LABELS.md);
  const gap = "   ";
  const groupWidth = textWidth + gap.length + mdWidth;
  const lines: string[] = [];
  const hits: Hit[] = [];
  const innerWidth = width - 2;
  const last = reply ? layout.lastContentRow : -1;
  let finalBlock: CopyTarget | undefined;
  const actionRow = (target: CopyTarget, bottom: boolean, preceding?: CopyTarget) => {
    const fill = (count: number) => bottom ? border(FRAME.bottom.repeat(count)) : " ".repeat(count);
    if (!show) return " ".repeat(innerWidth);
    const bothFit = preceding !== undefined && groupWidth * 2 + gap.length <= innerWidth;
    const shown = bothFit ? [preceding, target] : [target];
    const totalWidth = groupWidth * shown.length + gap.length * (shown.length - 1);
    // For a final block, time is dropped before either action pair.
    const timeText = (preceding === undefined || bothFit) && totalWidth + 1 + visibleWidth(time) + padding * 2 <= innerWidth ? time : "";
    const inset = Math.min(padding, Math.floor((innerWidth - totalWidth) / 2));
    const start = innerWidth - inset - totalWidth;
    const groups = shown.map((item, index) => {
      const x = start + index * (groupWidth + gap.length);
      const mdStart = x + textWidth + gap.length;
      hits.push({ row: lines.length + (omitTop ? 0 : 1), start: x + 1, end: x + textWidth + 1, target: item, format: "text" });
      hits.push({ row: lines.length + (omitTop ? 0 : 1), start: mdStart + 1, end: mdStart + mdWidth + 1, target: item, format: "md" });
      const text = copied?.target === item && copied.format === "text" ? `${icon(iconStyle, "copied").trimEnd()}${COPY_BUTTON_SEPARATOR}text` : LABELS.text;
      const md = copied?.target === item && copied.format === "md" ? `${icon(iconStyle, "copied").trimEnd()}${COPY_BUTTON_SEPARATOR}md` : LABELS.md;
      return `${dim(text)}${fill(gap.length)}${dim(md)}`;
    });
    return `${fill(inset)}${dim(timeText)}${fill(start - inset - visibleWidth(timeText))}${groups.join(fill(gap.length))}${fill(inset)}`;
  };
  for (const [row, line] of layout.lines.entries()) {
    const block = layout.blocks.get(row);
    lines.push(line);
    if (innerWidth < groupWidth) continue;
    if (block !== undefined && row === last) finalBlock = block;
    else if (block !== undefined) lines.push(actionRow(block, false));
  }
  if (lines.length === 0) return { lines, hits };
  const edge = (text: string) => show ? border(text) : " ".repeat(visibleWidth(text));
  const bottom = sharedTop ? border(`${FRAME.topLeft}${FRAME.top.repeat(innerWidth)}${FRAME.topRight}`)
    : reply && last >= 0 && innerWidth >= groupWidth
      ? `${edge(FRAME.bottomLeft)}${actionRow(reply, true, finalBlock)}${edge(FRAME.bottomRight)}`
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
    if (!component) return undefined;
    const direct = (component as SeamedMarkdown)[SEAM];
    if (direct) return direct;
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
      const leading = current instanceof host.AssistantMessageComponent && !next
        ? (current as unknown as AssistantInternals).contentContainer?.children?.[0]
        : undefined;
      const spaced = current instanceof host.Spacer || current instanceof host.ToolExecutionComponent
        ? current : leading instanceof host.Spacer ? leading : undefined;
      if (spaced) {
        patchFollowingSpace(spaced, width => {
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
  // Shims linked before these host classes were added omit them.
  if (typeof host.Spacer !== "function" || typeof host.ToolExecutionComponent !== "function") return;
  const previous = proto[PATCH];
  if (previous) disableCopyButtons(host);
  // The legacy wrapper may be captured by another extension. Leave the stack
  // intact and wrap it once, with the old wrapper's captured state disabled.
  const state: State = { activation: {}, options, enabled: true };
  const patch: Patch = previous?.implementation ? previous : { original: proto.updateContent, state };
  patch.state = state;
  patch.markdown = markdownHandlers;
  const groups = patch.groups ??= new WeakMap();
  patch.implementation = function (this: AssistantInternals, ...args: unknown[]) {
    patch.original.apply(this, args);
    const attach = patch.state.enabled || patch.state.preparing;
    const message = args[0] as { content?: { type?: string; text?: string }[]; timestamp: number } | undefined;
    const content = message?.content;
    if (!Array.isArray(content) || !Array.isArray(this.contentContainer?.children)) return;
    const text = content.filter(c => c.type === "text" && typeof c.text === "string" && c.text.trim()).map(c => c.text!);
    const children = this.contentContainer.children.filter((child): child is BoundMarkdown => child instanceof host.Markdown);
    if (!attach && !children.some(child => child[BINDING])) return;
    let group = groups.get(this);
    if (!group) { group = {}; groups.set(this, group); }
    for (const [i, child] of children.entries()) {
      if (!attach && !child[BINDING]) continue;
      bindMarkdown(child, patch, group, this.isStreaming ? undefined : {
        source: text[i] ?? "", full: i === children.length - 1 ? text.join("\n\n") : undefined, timestamp: message!.timestamp,
      });
    }
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
      child.render = width => patch.state.enabled && patch.state.options.isFullscreen() && width >= 3 ? [] : render.call(child, width);
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
