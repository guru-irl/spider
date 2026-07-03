import { describe, it, expect } from "vitest";
import { renderGridCell } from "../agents/grid-cell";
import { Spinner } from "../components/spinner";
import type { AgentSnapshot, ThemeAdapter } from "../agents/types";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
const agent: AgentSnapshot = {
  runId: "r1", name: "worker", agent: "worker", role: "worker", status: "running", phase: "impl",
  startedAt: 0, stepCount: 2, tokenCount: 50, recentActivity: ["read a.ts", "edit a.ts"],
};

describe("renderGridCell", () => {
  it("emits exactly `height` lines, each within width", () => {
    const lines = renderGridCell(id, { agent, width: 30, height: 5, focused: false, pinned: false, now: 1000, spinner: new Spinner() });
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
    expect(lines[0]).toContain("worker");
    expect(lines[0]).toContain("🕸");
  });
  it("marks a focused cell", () => {
    const lines = renderGridCell(id, { agent, width: 30, height: 4, focused: true, pinned: false, now: 1000, spinner: new Spinner() });
    expect(lines[0]).toContain("▸");
  });

  it("shows a type/model/turns meta line and a truncated instructions preview", () => {
    const a: AgentSnapshot = { ...agent, task: "read every file under packages and summarize each one" };
    const lines = renderGridCell(id, { agent: a, width: 44, height: 6, focused: false, pinned: false, now: 1000, spinner: new Spinner() });
    const joined = lines.join("\n");
    expect(lines[0]).toContain("worker");        // name is the heading
    expect(joined).toContain("turns");           // type/model/turns meta line
    expect(joined).not.toContain("#r1");         // no useless run-id in the cell
    expect(joined).toContain("↳");               // truncated instructions marker
    expect(joined).toContain("read every file"); // task text preview
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(44);
  });
});
