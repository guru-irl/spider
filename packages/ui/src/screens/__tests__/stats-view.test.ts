import { describe, it, expect } from "vitest";
import { renderStats } from "../stats-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderStats", () => {
  it("renders token savings, row counts and model table within width", () => {
    const lines = renderStats({
      tokenSavings: { indexedChunks: 100, estTokensSaved: 12000 },
      rowCounts: { memory: 42, todos: 8 },
      models: [{ model: "copilot/fast", calls: 2, okRate: 0.5, avgMs: 200, tokens: 1200 }],
    }, id, 60);
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/12000|12,000/);
    expect(lines.join("\n")).toMatch(/memory/);
    expect(lines.join("\n")).toMatch(/copilot\/fast/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });

  it("degrades to just savings + rows when there are no model stats", () => {
    const lines = renderStats({
      tokenSavings: { indexedChunks: 0, estTokensSaved: 0 },
      rowCounts: { content: 0 },
      models: [],
    }, id, 40);
    expect(lines.join("\n")).not.toMatch(/model/i);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
});
