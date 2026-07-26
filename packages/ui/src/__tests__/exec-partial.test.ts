import { describe, it, expect } from "vitest";
import { renderExecResult } from "../renderers/exec.js";

const id = { fg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s } as any;

describe("exec result while still running (isPartial)", () => {
  const base = { kind: "exec" as const, commands: ["sleep 5"], ok: true, exitCode: 0, outLines: 2, preview: ["alpha", "beta"] };

  it("shows the streamed output while running", () => {
    const out = renderExecResult({ ...base, running: true } as any, { theme: id, width: 60, expanded: false }).join("\n");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  // Mutation this catches: render the normal status line while running -> claims success
  // for a command that has not finished.
  it("does NOT claim a successful exit while still running", () => {
    const out = renderExecResult({ ...base, running: true } as any, { theme: id, width: 60, expanded: false }).join("\n");
    expect(out).not.toContain("exit 0");
    expect(out).toMatch(/running/i);
  });

  it("once finished, shows the real exit status", () => {
    const out = renderExecResult(base as any, { theme: id, width: 60, expanded: false }).join("\n");
    expect(out).toContain("exit 0");
    expect(out).not.toMatch(/running/i);
  });

  it("while running, shows ALL streamed lines, not just the last one", () => {
    const d = { ...base, running: true, preview: ["l1", "l2", "l3", "l4"] };
    const out = renderExecResult(d as any, { theme: id, width: 60, expanded: false }).join("\n");
    for (const l of ["l1", "l2", "l3", "l4"]) expect(out).toContain(l);
  });
});
