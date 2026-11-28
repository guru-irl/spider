import { icon as uiIcon } from "../icons.js";
import type { ThemeAdapter } from "../agents/types.js";
import { cardDetailIndent, sectionRule, fitResultLines, resultTrimmer } from "../renderers/types.js";

/** The learning-graph shape produced by @spider/organism `buildLearningGraph`
 *  (nodes = learned skills / active memories, edges = skill↔skill or memory→skill). */
export interface InsightGraphView {
  nodes: { id: string; label: string; kind: string; category?: string }[];
  edges: { source: string; target: string }[];
  stats: { nodes: number; edges: number; linkedPct: number };
}

const NODE_CAP = 8;
const EDGE_CAP = 6;

/** Render the learning graph as a body-only view: a stats line, nodes, and edges.
 *  The call line supplies the title. Collapsed mode caps the lists. */
export function renderInsights(g: InsightGraphView, theme: ThemeAdapter, width: number, expanded = false, transcript = false): string[] {
  const trim = resultTrimmer(expanded);
  const body: string[] = [];
  const indent = transcript ? " " : "";
  const detailIndent = transcript ? cardDetailIndent(theme.iconStyle) : "  ";
  const nodes = g.nodes ?? [];
  const edges = g.edges ?? [];
  const manyGroups = nodes.length > 0 && edges.length > 0;
  const pct = Math.round(g.stats?.linkedPct ?? 0);
  body.push(trim(theme.fg("muted", `${indent}${g.stats?.nodes ?? 0} nodes · ${g.stats?.edges ?? 0} edge${(g.stats?.edges ?? 0) === 1 ? "" : "s"} · ${pct}% linked`), width, ""));

  if (!transcript || manyGroups) body.push(indent + sectionRule(theme, `nodes (${nodes.length})`, width - indent.length));
  const shownNodes = expanded ? nodes : nodes.slice(0, NODE_CAP);
  for (const n of shownNodes) {
    const badge = theme.fg(n.kind === "skill" ? "success" : "dim", uiIcon(theme.iconStyle, n.kind === "skill" ? "active" : "bullet"));
    const cat = n.category ? theme.fg("muted", ` (${n.category})`) : "";
    body.push(trim(`${indent}${badge} ${theme.fg("text", n.label)}${cat}`, width, ""));
  }
  if (!expanded && nodes.length > shownNodes.length) {
    body.push(trim(theme.fg("muted", `${detailIndent}… ${nodes.length - shownNodes.length} more`), width, ""));
  }

  if (edges.length) {
    if (!transcript || manyGroups) body.push(indent + sectionRule(theme, `edges (${edges.length})`, width - indent.length));
    const labels = new Map(nodes.map(node => [node.id, node.label]));
    const names = new Set(labels.values());
    const label = (id: string) => !transcript || names.has(id) ? id : labels.get(id) ?? "(unknown item)";
    const shownEdges = expanded ? edges : edges.slice(0, EDGE_CAP);
    for (const e of shownEdges) {
      body.push(trim(`${indent}${theme.fg("text", label(e.source))} ${theme.fg("dim", uiIcon(theme.iconStyle, "arrowRight"))} ${theme.fg("text", label(e.target))}`, width, ""));
    }
    if (!expanded && edges.length > shownEdges.length) {
      body.push(trim(theme.fg("muted", `${detailIndent}… ${edges.length - shownEdges.length} more`), width, ""));
    }
  }
  return fitResultLines(body, width, expanded, transcript ? 3 : undefined);
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
