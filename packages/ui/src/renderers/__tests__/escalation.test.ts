import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderEscalation } from "../escalation";
import type { RenderCtx } from "../types";
import type { ThemeAdapter } from "../../agents/types.js";

describe("escalation renderer", () => {
  const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
  const ctx: RenderCtx = { theme: id, width: 80 };

  // Mutation: remove severity rendering → must fail
  it("the rendered card contains the summary and reflects severity", () => {
    const lines = renderEscalation({
      runId: "r1",
      severity: "blocked",
      summary: "Need approval for destructive operation",
      agent: "worker",
      name: "cleanup-task",
    }, ctx);

    const output = lines.join("\n");
    expect(output).toContain("Need approval for destructive operation");
    expect(output).toContain("blocked");
    expect(output).toContain("worker");
    expect(output).toContain("cleanup-task");
  });

  it("handles all severity levels", () => {
    const severities: Array<"blocked" | "question" | "warning"> = ["blocked", "question", "warning"];
    for (const severity of severities) {
      const lines = renderEscalation({
        runId: "r2",
        severity,
        summary: `Test ${severity}`,
        agent: "worker",
        name: "test",
      }, ctx);
      
      const output = lines.join("\n");
      expect(output).toContain(severity);
      expect(output).toContain(`Test ${severity}`);
    }
  });

  it("truncates long lines to width", () => {
    const longSummary = "A".repeat(200);
    const lines = renderEscalation({
      runId: "r3",
      severity: "warning",
      summary: longSummary,
      agent: "worker",
      name: "test",
    }, ctx);

    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(ctx.width);
    }
  });
});
