import type { Theme } from "@earendil-works/pi-coding-agent";
import { Spacer, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { icon, type IconStyle } from "@spider/ui";
import { bindHalfBox, edgeInk, halfEdge, isImageRow, stripRow } from "./box.js";
import type { InputBandHost } from "./index.js";
import { formatMessageTime } from "../message-time.js";

const PATCH = Symbol.for("spider.transcript.render");
const OSC_START = "\x1b]133;A\x07";
const OSC_END = "\x1b]133;B\x07\x1b]133;C\x07";
type Container = Component & { children: Component[] };
type Options = { inputBand: boolean; theme: () => Theme; iconStyle: () => IconStyle;
  live: { pending?: { text: string; timestamp: number } }; timestamp: (id: string) => number | undefined };
type Decorator = (this: Container, render: Component["render"], width: number, options: Options) => string[];
type Slot = { options?: Options; decorate: Decorator };
const USER_TIME = Symbol.for("spider.transcript.user-time");
type UserTimeSlot = { options?: Options; times: WeakMap<object, number> };

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
    const box = field(this, "contentBox");
    const text = field(this, "contentText");
    const child = this.children?.[1];
    let shell: unknown;
    if (child === box) shell = box;
    else if (child === field(this, "contentTextRegion") && field(child, "child") === text) shell = text;
    else if (field(this, "toolName") === "edit" && field(field(this, "toolDefinition"), "renderShell") === "self"
      && child === field(this, "selfRenderContainer")) {
      // Native edit owns its shell; only its known, padded header Box is changed.
      const call = field(this, "callRendererComponent");
      const shellChildren = field(child, "children");
      if (Array.isArray(shellChildren) && shellChildren.some(region => field(region, "child") === call)) shell = call;
    }
    if (padded(shell)) bindHalfBox(shell, () => active(tool) && field(shell, "paddingY") === 1);
    return render.call(this, width);
  }));
  // Pi's chat container owns the layout and its mouse hit map. Work on its
  // rendered children so hidden tools and self-rendered shells are handled in
  // the same way, without changing Pi's tool mouse handlers.
  const container = tool && Object.getPrototypeOf(tool) as Container | undefined;
  off.push(patch(container, options, function (render, width) {
    const rows = render.call(this, width);
    if (!host.ToolExecutionComponent || width < 1 || !this.children?.some(child => child instanceof host.ToolExecutionComponent!)) return rows;
    const layout = field(this, "mouseLayout") as { width?: number; children?: { component: Component; height: number }[] } | undefined;
    const entries = layout?.children;
    if (layout?.width !== width || !Array.isArray(entries) || entries.length !== this.children.length ||
      entries.some((entry, i) => entry.component !== this.children[i] || !Number.isInteger(entry.height) || entry.height < 0) ||
      entries.reduce((sum, entry) => sum + entry.height, 0) !== rows.length) return rows;
    const output: string[] = [];
    const mouseChildren: { component: Component; height: number }[] = [];
    let offset = 0;
    let previousTool = false;
    for (const entry of entries) {
      const part = rows.slice(offset, offset + entry.height);
      offset += entry.height;
      const isTool = entry.component instanceof host.ToolExecutionComponent;
      const leading = isTool ? (entry.component as Container).children?.[0] : undefined;
      const join = previousTool && isTool && leading instanceof Spacer && field(leading, "lines") === 1 && part.length > 1 && part[0] === "" &&
        stripTerminalSequences(part[1]) === "▄".repeat(width);
      const component = entry.component;
      if (join) {
        output.push(...part.slice(1));
        // Forward the same click to Pi at its original local coordinates.
        const mouse: Component = {
          render: w => component.render(w).slice(1),
          invalidate: () => component.invalidate?.(),
          handleMouse: event => component.handleMouse?.({ ...event, y: event.y + 1, height: event.height + 1 }),
        };
        mouseChildren.push({ component: mouse, height: entry.height - 1 });
      } else {
        output.push(...part);
        mouseChildren.push(entry);
      }
      if (part.length) previousTool = isTool && stripTerminalSequences(part.at(-1)!) === "▀".repeat(width);
    }
    layout.children = mouseChildren;
    return output;
  }));
  // Pi passes entry metadata on restore, but live components only receive text.
  // Its message_start event precedes the synchronous component construction.
  const user = host.UserMessageComponent?.prototype as (Container & { rebuild?: () => void; [USER_TIME]?: UserTimeSlot }) | undefined;
  if (user && typeof user.rebuild === "function") {
    if (!Object.hasOwn(user, USER_TIME)) {
      const rebuild = user.rebuild;
      const slot: UserTimeSlot = { times: new WeakMap() };
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
    slot.options = options;
    off.push(() => { if (slot.options === options) slot.options = undefined; });
  }
  const sentCache = new WeakMap<Container, { rows: string[]; width: number; caret: string; time: string; output: string[] }>();
  const timeCache = new WeakMap<Container, { timestamp: number; offset: number; label: string }>();
  off.push(patch(host.UserMessageComponent?.prototype, options, function (render, width, opts) {
    const markdown = this.children?.[0];
    const padding = field(markdown, "paddingX");
    if (!opts.inputBand || this.children?.length !== 1 || !host.Markdown || !(markdown instanceof host.Markdown)
      || field(markdown, "paddingY") !== 1 || typeof padding !== "number" || padding < 1) return render.call(this, width);
    const stock = () => render.call(this, width);
    if (width < 2 * padding + 4) return stock().map(row => isImageRow(row) ? row : truncateToWidth(row, width, ""));
    const inner = width - 2;
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
    // Reserve room on every Markdown row, so Pi does the wrapping and keeps
    // Markdown styles intact. Omit the label only when the terminal is tiny.
    const reserved = visibleWidth(label) + 1;
    const time = label && inner - reserved >= 2 * padding + 4 ? label : "";
    const contentWidth = time ? inner - reserved : inner;
    // Pi's UserMessageComponent allocates an array for the OSC markers on every
    // render; the underlying Markdown returns a stable array until invalidated.
    const markdownRows = markdown.render(contentWidth);
    const caret = opts.theme().fg("accent", icon(opts.iconStyle(), "prompt"));
    const cached = sentCache.get(this);
    if (cached?.rows === markdownRows && cached.width === width && cached.caret === caret && cached.time === time) return cached.output;
    const rows = render.call(this, contentWidth);
    if (rows.length === 0) return rows;
    if (rows.length < 3 || !rows[0].startsWith(OSC_START) || !rows.at(-1)?.startsWith(OSC_END) || rows.some(isImageRow)) return stock();
    const top = rows[0].slice(OSC_START.length);
    const colors = edgeInk(top, contentWidth);
    if (!colors || rows.at(-1)?.slice(OSC_END.length) !== top) return stock();
    const text = rows.slice(1, -1);
    const first = text.findIndex(row => stripTerminalSequences(row).trim() !== "");
    const output = [OSC_START + halfEdge(colors.ink, width, "top"),
      ...text.map((row, i) => {
        const painted = stripRow(row, colors.bg, inner, i === first ? ` ${caret}` : "  ");
        if (i !== first || !time) return painted;
        const start = width - visibleWidth(time) - 1;
        return truncateToWidth(painted, start, "", true) + colors.bg + `\x1b[2m${time}\x1b[22m \x1b[49m`;
      }),
      OSC_END + halfEdge(colors.ink, width, "bottom")];
    sentCache.set(this, { rows: markdownRows, width, caret, time, output });
    return output;
  }));
  return () => { for (const dispose of off) dispose(); };
}

function active(prototype: Container | undefined): boolean {
  return !!(prototype as (Container & { [PATCH]?: Slot }) | undefined)?.[PATCH]?.options;
}
