import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths, type Db } from "@spider/db-core";
import { RunStore } from "@spider/subagents";
import { renderKillResult, type KillDetails } from "@spider/ui";

function freshDb(): Db {
  return openDbAt(join(paths.scratch("project", process.cwd()), `kill-boundary-${randomUUID()}.db`), "project");
}

// Identity theme to get raw glyphs
const identityTheme = {
  fg: (_t: string, s: string) => s,
  bg: (_t: string, s: string) => s,
  bold: (s: string) => s,
  glyph: "🕸",
};
const ctx = { theme: identityTheme, width: 80 } as any;

describe("kill handler → renderer boundary", () => {
  it("renders ALL runs when partial failure occurs (some killed, one throws)", async () => {
    // Simulate the exact details shape the handler emits for partial failure
    const details: KillDetails = {
      requested: "all",
      error: "1 kill(s) failed",
      killed: [
        {
          runId: "run-alpha",
          name: "alpha",
          outcome: "killed",
          via: "handle",
          lastActivity: "edit src/a.ts",
        },
        {
          runId: "run-beta",
          name: "beta",
          outcome: "killed",
          via: "handle",
          lastActivity: "edit src/b.ts",
        },
        {
          runId: "run-gamma",
          name: "gamma",
          outcome: "failed",
          via: "none",
          lastActivity: "edit src/g.ts",
          error: "SQLITE_BUSY",
        },
      ],
    };

    const rendered = renderKillResult(details, ctx).join("\n");

    // CRITICAL: All three run names must appear
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");

    // The error message must appear
    expect(rendered).toContain("kill(s) failed");

    // The fail glyph must appear (for gamma)
    expect(rendered).toContain("✗");

    // The success glyph must appear (for alpha/beta)
    expect(rendered).toContain("✓");

    // The failure cause must appear
    expect(rendered).toContain("SQLITE_BUSY");
  });

  it("renders all successful kills with success glyphs", () => {
    const details: KillDetails = {
      requested: "all",
      killed: [
        {
          runId: "run-alpha",
          name: "alpha",
          outcome: "killed",
          via: "handle",
          lastActivity: "edit src/a.ts",
        },
        {
          runId: "run-beta",
          name: "beta",
          outcome: "killed",
          via: "handle",
          lastActivity: "edit src/b.ts",
        },
      ],
    };

    const rendered = renderKillResult(details, ctx).join("\n");

    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("killed");
    expect(rendered).toContain("✓");
    expect(rendered).not.toContain("✗");
  });

  it("renders resolution failure (unknown id) with error only", () => {
    const details: KillDetails = {
      requested: "ghost",
      error: "no active run matches 'ghost'",
      killed: [],
    };

    const rendered = renderKillResult(details, ctx).join("\n");

    expect(rendered).toContain("ghost");
    expect(rendered).toContain("✗");
    // No runs, just the error
    expect(details.killed).toHaveLength(0);
  });
});
