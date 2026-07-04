import { describe, it, expect } from "vitest";
import { renderIndexResult } from "../renderers/index-fetch.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("index/fetch renderer", () => {
  it("shows source, chunk + embed counts", () => {
    const lines = renderIndexResult({
      kind: "index", source: "docs", targets: ["a.md", "b.md"], chunks: 20, embedded: 20,
    }, { theme: id, width: 60, expanded: true });
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/docs/);
    expect(lines.join("\n")).toMatch(/20/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("renders fetch urls and skipped count", () => {
    const lines = renderIndexResult({
      kind: "fetch", source: "web", targets: [], urls: ["https://x/y"], chunks: 4, embedded: 3, skipped: 1,
    }, { theme: id, width: 50, expanded: true });
    expect(lines.join("\n")).toMatch(/https:\/\/x\/y/);
    expect(lines.join("\n")).toMatch(/skip/i);
  });
});
