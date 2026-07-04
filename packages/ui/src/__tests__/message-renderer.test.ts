import { describe, it, expect } from "vitest";
import { renderMessageResult } from "../renderers/message.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("message renderer", () => {
  it("delivered message shows target + body within width", () => {
    const lines = renderMessageResult({ verb: "send", to: "peer", body: "hello there", delivered: true }, { theme: id, width: 50 });
    expect(lines[0]).toContain("🕸");
    expect(lines[0]).toContain("✓");
    expect(lines.join("\n")).toMatch(/peer/);
    expect(lines.join("\n")).toMatch(/hello there/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
  it("undelivered message shows ✗ and no body line when body empty", () => {
    const lines = renderMessageResult({ verb: "send", to: "x", body: "", delivered: false }, { theme: id, width: 40 });
    expect(lines[0]).toContain("✗");
    expect(lines).toHaveLength(1);
  });
  it("reply/ask/broadcast verbs render distinct arrows", () => {
    expect(renderMessageResult({ verb: "reply", to: "a", body: "b", delivered: true }, { theme: id, width: 40 })[0]).toContain("↩");
    expect(renderMessageResult({ verb: "broadcast", body: "b", delivered: true }, { theme: id, width: 40 })[0]).toContain("⇉");
  });
});
