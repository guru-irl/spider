// packages/ui/src/__tests__/table.test.ts
import { describe, it, expect } from "vitest";
import { renderTable } from "../components/table";
import type { ThemeAdapter } from "../agents/types";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderTable", () => {
  it("aligns columns and never exceeds width", () => {
    const lines = renderTable(id, {
      columns: [{ header: "name" }, { header: "tok", align: "right" }],
      rows: [["worker", "1200"], ["reviewer", "42"]],
      width: 24,
    });
    expect(lines.length).toBe(3); // header + 2 rows
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(24);
    expect(lines[1]).toContain("worker");
  });
});
