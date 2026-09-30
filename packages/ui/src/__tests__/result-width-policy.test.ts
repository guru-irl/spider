import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitResultLines } from "../index";
import * as widthPolicy from "../renderers/types";

const stripped = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("result width policy", () => {
  it("exposes one shared truncation choice for expanded and collapsed renderers", () => {
    const trim = (widthPolicy as Record<string, unknown>).trimResultLine;
    expect(typeof trim).toBe("function");
    if (typeof trim !== "function") return;
    const apply = trim as (line: string, width: number, expanded: boolean, suffix?: string) => string;
    expect(apply("abcdef", 3, true)).toBe("abcdef");
    expect(stripped(apply("abcdef", 3, false, "…"))).toBe("ab…");
  });
  it("preserves a 500-character expanded row within 80 columns", () => {
    const text = "x".repeat(500);
    const lines = fitResultLines([text], 80, true);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(lines.join("")).toBe(text);
  });

  it("truncates each source row to one row when collapsed", () => {
    const lines = fitResultLines(["x".repeat(500), "y".repeat(500)], 80, false);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(stripped(lines.join("")).length).toBe(160);
  });

  it("reapplies ANSI foreground and background on each styled continuation", () => {
    const lines = fitResultLines(["\x1b[31;44m" + "x".repeat(500) + "\x1b[0m"], 80, true);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(lines.every((line) => line.includes("\x1b[31;44m"))).toBe(true);
    expect(lines.slice(0, -1).every((line) => !line.endsWith("\x1b[0m"))).toBe(true);
    expect(stripped(lines.join(""))).toBe("x".repeat(500));
  });

  it.each([30, 80])("hangs continuation rows after every leading marker at width %i", (width) => {
    const payload = "x".repeat(180);
    const prefixes = [" ⎿ ", " ✓ ", " ✗ ", " 12. ◆ ", " • ", " │ ", "    ↳ ", "    ⤴ ", "     ", " ● ", " ✗ → ", " - "];
    for (const prefix of prefixes) {
      const rows = fitResultLines([prefix + payload], width, true).map(stripped);
      expect(rows.length, prefix).toBeGreaterThan(1);
      expect(rows[0].startsWith(prefix + "x"), prefix).toBe(true);
      const indent = " ".repeat(visibleWidth(prefix));
      expect(rows.slice(1).every((row) => row.startsWith(indent + "x")), prefix).toBe(true);
      expect(rows.every((row) => visibleWidth(row) <= width), prefix).toBe(true);
      expect(rows.map((row) => row.slice(prefix.length)).join(""), prefix).toBe(payload);
    }
  });

  it.each([30, 80])("keeps a long first word beside the middle-dot marker at width %i", (width) => {
    const marker = "  · ";
    const payload = "x".repeat(180);
    const rows = fitResultLines([marker + payload], width, true).map(stripped);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].startsWith(marker + "x")).toBe(true);
    expect(rows.slice(1).every((row) => row.startsWith("    x"))).toBe(true);
    expect(rows.map((row) => row.slice(marker.length)).join("")).toBe(payload);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });

  it("does not hang an exact-width prefix into a 31-column row", () => {
    const rows = fitResultLines([" ".repeat(30) + "x".repeat(40)], 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => visibleWidth(row) <= 30)).toBe(true);
    expect(stripped(rows.join("")).replace(/\s/g, "")).toBe("x".repeat(40));
  });

  it("wraps a long bracketed timestamp at width 30 without a narrow hanging indent or broken words", () => {
    const rows = fitResultLines(["[2026-09-29 12:00:00.000] message with several ordinary words that fit together"], 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => visibleWidth(row) <= 30)).toBe(true);
    expect(rows.some((row) => row.startsWith("message with several"))).toBe(true);
    expect(rows.slice(1).every((row) => !row.startsWith(" ".repeat(26)))).toBe(true);
  });

  it("retains bracketed-label hanging indent when width 80 leaves room for text", () => {
    const marker = "[2026-09-29 12:00:00.000] ";
    const rows = fitResultLines([marker + "x".repeat(180)], 80, true).map(stripped);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].startsWith(marker + "x")).toBe(true);
    expect(rows.slice(1).every((row) => row.startsWith(" ".repeat(visibleWidth(marker)) + "x"))).toBe(true);
    expect(rows.every((row) => visibleWidth(row) <= 80)).toBe(true);
    expect(rows.map((row) => row.slice(marker.length)).join("")).toBe("x".repeat(180));
  });

  it("hangs styled gutter rows without duplicating the colored marker", () => {
    const prefix = " \x1b[31m⎿ \x1b[39m";
    const rows = fitResultLines([prefix + "\x1b[32m" + "x".repeat(180) + "\x1b[39m"], 30, true);
    expect(stripped(rows[0]).startsWith(" ⎿ x")).toBe(true);
    expect(rows.slice(1).every((row) => stripped(row).startsWith("   x") && !stripped(row).includes("⎿"))).toBe(true);
    expect(rows.map((row) => stripped(row).slice(3)).join("")).toBe("x".repeat(180));
  });

  it("carries a dim run-output marker's open colour through every continuation", () => {
    const fg = (_token: string, text: string) => `\x1b[2m${text}\x1b[22m`;
    const rows = fitResultLines([`    ${fg("dim", "⤴ " + "x".repeat(180))}`], 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.includes("\x1b[2m"))).toBe(true);
    expect(rows.slice(1).every((row) => stripped(row).startsWith("      x"))).toBe(true);
    expect(rows.map((row) => stripped(row).slice(6)).join("")).toBe("x".repeat(180));
  });

  it("carries open colour from an indented exec stack-trace line", () => {
    const rows = fitResultLines([`\x1b[36m    at ${"x".repeat(180)}\x1b[39m`], 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.includes("\x1b[36m"))).toBe(true);
    expect(rows.slice(1).every((row) => stripped(row).startsWith("    at ") === false && stripped(row).startsWith("    x"))).toBe(true);
  });

  it("does not carry colour that closes before the text", () => {
    const rows = fitResultLines([`\x1b[2m ⎿ \x1b[22m${"x".repeat(180)}`], 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).every((row) => !row.includes("\x1b[2m"))).toBe(true);
  });

  it.each([
    ["256-colour foreground close", " \x1b[38;5;4m✓\x1b[39m "],
    ["truecolor and bold reset", "  \x1b[1;38;2;9;8;7m◆\x1b[0m "],
    ["dim close", " \x1b[2m⎿\x1b[22m "],
  ])("does not carry %s inside the marker onto continuation rows", (_name, marker) => {
    const rows = fitResultLines([marker + "x".repeat(180)], 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).every((row) => !/\x1b\[/.test(row))).toBe(true);
    expect(rows.map((row) => stripped(row).slice(visibleWidth(marker))).join("")).toBe("x".repeat(180));
  });

  it.each([
    ["256-colour", "\x1b[38;5;244m"],
    ["truecolor", "\x1b[38;2;1;2;3m"],
  ])("carries an open %s foreground onto every wrapped row", (_name, open) => {
    const rows = fitResultLines([`    ${open}⤴ ${"x".repeat(180)}\x1b[39m`], 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.includes(open))).toBe(true);
    expect(rows.slice(1).every((row) => stripped(row).startsWith("      x"))).toBe(true);
    expect(rows.map((row) => stripped(row).slice(6)).join("")).toBe("x".repeat(180));
  });

  it("does not duplicate an SGR code when result rows are wrapped twice", () => {
    const input = `    \x1b[2m⤴ ${"x".repeat(180)}\x1b[22m`;
    const rows = fitResultLines(fitResultLines([input], 44, true), 30, true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => !/(\x1b\[[0-9;]*m)\1/.test(row))).toBe(true);
    expect(rows.every((row) => visibleWidth(row) <= 30)).toBe(true);
    expect(rows.map((row) => stripped(row).trim()).join("").replace(/^⤴ /, "")).toBe("x".repeat(180));
  });

  it("keeps wide CJK and emoji graphemes within visible width", () => {
    const text = "界🙂".repeat(125);
    const lines = fitResultLines([text], 80, true);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(lines.join("")).toBe(text);
  });
});
