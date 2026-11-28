import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AgentDetail, AgentFooter, AgentList, AgentStore, renderGridCell, type AgentSnapshot, type RunEvent, type RunRow } from "@spider/ui";
import { describe, expect, it } from "vitest";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };
import { piTheme } from "./theme-adapter.js";

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
function theme(mode: "truecolor" | "256color" = "truecolor") {
  return piTheme(new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], mode), "nerd", true);
}
function snapshot(role: string, status: AgentSnapshot["status"] = "running"): AgentSnapshot {
  return { runId: "robot-7854", name: "raven", agent: "worker", role, status, model: "vendor/fixture", thinking: "high",
    stepCount: 27, tokenCount: 0, startedAt: 0, activity: "spider exec: private output", recentActivity: [] };
}
function storeFor(a: AgentSnapshot): AgentStore {
  const row: RunRow = { id: a.runId, session_id: "s", name: a.name, agent: a.agent, role: a.role, status: a.status,
    model: a.model, thinking: a.thinking, started_at: 0, step_count: a.stepCount, token_count: 0 };
  let notify: ((event: RunEvent) => void) | undefined;
  const store = new AgentStore({ listActive: () => [row], getRun: () => row, subscribe: fn => { notify = fn; return () => {}; } }, () => 301000);
  store.start();
  notify?.({ runId: row.id, type: "tool_intent", summary: a.activity, ts: 1 } as RunEvent);
  return store;
}
function views(a: AgentSnapshot, mode: "truecolor" | "256color" = "truecolor") {
  const t = theme(mode), store = storeFor(a), now = 301000;
  const footer = new AgentFooter(store, t, { now: () => now }).render(180)[0]!;
  const list = new AgentList(store, t, { now: () => now }).render(180)[0]!;
  const grid = renderGridCell(t, { agent: a, width: 180, height: 2, focused: false, pinned: false, now });
  const detail = new AgentDetail(a.runId, t, { viewport: () => ({ safeHeight: 18 }), requestRender: () => {}, now: () => now });
  detail.update({ kind: "loaded", run: a, events: [] });
  const details = detail.render(180);
  store.stop(); detail.dispose();
  return { footer, list, grid, details };
}

describe("agent role presentation", () => {
  it("puts the italic role before the bold name and removes activity from the footer", () => {
    const { footer, list } = views(snapshot("reviewer"));
    const plain = stripTerminalSequences(footer);
    expect(plain).toContain("reviewer raven · fixture · high · 27 turns · 5m1s");
    expect(plain).not.toContain("private output");
    expect(footer).toMatch(/\x1b\[3m[^]*reviewer[^]*\x1b\[23m/u);
    expect(footer).toMatch(/\x1b\[1m[^]*raven[^]*\x1b\[22m/u);
    expect(stripTerminalSequences(list)).toContain("reviewer raven");
  });

  it.each([
    ["worker", "130;170;255", 111], ["reviewer", "255;184;108", 215],
    ["scout", "139;233;253", 117], ["planner", "199;146;234", 176],
    ["watcher", "255;146;223", 212], ["bespoke", "214;172;255", 183],
    ["researcher", "214;172;255", 183], ["oracle", "214;172;255", 183],
  ])("uses the %s accent in footer, list, grid and detail", (role, rgb, index) => {
    const lines = views(snapshot(role));
    const ansi = `\x1b[38;2;${rgb}m`;
    for (const row of [lines.footer, lines.list]) expect(row.split(ansi).length - 1).toBeGreaterThanOrEqual(2);
    expect(lines.grid[0]).toContain(ansi);
    expect(lines.grid[1]).toContain(ansi);
    expect(lines.details[0]).toContain(ansi);
    expect(lines.details[1]).toContain(ansi);
    const narrow = views(snapshot(role), "256color");
    for (const row of [narrow.footer, narrow.list, ...narrow.grid, ...narrow.details.slice(0, 2)]) {
      expect(row).toContain(`\x1b[38;5;${index}m`);
      expect(row).not.toContain("\x1b[38;2;");
    }
  });

  it.each([["done", "80;250;123"], ["failed", "255;110;110"], ["cancelled", "255;203;107"]] as const)
    ("keeps the %s status color independently of the reviewer role", (status, rgb) => {
      const a = snapshot("reviewer", status);
      const result = views(a);
      for (const row of [result.footer, result.list, result.grid[0], result.details[0]]) expect(row).toContain(`\x1b[38;2;${rgb}m`);
      expect(result.footer).toContain("\x1b[38;2;255;184;108m");
    });
});
