import { Spacer, type Component } from "@earendil-works/pi-tui";

type Container = Component & { children: Component[] };
type MouseEntry = { component: Component; height: number };
type MouseLayout = { width?: number; children?: MouseEntry[] };
type CardEdge = (row: string, edge: "top" | "bottom", width: number) => boolean;

// Pi owns the layout and hit map. Only remove a known one-line tool spacer
// when the visible cards on both sides have recognized edges.
export function joinToolCards(container: Container, rows: string[], width: number,
  isTool: (component: Component) => boolean, isEdge: CardEdge): string[] {
  if (width < 1 || !container.children?.some(isTool)) return rows;
  const layout = (container as Container & { mouseLayout?: MouseLayout }).mouseLayout;
  const entries = layout?.children;
  if (layout?.width !== width || !Array.isArray(entries) || entries.length !== container.children.length ||
    entries.some((entry, i) => entry.component !== container.children[i] || !Number.isInteger(entry.height) || entry.height < 0) ||
    entries.reduce((sum, entry) => sum + entry.height, 0) !== rows.length) return rows;
  const output: string[] = [];
  const mouseChildren: MouseEntry[] = [];
  let offset = 0;
  let previousTool = false;
  for (const entry of entries) {
    const part = rows.slice(offset, offset + entry.height);
    offset += entry.height;
    const tool = isTool(entry.component);
    const leading = tool ? (entry.component as Container).children?.[0] : undefined;
    const join = previousTool && tool && leading instanceof Spacer && (leading as unknown as { lines: unknown }).lines === 1 &&
      part.length > 1 && part[0] === "" && isEdge(part[1], "top", width);
    const component = entry.component;
    if (join) {
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
    if (part.length) previousTool = tool && isEdge(part[part.length - 1], "bottom", width);
  }
  layout.children = mouseChildren;
  return output;
}
