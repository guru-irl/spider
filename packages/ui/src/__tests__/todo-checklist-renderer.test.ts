import { describe, it, expect } from "vitest";
import { renderTodoChecklist } from "../renderers/todo-checklist.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("todo checklist renderer", () => {
  it("renders check glyphs, ids and a completion footer", () => {
    const lines = renderTodoChecklist({
      scope: "session", done: 1, total: 2,
      items: [{ id: 1, text: "write test", done: true }, { id: 2, text: "impl", done: false }],
    }, { theme: id, width: 40 });
    expect(lines.join("\n")).toContain("✓");
    expect(lines.join("\n")).toContain("○");
    expect(lines.join("\n")).toMatch(/#1|#2/);
    expect(lines.join("\n")).toMatch(/1\/2/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });

  it("names the scope as a glyph-free rule and never repeats the tool 🕸 header", () => {
    const lines = renderTodoChecklist({
      scope: "all", done: 0, total: 1,
      items: [{ id: 7, text: "a very long todo text that should be clipped to the width budget without overflow", done: false }],
    }, { theme: id, width: 24 });
    expect(lines.join("\n")).not.toContain("🕸"); // tool shell already shows it (docs/output-ui-guidelines.md)
    expect(lines[0]).toContain("all");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(24);
  });

  it("renders an empty checklist without throwing", () => {
    const lines = renderTodoChecklist({ scope: "session", done: 0, total: 0, items: [] }, { theme: id, width: 40 });
    expect(lines.join("\n")).toMatch(/0\/0/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
});
