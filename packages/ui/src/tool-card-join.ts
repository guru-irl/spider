import { Spacer, type Component } from "@earendil-works/pi-tui";

type Container = Component & { children: Component[] };
type MouseEntry = { component: Component; height: number };
type MouseLayout = { width?: number; children?: MouseEntry[] };
type CardEdge = (row: string, edge: "top" | "bottom", width: number) => boolean;
type SpacerClass = abstract new (...args: never[]) => unknown;

export interface JoinToolCardOptions {
  /** The host's Spacer class. A bundled Pi carries its own copy of pi-tui, so
   *  spider's imported Spacer would never match the host's spacer rows. */
  Spacer?: SpacerClass;
  /** Rows a component draws without content, such as an assistant turn that
   *  holds only tool calls. They are held and dropped when the next tool joins. */
  isBlank?: (component: Component, rows: string[]) => boolean;
}

// Pi owns the layout and hit map. Only remove a known one-line tool spacer
// when the visible cards on both sides have recognized edges.
export function joinToolCards(container: Container, rows: string[], width: number,
  isTool: (component: Component) => boolean, isEdge: CardEdge, options: JoinToolCardOptions = {}): string[] {
  if (width < 1 || !container.children?.some(isTool)) return rows;
  const layout = (container as Container & { mouseLayout?: MouseLayout }).mouseLayout;
  const entries = layout?.children;
  if (layout?.width !== width || !Array.isArray(entries) || entries.length !== container.children.length ||
    entries.some((entry, i) => entry.component !== container.children[i] || !Number.isInteger(entry.height) || entry.height < 0) ||
    entries.reduce((sum, entry) => sum + entry.height, 0) !== rows.length) return rows;
  const SpacerType = options.Spacer ?? Spacer;
  const output: string[] = [];
  const mouseChildren: MouseEntry[] = [];
  let offset = 0;
  let previousTool = false;
  let pending: { row: number; mouse: number } | undefined;
  for (const entry of entries) {
    const part = rows.slice(offset, offset + entry.height);
    offset += entry.height;
    // Hold blank rows between two tools until the next tool shows it can join.
    if (previousTool && options.isBlank?.(entry.component, part)) {
      pending ??= { row: output.length, mouse: mouseChildren.length };
      output.push(...part);
      mouseChildren.push(entry);
      continue;
    }
    if (pending && part.length === 0) {
      mouseChildren.push(entry);
      continue;
    }
    const tool = isTool(entry.component);
    const leading = tool ? (entry.component as Container).children?.[0] : undefined;
    const join = previousTool && tool && leading instanceof SpacerType && (leading as unknown as { lines: unknown }).lines === 1 &&
      part.length > 1 && part[0] === "" && isEdge(part[1], "top", width);
    const component = entry.component;
    if (join) {
      if (pending) {
        output.length = pending.row;
        for (let i = pending.mouse; i < mouseChildren.length; i++) mouseChildren[i] = { ...mouseChildren[i]!, height: 0 };
      }
      output.push(...part.slice(1));
      // Forward clicks to Pi at the child's original local coordinates.
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
    if (part.length || pending) previousTool = tool && part.length > 0 && isEdge(part[part.length - 1]!, "bottom", width);
    pending = undefined;
  }
  layout.children = mouseChildren;
  return output;
}
