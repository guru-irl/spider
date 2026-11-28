import { estimateTokens, type Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type Container, type MarkdownOptions, type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { ACTIVITY_FRAMES, icon, type IconStyle } from "@spider/ui";
import { bindHalfBox } from "./box.js";
import type { InputBandHost } from "./index.js";

type CardConstructor = NonNullable<InputBandHost["CompactionSummaryMessageComponent"]>;
type Card = InstanceType<CardConstructor>;
type Message = ConstructorParameters<CardConstructor>[0];
type Options = { theme: () => Theme; iconStyle: () => IconStyle; model: (id: string | undefined, message: Message) => string | undefined };
type Bill = { tokens: string; cost?: string };
type Receipt = { before: number; summary: number; expanded: boolean; model?: string; key?: string; bill?: Bill };
const PATCH = Symbol.for("spider.transcript.compaction-card");
type Surface = Pick<Container, "children">;
type Mode = { chatContainer?: Surface; addCompactionCostNotice: (notice: unknown) => void };
type Layout = { owner: Options; container: Surface; stock: Component[]; styled: Component[] };
type State = { layout?: Layout; key?: string; bill?: Bill };
type Slot = { options?: Options };

function fields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function tokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}

function moon(style: IconStyle): string {
  return ACTIVITY_FRAMES[style].working[style === "nerd" ? 3 : 0];
}

function renderReceipt({ before, summary, model, key, expanded, bill }: Receipt, width: number, theme: Theme, style: IconStyle): string[] {
  const mark = moon(style);
  const indent = " ".repeat(visibleWidth(mark) + 1);
  const dim = (text: string) => theme.fg("dim", text);
  const title = theme.fg("accent", mark) + " " + theme.bold(theme.fg("customMessageText", "compaction"));
  const hint = key ? `${key} ${expanded ? "collapse" : "expand"}` : "";
  const name = model ? dim(` · ${model}`) : "";
  const left = title + name;
  const gap = width - visibleWidth(left) - visibleWidth(hint);
  const header = hint && gap >= 2 ? left + " ".repeat(gap) + dim(hint) : left;
  const number = theme.fg("customMessageText", tokenCount(before));
  const from = indent + number + dim(" tokens before");
  const to = theme.fg("accent", `~${tokenCount(summary)}`) + dim(" in summary");
  const fold = `${from}  ${theme.fg("accent", icon(style, "arrowRight"))}  ${to}`;
  const beforeRow = visibleWidth(from) <= width ? from : indent + number + dim(" before");
  const rows = [header, ...(visibleWidth(fold) <= width ? [fold] : [beforeRow, indent + to])];
  if (bill) {
    const line = indent + dim(bill.tokens + (bill.cost ? ` · ${bill.cost}` : ""));
    if (bill.cost && visibleWidth(line) > width) rows.push(indent + dim(bill.tokens), indent + dim(bill.cost));
    else rows.push(line);
  }
  return rows.map(row => truncateToWidth(row, width));
}

function restore(layout: Layout | undefined): void {
  if (layout && layout.container.children === layout.styled) layout.container.children = layout.stock;
}

// Keep Pi's Box and MouseRegion. Only exchange the region's content, so Pi still
// handles click dispatch, global expansion, output padding, and invalidation.
export function installCompactionCard(host: InputBandHost, options: Options): () => void {
  const { CompactionSummaryMessageComponent: SummaryCard, Box, Markdown, Spacer, Text } = host;
  const mode = host.InteractiveMode?.prototype as unknown as Mode | undefined;
  if (!SummaryCard || !mode || typeof mode.addCompactionCostNotice !== "function" || !Box || !Markdown || !Spacer || !Text) return () => {};
  const prototype = SummaryCard.prototype as Card & { [PATCH]?: Slot };
  if (!Object.hasOwn(prototype, PATCH)) {
    const prepare = (card: Card, container: Surface, state: State, opts: Options): Layout | undefined => {
      const box = fields(card);
      const message = fields(box?.message);
      const [label, blank, body] = container.children;
      if (!(card instanceof Box) || box?.paddingY !== 1 || typeof box.paddingX !== "number" || typeof box.expanded !== "boolean" ||
          message?.role !== "compactionSummary" || typeof message.summary !== "string" ||
          typeof message.tokensBefore !== "number" || !Number.isFinite(message.tokensBefore) || message.tokensBefore < 0 ||
          container.children.length !== 3 || !(label instanceof Text) || !(blank instanceof Spacer) || fields(blank)?.lines !== 1 ||
          stripTerminalSequences(label.render(32).join("")).trim() !== "[compaction]") return undefined;

      const { expanded } = box;
      const current = box.message as Message;
      let markdown: Component | undefined;
      if (expanded) {
        if (!(body instanceof Markdown)) return undefined;
        const native = fields(body) as { theme?: MarkdownTheme; options?: MarkdownOptions } | undefined;
        const transform = native?.options?.transform;
        if (!native?.theme || typeof transform !== "function") return undefined;
        const prefix = `**Compacted from ${current.tokensBefore.toLocaleString()} tokens**\n\n`;
        const indent = visibleWidth(moon(opts.iconStyle())) + 1;
        // Pi's transform runs extensions on the source, then adds a stock
        // heading. Remove just that heading, since the receipt has it.
        markdown = new Markdown(current.summary, indent, 0, native.theme, { color: text => opts.theme().fg("customMessageText", text) }, {
          ...native.options,
          transform: (source, cols) => {
            const text = transform(source, cols);
            return text.startsWith(prefix) ? text.slice(prefix.length) : text;
          },
        });
      } else {
        if (!(body instanceof Text)) return undefined;
        state.key = /\(([^()]*) to expand\)$/u.exec(stripTerminalSequences(body.render(240).join("")).trim())?.[1];
      }
      const receipt = { before: current.tokensBefore, summary: estimateTokens(current), expanded, key: state.key,
        model: opts.model(typeof box.messageId === "string" ? box.messageId : undefined, current) };
      const header: Component = { render: cols => renderReceipt({ ...receipt, bill: state.bill }, cols, opts.theme(), opts.iconStyle()), invalidate() {} };
      return { owner: opts, container, stock: container.children, styled: markdown ? [header, blank, markdown] : [header] };
    };

    const slot: Slot = {};
    const states = new WeakMap<Card, State>();
    const nativeRender = prototype.render;
    const nativeNotice = mode.addCompactionCostNotice;
    Object.defineProperty(prototype, PATCH, { value: slot });

    prototype.render = function (width) {
      const opts = slot.options;
      const state = states.get(this) ?? {};
      const region = this.children?.length === 1 ? fields(this.children[0]) : undefined;
      const child = typeof region?.onMouse === "function" ? fields(region.child) : undefined;
      const container = Array.isArray(child?.children) && typeof child?.render === "function" ? child as unknown as Surface : undefined;
      if (!opts || !container || state.layout?.container !== container || state.layout.owner !== opts ||
          (container.children !== state.layout.styled && container.children !== state.layout.stock)) {
        restore(state.layout);
        state.layout = undefined;
      }
      if (opts && container && !state.layout) state.layout = prepare(this, container, state, opts);
      if (state.layout) {
        states.set(this, state);
        state.layout.container.children = state.layout.styled;
        if (bindHalfBox(this, () => !!slot.options && states.get(this)?.layout?.owner === slot.options)) return this.render(width);
      }
      return nativeRender.call(this, width);
    };

    mode.addCompactionCostNotice = function (notice) {
      const children = this.chatContainer?.children;
      const tail = children?.length;
      const card = children?.at(-1);
      nativeNotice.call(this, notice);
      // Let Pi decide if a notice exists, and use its formatted billing numbers.
      // Keep both native components so an unrecognized card never hides a bill.
      const candidate = fields(notice);
      if (!slot.options || candidate?.type !== "compaction_cost" || candidate.kind !== "compaction" || !(card instanceof SummaryCard) ||
          !children || tail === undefined || children !== this.chatContainer?.children || children.length !== tail + 2) return;
      const [spacer, label] = children.slice(tail);
      if (!(spacer instanceof Spacer) || fields(spacer)?.lines !== 1 || !(label instanceof Text)) return;
      const match = /^(?:Compaction: )([\d.,]+[kM]? tokens billed)(?: \((~\$[\d.]+)\))?$/u
        .exec(stripTerminalSequences(label.render(120).join("")).trim());
      if (!match) return;
      const state = states.get(card) ?? {};
      state.bill = { tokens: match[1], cost: match[2] };
      states.set(card, state);
      for (const component of [spacer, label]) {
        const render = component.render;
        component.render = width => slot.options && state.layout?.owner === slot.options ? [] : render.call(component, width);
      }
    };
  }
  const slot = prototype[PATCH]!;
  slot.options = options;
  return () => { if (slot.options === options) slot.options = undefined; };
}
