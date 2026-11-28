import { describe, it, expect } from "vitest";
import { renderStats } from "../stats-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderStats", () => {
  it("renders token savings, row counts and model table within width", () => {
    const lines = renderStats({
      tokenSavings: { indexedChunks: 100, estTokensSaved: 12000 },
      rowCounts: { memory: 42, todos: 8 },
      models: [{ model: "copilot/fast", calls: 2, okRate: 0.5, avgMs: 200, tokens: 1200 }],
    }, id, 60);
    expect(lines.join("\n")).not.toContain("🕸"); // tool shell owns the header (docs/output-ui-guidelines.md)
    expect(lines[0]).toContain("token savings");
    expect(lines.join("\n")).toMatch(/12000|12,000/);
    expect(lines.join("\n")).toMatch(/memory/);
    expect(lines.join("\n")).toMatch(/copilot\/fast/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });

  it("keeps expanded transcript model columns aligned at 30 columns", () => {
    const lines = renderStats({
      tokenSavings: { indexedChunks: 12, estTokensSaved: 280 },
      rowCounts: {},
      models: [{ model: "github-copilot/gpt-6.2-sol", calls: 10, okRate: 0.9, avgMs: 120, tokens: 2000 }],
    }, id, 30, true, true).map(stripTerminalSequences);
    const header = lines.find(line => /^ model\s/u.test(line));
    const row = lines.find(line => line.includes("10") && line.includes("2000"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();
    for (const [label, value] of [["calls", "10"], ["ok%", "90"], ["avgms", "120"], ["tok", "2000"]]) {
      expect(row!.indexOf(value) + value.length).toBe(header!.indexOf(label) + label.length);
    }
    expect(visibleWidth(row!)).toBeLessThanOrEqual(30);
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
