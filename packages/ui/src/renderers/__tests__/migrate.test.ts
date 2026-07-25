// packages/ui/src/renderers/__tests__/migrate.test.ts
import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderMigrateResult } from "../migrate";
import type { RenderCtx } from "../types";
import type { ThemeAdapter } from "../../agents/types.js";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
const ctx: RenderCtx = {
  theme: id,
  width: 80,
};

describe("renderMigrateResult", () => {
  it("emits themed card with truncated lines (mutation: skip truncation → must fail)", () => {
    const details = {
      dryRun: false,
      applied: true,
      backupDir: "/Users/test/.pi/agent/spider/backups/2026-07-25T12:34:56",
      moved: {
        memory: 5,
        skills: 3,
        sessions: 10,
        content: 20,
      },
      ambiguous: [
        { table: "memory", uuid: "mem-123", reason: "duplicate UUID across worktrees" },
      ],
    };
    
    const lines = renderMigrateResult(details, ctx);
    
    // Should have content
    expect(lines.length).toBeGreaterThan(0);
    
    // Every line must be truncated to width
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(ctx.width);
    }
    
    // Should mention applied status
    expect(lines.join("\n")).toMatch(/migrat|appli/i);
    
    // Should show the backup location
    expect(lines.join("\n")).toMatch(/backup/i);
    
    // Should show moved counts
    expect(lines.join("\n")).toMatch(/memory.*5/);
    
    // Should report ambiguous rows
    expect(lines.join("\n")).toMatch(/ambiguous|conflict/i);
    expect(lines.join("\n")).toMatch(/mem-123/);
  });
  
  it("dry-run output indicates no changes made (mutation: make dry-run show 'applied' → must fail)", () => {
    const details = {
      dryRun: true,
      applied: false,
      wouldMove: {
        memory: 5,
        skills: 3,
      },
    };
    
    const lines = renderMigrateResult(details, ctx);
    
    // Should indicate dry-run
    expect(lines.join("\n")).toMatch(/dry.?run|would|preview/i);
    
    // Should NOT indicate changes were applied
    expect(lines.join("\n")).not.toMatch(/applied|completed|migrated.*\d+/i);
  });
  
  it("handles very long paths by truncating to width", () => {
    const veryLongPath = "/Users/test/very/long/path/".repeat(10) + "backups/timestamp";
    const details = {
      dryRun: false,
      applied: true,
      backupDir: veryLongPath,
      moved: {},
    };
    
    const narrowCtx: RenderCtx = { ...ctx, width: 40 };
    const lines = renderMigrateResult(details, narrowCtx);
    
    // Every line must fit in narrow width
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
