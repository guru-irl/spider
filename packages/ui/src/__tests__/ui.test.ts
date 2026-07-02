// packages/ui/src/__tests__/ui.test.ts
import { describe, it, expect } from "vitest";
import { theme, Panel, SectionRule, StatusLine, LiveWidget } from "../index.js";

describe("@spider/ui skeleton", () => {
  it("theme exposes the 🕸 glyph and a token() lookup", () => {
    expect(theme.glyph).toBe("🕸");
    expect(typeof theme.token("accent")).toBe("string");
  });

  it("SectionRule renders a full-width rule bearing the glyph", () => {
    const lines = SectionRule("Status").render(40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("🕸");
    expect(lines[0].length).toBeLessThanOrEqual(40);
  });

  it("Panel renders a titled body within width", () => {
    const lines = Panel({ title: "T", body: ["a", "b"] }).render(20);
    expect(lines.some((l) => l.includes("a"))).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
  });

  it("StatusLine packs left/right into one line", () => {
    const lines = StatusLine({ left: "L", right: "R" }).render(20);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("L");
    expect(lines[0]).toContain("R");
  });

  it("LiveWidget subscribes and repaints on notify", () => {
    let notify: () => void = () => {};
    const source = { subscribe(fn: () => void) { notify = fn; return () => {}; } };
    let renders = 0;
    const w = LiveWidget(source, () => { renders++; return ["x"]; });
    w.render(10);
    notify();
    expect(w.render(10)).toEqual(["x"]);
    expect(renders).toBeGreaterThanOrEqual(1);
  });
});
