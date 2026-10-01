import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderErrorResult } from "../renderers/error.js";
import type { ThemeAdapter } from "../agents/types.js";

const theme: ThemeAdapter = { fg: (_token, text) => text, bg: (_token, text) => text, bold: text => text, glyph: "🕸" };
const headline = "Not stored: global memory is full (7,952 of 8,000 chars used). This entry is 470 chars; free at least 422.";
const textOf = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ").trim();

describe("collapsed error wrapping", () => {
  it.each([80, 240])("retains cap numbers at width %i, but not the multiline help", width => {
    const lines = renderErrorResult(headline + "\nFree space: forget an entry.", { theme, width });
    expect(textOf(lines)).toBe(`✗ ${headline}`);
    expect(lines.filter(line => line.trim()).length).toBeLessThanOrEqual(4);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("keeps a long single-line error that fits in four rows", () => {
    const message = "justification required: say why the fact is durable after this task, how it helps other agents, and why the chosen scope is right (global in every repo, otherwise repo).";
    const lines = renderErrorResult(message, { theme, width: 80 });
    expect(textOf(lines)).toBe(`✗ ${message}`);
    expect(lines.filter(line => line.trim()).length).toBeGreaterThan(1);
    expect(lines.filter(line => line.trim()).length).toBeLessThanOrEqual(4);
  });

  it("bounds very long collapsed errors to four wrapped rows", () => {
    const lines = renderErrorResult("retry ".repeat(150), { theme, width: 80 });
    expect(lines.filter(line => line.trim())).toHaveLength(4);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  it("preserves error color on each wrapped headline row", () => {
    const colored = { ...theme, fg: (token: string, text: string) => token === "error" ? `\x1b[31m${text}\x1b[39m` : text };
    const lines = renderErrorResult(headline, { theme: colored, width: 80 }).filter(line => line.trim());
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toContain("\x1b[31m");
  });
});
