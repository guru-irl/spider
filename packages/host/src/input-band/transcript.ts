import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { icon, type IconStyle } from "@spider/ui";
import { bindHalfBox, edgeInk, halfEdge, isImageRow, stripRow } from "./box.js";
import type { InputBandHost } from "./index.js";

const PATCH = Symbol.for("spider.transcript.render");
const OSC_START = "\x1b]133;A\x07";
const OSC_END = "\x1b]133;B\x07\x1b]133;C\x07";
type Container = Component & { children: Component[] };
type Options = { inputBand: boolean; theme: () => Theme; iconStyle: () => IconStyle };
type Decorator = (this: Container, render: Component["render"], width: number, options: Options) => string[];
type Slot = { options?: Options; decorate: Decorator };

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
  const sentCache = new WeakMap<Container, { rows: string[]; width: number; caret: string; output: string[] }>();
  off.push(patch(host.UserMessageComponent?.prototype, options, function (render, width, opts) {
    const markdown = this.children?.[0];
    const padding = field(markdown, "paddingX");
    if (!opts.inputBand || this.children?.length !== 1 || !host.Markdown || !(markdown instanceof host.Markdown)
      || field(markdown, "paddingY") !== 1 || typeof padding !== "number" || padding < 1) return render.call(this, width);
    const stock = () => render.call(this, width);
    if (width < 2 * padding + 4) return stock().map(row => isImageRow(row) ? row : truncateToWidth(row, width, ""));
    const inner = width - 2;
    // Pi's UserMessageComponent allocates an array for the OSC markers on every
    // render; the underlying Markdown returns a stable array until invalidated.
    const markdownRows = markdown.render(inner);
    const caret = opts.theme().fg("accent", icon(opts.iconStyle(), "prompt"));
    const cached = sentCache.get(this);
    if (cached?.rows === markdownRows && cached.width === width && cached.caret === caret) return cached.output;
    const rows = render.call(this, inner);
    if (rows.length === 0) return rows;
    if (rows.length < 3 || !rows[0].startsWith(OSC_START) || !rows.at(-1)?.startsWith(OSC_END) || rows.some(isImageRow)) return stock();
    const top = rows[0].slice(OSC_START.length);
    const colors = edgeInk(top, inner);
    if (!colors || rows.at(-1)?.slice(OSC_END.length) !== top) return stock();
    const text = rows.slice(1, -1);
    const first = text.findIndex(row => stripTerminalSequences(row).trim() !== "");
    const output = [OSC_START + halfEdge(colors.ink, width, "top"),
      ...text.map((row, i) => stripRow(row, colors.bg, inner, i === first ? ` ${caret}` : "  ")),
      OSC_END + halfEdge(colors.ink, width, "bottom")];
    sentCache.set(this, { rows: markdownRows, width, caret, output });
    return output;
  }));
  return () => { for (const dispose of off) dispose(); };
}

function active(prototype: Container | undefined): boolean {
  return !!(prototype as (Container & { [PATCH]?: Slot }) | undefined)?.[PATCH]?.options;
}
