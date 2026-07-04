// Phase 8: exec/exec_file/batch + index results route through the bespoke
// @spider/ui renderers (not the raw text fallback). Uses an identity theme.
import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSpiderResult } from "../render-result";

const theme = {
  fg: (_t: string, s: string) => s,
  bg: (_t: string, s: string) => s,
  bold: (s: string) => s,
  italic: (s: string) => s,
};

function lines(action: string, details: unknown, args: Record<string, unknown> = {}): string[] {
  const comp = renderSpiderResult({ details }, { expanded: true }, theme, { args: { action, ...args } });
  return comp.render(80);
}

describe("render-result exec/index wiring (Phase 8)", () => {
  it("exec routes to the bespoke renderer (🕸 spider exec ✓ exit 0)", () => {
    const out = lines("exec", { stdout: "one\ntwo\nthree", stderr: "", exitCode: 0, timedOut: false }, { code: "ls -la" }).join("\n");
    expect(out).toContain("🕸");
    expect(out).toContain("spider exec");
    expect(out).toContain("✓");
    expect(out).toMatch(/exit 0/);
  });

  it("batch aggregates exit codes and marks failure", () => {
    const out = lines("batch", [
      { stdout: "ok", stderr: "", exitCode: 0, timedOut: false },
      { stdout: "bad", stderr: "boom", exitCode: 1, timedOut: false },
    ]).join("\n");
    expect(out).toContain("spider batch");
    expect(out).toContain("✗");
  });

  it("index routes to the bespoke renderer with source + chunk counts", () => {
    const out = lines("index", { source: "docs", chunkCount: 12 }, { path: "docs/x.md" }).join("\n");
    expect(out).toContain("spider index");
    expect(out).toMatch(/docs/);
    expect(out).toMatch(/12 chunks/);
  });

  it("every rendered line stays within the width", () => {
    const comp = renderSpiderResult(
      { details: { stdout: "x".repeat(500), stderr: "", exitCode: 0, timedOut: false } },
      { expanded: true }, theme, { args: { action: "exec", code: "echo hi" } },
    );
    for (const l of comp.render(40)) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    }
  });
});
