import { describe, it, expect } from "vitest";
import { renderInsights } from "../insights-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

const graph = {
  nodes: [
    { id: "skill:tdd", label: "TDD", kind: "skill" as const, category: "process" },
    { id: "mem:u1", label: "prefers tabs", kind: "memory" as const },
  ],
  edges: [{ source: "mem:u1", target: "skill:tdd" }],
  stats: { nodes: 2, edges: 1, linkedPct: 50 },
};

describe("renderInsights", () => {
  it("renders a stats header, nodes and edges within width", () => {
    const lines = renderInsights(graph, id, 60, true);
    expect(lines.join("\n")).not.toContain("🕸"); // tool shell owns the header (docs/output-ui-guidelines.md)
    expect(lines[0]).toMatch(/2 nodes/);
    expect(lines.join("\n")).toMatch(/2 nodes/);
    expect(lines.join("\n")).toMatch(/1 edge/);
    expect(lines.join("\n")).toMatch(/50%/);
    expect(lines.join("\n")).toMatch(/TDD/);
    expect(lines.join("\n")).toMatch(/skill:tdd.*→.*mem:u1|mem:u1.*→.*skill:tdd/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });

  it("collapses the node list when not expanded and never throws on an empty graph", () => {
    const many = { nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `node ${i}`, kind: "skill" as const })), edges: [], stats: { nodes: 30, edges: 0, linkedPct: 0 } };
    const collapsed = renderInsights(many, id, 50, false);
    const expanded = renderInsights(many, id, 50, true);
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    const empty = renderInsights({ nodes: [], edges: [], stats: { nodes: 0, edges: 0, linkedPct: 0 } }, id, 40, false);
    expect(empty.join("\n")).toMatch(/0 nodes/);
    for (const l of collapsed) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
});
