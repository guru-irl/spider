import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatAgentLine, renderGridCell, AgentDetail } from "@spider/ui";
import type { AgentSnapshot, ThemeAdapter } from "@spider/ui";
import { renderSpiderResult, renderSubagentDone } from "../render-result.js";
import { renderUsageFooter, type FooterInput } from "../usage/footer.js";

const resolve = (model: string) => model === "github-copilot/claude-opus-5.5" ? "Claude Opus 5.5" : "";
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s,
  bold: (s: string) => s, italic: (s: string) => s, glyph: "◇", modelName: resolve } as ThemeAdapter;
const agent: AgentSnapshot = { runId: "r1", name: "review", agent: "reviewer", role: "reviewer", status: "running",
  model: "github-copilot/claude-opus-5.5", thinking: "xhigh", stepCount: 2, tokenCount: 0, recentActivity: [] };
const footer: FooterInput = { cwd: "~/src/demo", branch: "main", sessionName: "my session", modelId: "claude-opus-5.5",
  modelName: "Claude Opus 5.5", thinking: "xhigh", context: null, subscription: true,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, piCost: 0, aic: 0, unpricedEntries: 0, aggregateEntries: 0, estimated: false, latestCacheHitRate: null },
  counter: { availability: "disabled", snapshot: null }, statuses: new Map() } as FooterInput;

describe("model display names", () => {
  it("shows the display name and thinking in agent rows, grid and detail", () => {
    expect(formatAgentLine(theme, agent, 120, 0)).toContain("Claude Opus 5.5 · xhigh");
    const grid = renderGridCell(theme, { agent, width: 120, height: 2, focused: false, pinned: false, now: 0 });
    expect(grid.join("\n")).toContain("Claude Opus 5.5");
    const detail = new AgentDetail("r1", theme, { viewport: () => ({ safeHeight: 18 }), requestRender: () => {} });
    detail.update({ kind: "loaded", run: agent, events: [] });
    expect(detail.render(120).join("\n")).toContain("Claude Opus 5.5");
    detail.dispose();
  });
  it("keeps short identifiers for missing names and truncates rows to width", () => {
    const unknown = { ...agent, model: "other/claude-unknown" };
    expect(formatAgentLine(theme, unknown, 120, 0)).toContain("unknown · xhigh");
    const narrow = formatAgentLine(theme, agent, 25, 0);
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(25);
    expect(narrow).toContain("…");
  });
  it("shows names in result and completion cards", () => {
    const run = { agent: "reviewer", model: agent.model, thinking: "xhigh", status: "done" };
    const result = renderSpiderResult({ details: { run } }, {}, {}, { args: { action: "run" }, modelName: resolve });
    expect(result.render(120).join("\n")).toContain("Claude Opus 5.5 · xhigh");
    const done = renderSubagentDone({ details: run }, {}, {}, undefined, resolve);
    expect(done.render(120).join("\n")).toContain("Claude Opus 5.5 · xhigh");
  });
  it("shows the active display name without losing the left side in a narrow footer", () => {
    expect(renderUsageFooter(footer, 80)[0]).toContain("Claude Opus 5.5 · xhigh");
    const narrow = renderUsageFooter({ ...footer, modelName: "An exceptionally long model display name" }, 40)[0];
    expect(narrow).toContain("session");
    expect(narrow).toContain("xhigh");
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
  });
});
