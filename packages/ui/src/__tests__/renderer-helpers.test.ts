import { describe, it, expect } from "vitest";
import { card, kv, statusIcon } from "../renderers/types.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderer helpers", () => {
  it("card frames a title with the 🕸 glyph and keeps every line within width", () => {
    const lines = card(id, "memory", ["a", "b"], 30);
    expect(lines[0]).toContain("🕸");
    expect(lines[0]).toContain("memory");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
  });
  it("kv right-truncates the value and never exceeds width", () => {
    const line = kv(id, "provider", "a-really-long-model-identifier-value", 20);
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(line).toContain("provider");
  });
  it("statusIcon maps status to a glyph", () => {
    expect(statusIcon(id, "ok")).toContain("✓");
    expect(statusIcon(id, "fail")).toContain("✗");
    expect(statusIcon(id, "warn")).toContain("⚠");
    expect(statusIcon(id, "on")).toContain("●");
    expect(statusIcon(id, "off")).toContain("○");
    expect(statusIcon(id, "paused")).toContain("■");
  });
});
