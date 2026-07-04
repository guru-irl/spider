import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import { card } from "../renderers/types.js";

/** The learning-graph shape produced by @spider/organism `buildLearningGraph`
 *  (nodes = learned skills / active memories, edges = skill↔skill or memory→skill). */
export interface InsightGraphView {
  nodes: { id: string; label: string; kind: string; category?: string }[];
  edges: { source: string; target: string }[];
  stats: { nodes: number; edges: number; linkedPct: number };
}

const NODE_CAP = 8;
const EDGE_CAP = 6;

/** Pure: render the learning graph as a 🕸 insights card — a stats header, a nodes list
 *  (skill/memory badge + label), and an edges list (`a → b`). Collapsed caps the lists. */
export function renderInsights(g: InsightGraphView, theme: ThemeAdapter, width: number, expanded = false): string[] {
  const body: string[] = [];
  const pct = Math.round(g.stats?.linkedPct ?? 0);
  body.push(truncateToWidth(theme.fg("muted", `${g.stats?.nodes ?? 0} nodes · ${g.stats?.edges ?? 0} edge${(g.stats?.edges ?? 0) === 1 ? "" : "s"} · ${pct}% linked`), width, ""));

  const nodes = g.nodes ?? [];
  body.push(truncateToWidth(theme.fg("accent", `── nodes (${nodes.length}) ──`), width, ""));
  const shownNodes = expanded ? nodes : nodes.slice(0, NODE_CAP);
  for (const n of shownNodes) {
    const badge = n.kind === "skill" ? theme.fg("success", "◆") : theme.fg("dim", "•");
    const cat = n.category ? theme.fg("muted", ` (${n.category})`) : "";
    body.push(truncateToWidth(`${badge} ${theme.fg("text", n.label)}${cat}`, width, ""));
  }
  if (!expanded && nodes.length > shownNodes.length) {
    body.push(truncateToWidth(theme.fg("muted", `⎿ … ${nodes.length - shownNodes.length} more`), width, ""));
  }

  const edges = g.edges ?? [];
  if (edges.length) {
    body.push(truncateToWidth(theme.fg("accent", `── edges (${edges.length}) ──`), width, ""));
    const shownEdges = expanded ? edges : edges.slice(0, EDGE_CAP);
    for (const e of shownEdges) {
      body.push(truncateToWidth(`${theme.fg("text", e.source)} ${theme.fg("dim", "→")} ${theme.fg("text", e.target)}`, width, ""));
    }
    if (!expanded && edges.length > shownEdges.length) {
      body.push(truncateToWidth(theme.fg("muted", `⎿ … ${edges.length - shownEdges.length} more`), width, ""));
    }
  }
  return card(theme, "insights", body, width);
}

/** Component wrapper (cached by width) for mounting via ctx.ui.custom. */
export class InsightsView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private graph: InsightGraphView, private theme: ThemeAdapter, private expanded = false) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    this.cachedLines = renderInsights(this.graph, this.theme, width, this.expanded);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
