import { describe, expect, it } from "vitest";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { formatAgentLine, renderGridCell, AgentDetail, AgentFooter, AgentStore } from "@spider/ui";
import type { AgentSnapshot, ThemeAdapter } from "@spider/ui";
import { renderSpiderResult, renderSubagentDone } from "../render-result.js";
import { renderUsageFooter, type FooterInput } from "../usage/footer.js";
import { modelContextWindow, modelName } from "../model-name.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  it("resolves qualified and bare IDs using the provider catalog, and ignores empty names", () => {
    const models = [
      { provider: "copilot", id: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { provider: "other", id: "claude-opus-5.5", name: "Another Opus" },
      { provider: "router", id: "company/gpt-6", name: "GPT 6" },
      { provider: "copilot", id: "nameless", name: "  " },
    ];
    const registry = { getAll: () => models, getAvailable: () => [], find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id) } as unknown as ExtensionContext["modelRegistry"];
    expect(modelName(registry, "copilot/claude-opus-5.5")).toBe("Claude Opus 5.5");
    expect(modelName(registry, "router/company/gpt-6")).toBe("GPT 6");
    expect(modelName(registry, "company/gpt-6")).toBe("GPT 6");
    expect(modelName(registry, "claude-opus-5.5")).toBe("Claude Opus 5.5");
    expect(modelName(registry, "copilot/nameless")).toBeUndefined();
    expect(modelName(registry, "copilot/not-found")).toBeUndefined();
    expect(modelName(undefined, "copilot/not-found")).toBeUndefined();
  });
  it("prefers available catalog names for conflicting bare model IDs", () => {
    const models = [
      { provider: "radius", id: "gpt-6.1-terra", name: "GPT 6.1 Terra" },
      { provider: "github-copilot", id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
    ];
    const registry = { getAll: () => models, getAvailable: () => [models[1]],
      find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id) } as unknown as ExtensionContext["modelRegistry"];
    expect(modelName(registry, "gpt-6.1-terra")).toBe("GPT-6.1 Terra");
    expect(modelName(registry, "radius/gpt-6.1-terra")).toBe("GPT 6.1 Terra");
    expect(modelName(registry, "not-in-catalog")).toBeUndefined();
  });
  it("resolves context windows for qualified and bare model IDs", () => {
    const models = [
      { provider: "radius", id: "gpt-6.1-terra", name: "GPT 6.1 Terra", contextWindow: 200000 },
      { provider: "github-copilot", id: "gpt-6.1-terra", name: "GPT-6.1 Terra", contextWindow: 1000000 },
      { provider: "router", id: "company/gpt-6", name: "GPT 6", contextWindow: 128000 },
    ];
    const registry = { getAll: () => models, getAvailable: () => [models[1]],
      find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id) } as unknown as ExtensionContext["modelRegistry"];
    expect(modelContextWindow(registry, "gpt-6.1-terra")).toBe(1000000);
    expect(modelContextWindow(registry, "radius/gpt-6.1-terra")).toBe(200000);
    expect(modelContextWindow(registry, "company/gpt-6")).toBe(128000);
    expect(modelContextWindow(registry, "missing")).toBeUndefined();
  });
  it("rounds a fractional catalog context window before sending it to the viewer", () => {
    const model = { provider: "example", id: "model", name: "Model", contextWindow: 123.5 };
    const registry = { find: () => model, getAll: () => [model], getAvailable: () => [model] } as unknown as ExtensionContext["modelRegistry"];
    expect(modelContextWindow(registry, "example/model")).toBe(124);
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, 0, -1, Infinity])("does not return invalid catalog context window %s", (contextWindow) => {
    const model = { provider: "example", id: "model", name: "Model", contextWindow };
    const registry = { find: () => model, getAll: () => [model], getAvailable: () => [model] } as unknown as ExtensionContext["modelRegistry"];
    expect(modelContextWindow(registry, "example/model")).toBeUndefined();
  });
  it.each([72, 120])("aligns agent and usage footer model sides at %i columns", (width) => {
    const source = { listActive: () => [{ id: "r1", session_id: "s", agent: "reviewer", name: "review", status: "running" as const,
      model: agent.model, thinking: "xhigh", step_count: 2, token_count: 0, started_at: 0 }],
      getRun: () => undefined, subscribe: () => () => {} };
    const store = new AgentStore(source); store.start();
    const rows = new Container();
    rows.addChild(new AgentFooter(store, theme, { now: () => 0 }));
    rows.addChild({ render: (w: number) => renderUsageFooter(footer, w), invalidate() {} });
    const [row, heading] = rows.render(width);
    expect(row).toMatch(/Claude Opus 5\.5 · xhigh$/);
    expect(heading).toMatch(/Claude Opus 5\.5 · xhigh$/);
    expect(visibleWidth(row!)).toBe(width);
    expect(visibleWidth(heading!)).toBe(width);
    store.stop();
  });
  it("shows the display name and thinking in agent rows, grid and detail", () => {
    expect(formatAgentLine(theme, agent, 120, 0)).toContain("Claude Opus 5.5 · xhigh");
    const grid = renderGridCell(theme, { agent, width: 120, height: 2, focused: false, pinned: false, now: 0 });
    expect(grid.join("\n")).toContain("Claude Opus 5.5 · xhigh");
    const detail = new AgentDetail("r1", theme, { viewport: () => ({ safeHeight: 18 }), requestRender: () => {} });
    detail.update({ kind: "loaded", run: agent, events: [] });
    expect(detail.render(120).join("\n")).toContain("Claude Opus 5.5 · xhigh");
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
  it("uses names for catalog and statistics labels without changing stored model references", () => {
    const model = "github-copilot/claude-opus-5.5";
    const stats = renderSpiderResult({ details: { tokenSavings: { indexedChunks: 0, estTokensSaved: 0 }, rowCounts: {},
      models: [{ model, calls: 1, okRate: 1, avgMs: 2, tokens: 3 }] } }, {}, {},
      { args: { action: "control", command: "stats" }, modelName: resolve });
    expect(stats.render(120).join("\n")).toContain("Claude Opus 5.5");
    const catalog = [{ provider: "github-copilot", id: "claude-opus-5.5", tier: "heavy", available: true, thinking: true, vision: true, ctx: 100, speed: 1, costHint: 1 }];
    const details = { catalog, defaults: { worker: model } };
    const view = renderSpiderResult({ details }, {}, {}, { args: { action: "control", command: "models" }, modelName: resolve });
    expect(view.render(120).join("\n")).toContain("Claude Opus 5.5");
    expect(details.defaults.worker).toBe(model);
  });
  it("refreshes a card when a model name changes in the registry", () => {
    let name = "Claude Opus 5.5";
    const run = { agent: "reviewer", model: agent.model, thinking: "xhigh", status: "done" };
    const result = renderSpiderResult({ details: { run } }, {}, {}, { args: { action: "run" }, modelName: () => name });
    const done = renderSubagentDone({ details: run }, {}, {}, undefined, () => name);
    expect(result.render(120).join("\n")).toContain("Claude Opus 5.5");
    expect(done.render(120).join("\n")).toContain("Claude Opus 5.5");
    name = "New Opus Name";
    expect(result.render(120).join("\n")).toContain("New Opus Name");
    expect(done.render(120).join("\n")).toContain("New Opus Name");
  });
  it("shows the active display name without losing the left side in a narrow footer", () => {
    expect(renderUsageFooter(footer, 80)[0]).toContain("Claude Opus 5.5 · xhigh");
    const narrow = renderUsageFooter({ ...footer, modelName: "An exceptionally long model display name" }, 40)[0];
    expect(narrow).toContain("session");
    expect(narrow).toContain("xhigh");
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
    const pane = renderUsageFooter({ ...footer, inPane: true, modelName: "An exceptionally long model display name",
      context: { percent: 14.6, contextWindow: 1000000 } }, 40)[0];
    expect(pane).toContain("14.6%/1.0M");
    expect(pane).toContain("xhigh");
    expect(visibleWidth(pane)).toBeLessThanOrEqual(40);
  });
});
