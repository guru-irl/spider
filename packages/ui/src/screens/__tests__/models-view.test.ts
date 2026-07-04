import { describe, it, expect } from "vitest";
import { renderModels, ModelsView } from "../models-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import type { ModelEntry } from "@spider/models";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
const E = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  provider: "copilot", id: "m", tier: "standard", thinking: false, vision: false,
  ctx: 1, speed: 1, costHint: 1, available: true, ...over,
});

const entries = [
  E({ id: "claude-sonnet-5", tier: "standard", thinking: true, vision: true }),
  E({ id: "flash", tier: "light", available: false }),
];
const defaults = { worker: "copilot/claude-sonnet-5" };

describe("renderModels", () => {
  it("renders tier sections, availability glyphs and default markers, width-safe", () => {
    const lines = renderModels(entries, defaults, id, 60);
    const out = lines.join("\n");
    expect(lines.join("\n")).not.toContain("🕸"); // tool shell owns the header (docs/output-ui-guidelines.md)
    expect(lines[0]).toMatch(/light/); // first tier rule (light→standard→heavy)
    expect(out).toMatch(/light/);
    expect(out).toMatch(/standard/);
    expect(out).toContain("●"); // available
    expect(out).toContain("○"); // unavailable
    expect(out).toMatch(/⟵.*worker/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });

  it("never throws on empty input (empty body — tool shell still shows the header)", () => {
    const lines = renderModels([], {}, id, 40);
    expect(lines).toEqual([]);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
});

describe("ModelsView", () => {
  it("caches by width", () => {
    const v = new ModelsView(entries, defaults, id);
    const a = v.render(50);
    expect(v.render(50)).toBe(a);
    const b = v.render(70);
    expect(b).not.toBe(a);
    v.invalidate();
    expect(v.render(50)).not.toBe(a);
  });
});
