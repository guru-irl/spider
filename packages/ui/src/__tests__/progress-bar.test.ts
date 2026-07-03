// packages/ui/src/__tests__/progress-bar.test.ts
import { describe, it, expect } from "vitest";
import { renderProgressBar } from "../components/progress-bar.js";
import type { ThemeAdapter } from "../agents/types.js";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderProgressBar", () => {
  it("fills proportionally and respects width", () => {
    const bar = renderProgressBar(id, { value: 5, max: 10, width: 10, filled: "#", empty: "-" });
    expect(bar).toBe("#####-----");
    expect(bar.length).toBe(10);
  });
  it("clamps overflow and underflow", () => {
    expect(renderProgressBar(id, { value: 20, max: 10, width: 4, filled: "#", empty: "-" })).toBe("####");
    expect(renderProgressBar(id, { value: -3, max: 10, width: 4, filled: "#", empty: "-" })).toBe("----");
  });
  it("guards tiny width", () => {
    expect(renderProgressBar(id, { value: 1, max: 2, width: 0 })).toBe("");
  });
});
