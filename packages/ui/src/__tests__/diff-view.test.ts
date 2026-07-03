// packages/ui/src/__tests__/diff-view.test.ts
import { describe, it, expect } from "vitest";
import { renderDiffView } from "../components/diff-view";
import type { ThemeAdapter } from "../agents/types";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderDiffView", () => {
  it("prefixes +/-/space and respects width", () => {
    const lines = renderDiffView(id, {
      hunks: [{ kind: "add", text: "new" }, { kind: "remove", text: "old" }, { kind: "context", text: "ctx" }],
      width: 20,
    });
    expect(lines[0]).toBe("+new");
    expect(lines[1]).toBe("-old");
    expect(lines[2]).toBe(" ctx");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(20);
  });
  it("collapses to maxLines with a more-indicator", () => {
    const hunks = Array.from({ length: 8 }, (_, i) => ({ kind: "add" as const, text: `l${i}` }));
    const lines = renderDiffView(id, { hunks, width: 20, maxLines: 3 });
    expect(lines).toHaveLength(4); // 3 + summary
    expect(lines[3]).toContain("5 more");
  });
});
