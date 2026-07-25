import { describe, it, expect } from "vitest";
import { renderKillResult } from "../renderers/kill";

const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, glyph: "🕸" };
const ctx = { theme, width: 80 } as any;

describe("renderKillResult", () => {
  it("renders one line per killed run with its outcome", () => {
    const out = renderKillResult(
      { requested: "all", killed: [
        { runId: "r1", name: "alpha", outcome: "killed", via: "handle", lastActivity: "edit src/a.ts" },
        { runId: "r2", name: "beta", outcome: "already-finished", via: "none" },
      ] },
      ctx,
    ).join("\n");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("edit src/a.ts");
  });

  it("renders an empty-target message without throwing", () => {
    expect(() => renderKillResult({ requested: "all", killed: [] }, ctx)).not.toThrow();
  });
});
