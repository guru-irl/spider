import { describe, it, expect } from "vitest";
import { renderTodoChecklist } from "../renderers/todo-checklist.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const theme: ThemeAdapter = { fg: (_token, text) => text, bg: (_token, text) => text, bold: text => text, glyph: "🕸️" };
const item = { id: 935, text: "Check the manifest", done: false };
const done = { id: 936, text: "Read the logs", done: true };

describe("todo checklist renderer", () => {
  it.each([[false, "○"], [true, "✓"]] as const)("renders only the changed item (done=%s)", (done, glyph) => {
    expect(renderTodoChecklist({ kind: "item", item: { ...item, done } }, { theme, width: 80 }))
      .toEqual([` ${glyph} #935 Check the manifest`]);
  });

  it("renders one list with no heading and a completed count", () => {
    expect(renderTodoChecklist({ kind: "list", groups: [{ label: "Release", items: [item, done] }] }, { theme, width: 40 }))
      .toEqual([" ○ #935 Check the manifest", " ✓ #936 Read the logs", " 1/2 completed"]);
  });

  it("uses section rules only to distinguish several groups", () => {
    const groups = [{ label: "Release", items: [item] }, { label: "Build", items: [done] }];
    const lines = renderTodoChecklist({ kind: "list", groups }, { theme, width: 28 });
    expect(lines[0]).toMatch(/^ Release ──/u);
    expect(lines[2]).toBe("");
    expect(lines[3]).toMatch(/^ Build ──/u);
    expect(lines.at(-1)).toBe(" 1/2 completed");
    expect(lines.join("\n")).not.toContain("🕸");
    expect(lines.every(line => visibleWidth(line) <= 28)).toBe(true);
  });

  it.each([[undefined, ""], ["Release", " from Release"]])("labels a removal from another session only (%s)", (sessionName, suffix) => {
    expect(renderTodoChecklist({ kind: "removed", item, sessionName }, { theme, width: 80 }))
      .toEqual([` Removed #935 Check the manifest${suffix}`]);
  });

  it("renders an empty checklist without throwing", () => {
    expect(renderTodoChecklist({ kind: "list", groups: [] }, { theme, width: 24 }))
      .toEqual([" (no todos)", " 0/0 completed"]);
  });
});
