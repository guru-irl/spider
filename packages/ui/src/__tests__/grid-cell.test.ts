import { describe, it, expect } from "vitest";
import { renderGridCell } from "../agents/grid-cell";
import { Spinner } from "../components/spinner";
import type { AgentSnapshot, ThemeAdapter } from "../agents/types";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
const agent: AgentSnapshot = {
  runId: "r1", name: "worker", role: "worker", status: "running", phase: "impl",
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

  it("shows the run-id as a grey subheading (#id) and a truncated instructions preview", () => {
    const a: AgentSnapshot = { ...agent, task: "read every file under packages and summarize each one" };
    const lines = renderGridCell(id, { agent: a, width: 44, height: 6, focused: false, pinned: false, now: 1000, spinner: new Spinner() });
    const joined = lines.join("\n");
    expect(lines[0]).toContain("worker");        // name is the heading
    expect(joined).toContain("#r1");             // grey run-id subheading
    expect(joined).toContain("↳");               // truncated instructions marker
    expect(joined).toContain("read every file"); // task text preview
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(44);
  });

  it("expands the full instructions (wrapped) when expanded (Ctrl+O)", () => {
    const longTask = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const a: AgentSnapshot = { ...agent, task: longTask };
    const lines = renderGridCell(id, { agent: a, width: 24, height: 10, focused: false, pinned: false, now: 1000, spinner: new Spinner(), expanded: true });
    const joined = lines.join(" ");
    expect(joined).toContain("word0");
    expect(joined).toContain("word10"); // later words appear only because the body wraps the full task
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(24);
  });
});
