import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { bindHalfBox, bindToolCardShell, edgeInk, halfEdge, icon, isHalfEdge, isImageRow, joinToolCards, stripRow, type IconStyle } from "@spider/ui";
import type { InputBandHost } from "./index.js";
import { formatMessageTime } from "../message-time.js";
import { frameUserMessage, moveUserFrame, userFrameEnabled } from "../copy-buttons/index.js";

const PATCH = Symbol.for("spider.transcript.render");
const OSC_START = "\x1b]133;A\x07";
const OSC_END = "\x1b]133;B\x07\x1b]133;C\x07";
type Container = Component & { children: Component[] };
type Options = { inputBand: boolean; theme: () => Theme; iconStyle: () => IconStyle;
  live: { pending?: { text: string; timestamp: number } }; timestamp: (id: string) => number | undefined };
type Decorator = (this: Container, render: Component["render"], width: number, options: Options) => string[];
type Slot = { options?: Options; decorate: Decorator };
const USER_TIME = Symbol.for("spider.transcript.user-time");
const USER_MOUSE = Symbol.for("spider.transcript.user-hover-mouse");
type UserTimeSlot = { options?: Options; times: WeakMap<object, number>; frames?: WeakMap<object, { width: number; height: number; inset: number; innerWidth: number }>;
  mouse?: (component: Container, event: Parameters<NonNullable<Component["handleMouse"]>>[0], previous: Component["handleMouse"]) => ReturnType<NonNullable<Component["handleMouse"]>> };

function patch(prototype: Container | undefined, options: Options, decorate: Decorator): () => void {
  if (!prototype || typeof prototype.render !== "function") return () => {};
  const target = prototype as Container & { [PATCH]?: Slot };
  if (!Object.hasOwn(target, PATCH)) {
    const render = target.render;
    const slot: Slot = { options, decorate };
    Object.defineProperty(target, PATCH, { value: slot });
    target.render = function (this: Container, width) {
      return slot.options ? slot.decorate.call(this, render, width, slot.options) : render.call(this, width);
    };
  }
  const slot = target[PATCH]!;
  slot.options = options;
  slot.decorate = decorate;
  return () => { if (slot.options === options) slot.options = undefined; };
}

// The current host keeps these fields private in its declarations. Both the class
// and the painted padding rows have to match before we change any output.
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export function installTranscriptBands(host: InputBandHost, options: Options): () => void {
  const off: Array<() => void> = [];
  const padded = (component: unknown): component is Component => {
    const known = (host.Box && component instanceof host.Box) || (host.Text && component instanceof host.Text);
    return !!known && field(component, "paddingY") === 1 && typeof field(component, "paddingX") === "number";
  };
  const custom = host.CustomMessageComponent?.prototype;
  off.push(patch(custom, options, function (render, width) {
    const shell = field(this, "box");
    if (padded(shell) && this.children?.[1] === shell) bindHalfBox(shell, () => active(custom) && field(shell, "paddingY") === 1);
    return render.call(this, width);
  }));
  for (const prototype of [host.CompactionSummaryMessageComponent?.prototype, host.BranchSummaryMessageComponent?.prototype,
    host.SkillInvocationMessageComponent?.prototype]) {
    off.push(patch(prototype, options, function (render, width) {
      if (host.Box && this instanceof host.Box && padded(this) &&
        bindHalfBox(this, () => active(prototype) && padded(this))) return this.render(width);
      return render.call(this, width);
    }));
  }
  const tool = host.ToolExecutionComponent?.prototype;
  off.push(patch(tool, options, function (render, width) {
    bindToolCardShell(this, padded, () => active(tool));
    return render.call(this, width);
  }));
  // Pi's chat container owns the layout and its mouse hit map. Work on its
  // rendered children so hidden tools and self-rendered shells are handled in
  // the same way, without changing Pi's tool mouse handlers.
  const container = tool && Object.getPrototypeOf(tool) as Container | undefined;
  off.push(patch(container, options, function (render, width) {
    const rows = render.call(this, width);
    const Tool = host.ToolExecutionComponent;
    if (!Tool) return rows;
    const Assistant = host.AssistantMessageComponent;
    return joinToolCards(this, rows, width, child => child instanceof Tool, isHalfEdge, {
      Spacer: host.Spacer,
      // Only reset sequences are stripped: colors, underlines and images draw.
      isBlank: Assistant ? (child, part) => child instanceof Assistant &&
        part.every(row => /^[ \t]*$/u.test(row.replace(/\x1b\[(?:(?:0|22|23|24|27|29|39|49)(?:;|(?=m)))*m/gu, ""))) : undefined,
    });
  }));
  // Pi passes entry metadata on restore, but live components only receive text.
  // Its message_start event precedes the synchronous component construction.
  const user = host.UserMessageComponent?.prototype as (Container & { rebuild?: () => void; [USER_TIME]?: UserTimeSlot; [USER_MOUSE]?: boolean }) | undefined;
  if (user && typeof user.rebuild === "function") {
    if (!Object.hasOwn(user, USER_TIME)) {
      const rebuild = user.rebuild;
      const slot: UserTimeSlot = { times: new WeakMap(), frames: new WeakMap() };
      Object.defineProperty(user, USER_TIME, { value: slot });
      user.rebuild = function () {
        rebuild.call(this);
        const pending = slot.options?.live.pending;
        if (pending && field(this, "messageId") === undefined && field(this, "text") === pending.text) {
          slot.times.set(this, pending.timestamp);
          slot.options!.live.pending = undefined;
        }
      };
    }
    const slot = user[USER_TIME]!;
    slot.frames ??= new WeakMap();
    if (!Object.hasOwn(user, USER_MOUSE)) {
      const handleMouse = user.handleMouse;
      Object.defineProperty(user, USER_MOUSE, { value: true });
      user.handleMouse = function (event) {
        return slot.mouse ? slot.mouse(this, event, handleMouse) : handleMouse?.call(this, event);
      };
    }
    slot.options = options;
    slot.mouse = (component, event, previous) => {
      const layout = slot.frames?.get(component);
      if (!userFrameEnabled() || !layout || layout.width !== event.width || layout.height !== event.height) {
        return previous?.call(component, event);
      }
      if (event.type === "move") moveUserFrame(component);
      if (event.x < layout.inset || event.x >= layout.inset + layout.innerWidth || event.y < 1 || event.y >= event.height - 1) return undefined;
      return previous?.call(component, { ...event, x: event.x - layout.inset, y: event.y - 1, width: layout.innerWidth, height: event.height - 2 });
    };
    off.push(() => { if (slot.options === options) { slot.options = undefined; slot.mouse = undefined; } });
  }
  const sentCache = new WeakMap<Container, { rows: string[]; width: number; caret: string; output: string[] }>();
  const timeCache = new WeakMap<Container, { timestamp: number; offset: number; label: string }>();
  off.push(patch(host.UserMessageComponent?.prototype, options, function (render, width, opts) {
    user?.[USER_TIME]?.frames?.delete(this);
    const markdown = this.children?.[0];
    const padding = field(markdown, "paddingX");
    if (this.children?.length !== 1 || !host.Markdown || !(markdown instanceof host.Markdown)
      || field(markdown, "paddingY") !== 1 || typeof padding !== "number" || padding < 0) return render.call(this, width);
    const outerWidth = width;
    const stock = () => render.call(this, outerWidth);
    const band = opts.inputBand && padding >= 1;
    const framed = userFrameEnabled() && width >= (band ? 2 * padding + 6 : 3);
    if (!band && !framed) return stock();
    if (framed) width -= 2;
    const id = field(this, "messageId");
    const timestamp = typeof id === "string" ? opts.timestamp(id) : user?.[USER_TIME]?.times.get(this);
    const date = typeof timestamp === "number" ? new Date(timestamp) : undefined;
    let label = "";
    if (typeof timestamp === "number" && date && Number.isFinite(date.getTime())) {
      const offset = date.getTimezoneOffset();
      let cachedTime = timeCache.get(this);
      if (!cachedTime || cachedTime.timestamp !== timestamp || cachedTime.offset !== offset) {
        cachedTime = { timestamp, offset, label: formatMessageTime(date) };
        timeCache.set(this, cachedTime);
      }
      label = cachedTime.label;
    }
    if (!band) {
      const output = render.call(this, width);
      if (!output.length || output.some(isImageRow)) return stock();
      user?.[USER_TIME]?.frames?.set(this, { width: outerWidth, height: output.length + 2, inset: 1, innerWidth: width });
      return frameUserMessage(this, output, outerWidth, label);
    }
    if (width < 2 * padding + 4) return stock().map(row => isImageRow(row) ? row : truncateToWidth(row, outerWidth, ""));
    const inner = width - 2;
    const contentWidth = inner;
    // Pi's UserMessageComponent allocates an array for the OSC markers on every
    // render; the underlying Markdown returns a stable array until invalidated.
    const markdownRows = markdown.render(contentWidth);
    const caret = opts.theme().fg("accent", icon(opts.iconStyle(), "prompt"));
    const cached = sentCache.get(this);
    let output = cached?.rows === markdownRows && cached.width === width && cached.caret === caret ? cached.output : undefined;
    if (!output) {
      const rows = render.call(this, contentWidth);
      if (rows.length === 0) return rows;
      if (rows.length < 3 || !rows[0].startsWith(OSC_START) || !rows.at(-1)?.startsWith(OSC_END) || rows.some(isImageRow)) return stock();
      const top = rows[0].slice(OSC_START.length);
      const colors = edgeInk(top, contentWidth);
      if (!colors || rows.at(-1)?.slice(OSC_END.length) !== top) return stock();
      const text = rows.slice(1, -1);
      const first = text.findIndex(row => stripTerminalSequences(row).trim() !== "");
      output = [OSC_START + halfEdge(colors.ink, width, "top"),
        ...text.map((row, i) => stripRow(row, colors.bg, inner, i === first ? ` ${caret}` : "  ")),
        OSC_END + halfEdge(colors.ink, width, "bottom")];
      sentCache.set(this, { rows: markdownRows, width, caret, output });
    }
    if (!framed) return output;
    user?.[USER_TIME]?.frames?.set(this, { width: outerWidth, height: output.length + 2, inset: 3, innerWidth: contentWidth });
    return frameUserMessage(this, output, outerWidth, label);
  }));
  return () => { for (const dispose of off) dispose(); };
}

function active(prototype: Container | undefined): boolean {
  return !!(prototype as (Container & { [PATCH]?: Slot }) | undefined)?.[PATCH]?.options;
}
