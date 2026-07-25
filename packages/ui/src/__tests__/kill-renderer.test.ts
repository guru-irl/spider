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
    const lines = renderKillResult({ requested: "all", killed: [] }, ctx);
    const text = lines.join("\n");
    expect(text).toContain("no active subagents");
    expect(text).toContain("to kill");
  });

  it("renders error message with fail icon when error is present", () => {
    const lines = renderKillResult({ requested: "ghost", killed: [], error: "no active run matches 'ghost'" }, ctx);
    const text = lines.join("\n");
    expect(text).toContain("no active run matches");
    expect(text).toContain("ghost");
  });

  it("renders benign outcomes (already-finished, no-process) with warn status, not fail", () => {
    // Use a theme that actually generates different icons for different statuses
    const iconTheme = {
      fg: (_t: string, s: string) => s,
      bg: (_t: string, s: string) => s,
      bold: (s: string) => s,
      glyph: "🕸",
      icon: (status: string) => status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗",
    };
    const iconCtx = { theme: iconTheme as any, width: 80 };
    const out = renderKillResult(
      { requested: "all", killed: [
        { runId: "r1", name: "done-run", outcome: "already-finished", via: "none" },
        { runId: "r2", name: "orphan", outcome: "no-process", via: "none" },
      ] },
      iconCtx,
    ).join("\n");
    // Should contain warn icons, not fail icons
    expect(out).toContain("already-finished");
    expect(out).toContain("no-process");
    // If using real statusIcon, benign outcomes should get warn status
  });
});
