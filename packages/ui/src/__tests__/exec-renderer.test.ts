import { describe, it, expect } from "vitest";
import { renderExecCall, renderExecResult } from "../renderers/exec.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("exec renderer", () => {
  it("call-header variant shows a command block and +N more when over the cap", () => {
    const cmds = Array.from({ length: 14 }, (_, i) => `cmd${i}`);
    const lines = renderExecCall({ kind: "batch", commands: cmds }, { theme: id, width: 40 });
    expect(lines.join("\n")).toContain("cmd0");
    expect(lines.join("\n")).toMatch(/more/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
  it("result body carries ✓/exit/lines and the indexed note — but NOT a repeated 🕸 spider header", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["ls"], ok: true, exitCode: 0, outLines: 12, ms: 34,
      preview: ["a", "b", "c"], indexed: { source: "shell:ls", chunks: 2 },
    }, { theme: id, width: 60, expanded: true });
    const text = lines.join("\n");
    expect(text).not.toMatch(/spider exec/); // no duplicated header — call line already shows it
    expect(text).toContain("✓");
    expect(text).toMatch(/exit 0/);
    expect(text).toMatch(/12 lines/);
    expect(text).toMatch(/shell:ls|2 chunks/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("collapsed preview shows one line + more-indicator and the ✗ fail path", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["ls"], ok: false, exitCode: 1, outLines: 5, preview: ["x", "y", "z"],
    }, { theme: id, width: 40, expanded: false });
    const text = lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toMatch(/more/);
  });

  it("shows the full command above the output: collapsed to the first line, full on ctrl+o", () => {
    const d = { kind: "exec" as const, commands: ["cd /x\nnpm test\necho done"], ok: true, exitCode: 0, outLines: 1, preview: ["ok"] };
    const collapsed = renderExecResult(d, { theme: id, width: 60, expanded: false }).join("\n");
    expect(collapsed).toContain("cd /x");
    expect(collapsed).not.toContain("echo done");
    expect(collapsed).toMatch(/ctrl\+o/);
    const expanded = renderExecResult(d, { theme: id, width: 60, expanded: true }).join("\n");
    expect(expanded).toContain("npm test");
    expect(expanded).toContain("echo done");
  });
});
