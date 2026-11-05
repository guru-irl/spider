import { afterEach, describe, expect, it, vi } from "vitest";
import * as ui from "@spider/ui";
import * as memory from "@spider/memory";
import {
  renderCommandOutput, renderEscalationMessage, renderOrganismEntry,
  renderSpiderCall, renderSpiderResult, renderSubagentDone,
} from "../render-result";
import { makeRunCostFormatter } from "../run-credits";

const todoItems = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, text: `Task ${i + 1} with enough text to clip at a narrow width`, done: i % 3 === 0 }));
const record = { uuid: "entry-1", category: "fact", content: "Keep the output stable", status: "active", link: null };
const execDetails = { exitCode: 0, stdout: "ready\n", stderr: "", ms: 12 };
const run = { name: "example", agent: "worker", model: "provider/model", status: "done", task: "Read the example", result: "Ready" };
const stats = { tokenSavings: { indexedChunks: 2, estTokensSaved: 30 }, rowCounts: { memory: 1 }, models: [] };
const graph = { nodes: [], edges: [], stats: { nodes: 0, edges: 0, linkedPct: 0 } };
const receipt = { status: "active", uuid: "entry-1", content: "Keep the output stable", category: "fact" };
const report = { status: "completed", memoryStaged: 1, skillsStaged: 0, skillsQueued: 0, todosAdded: 1, errors: [], modelCalls: 1, reason: "idle", startedAt: 100, finishedAt: 200 };

type ResultCase = { name: string; args: Record<string, unknown>; details: unknown; isError?: boolean; isPartial?: boolean };
const resultCases: ResultCase[] = [
  { name: "run", args: { action: "run" }, details: { run } },
  { name: "empty run", args: { action: "run" }, details: {} },
  { name: "exec", args: { action: "exec", code: "echo ready" }, details: execDetails },
  { name: "partial exec", args: { action: "exec", code: "echo ready" }, details: undefined, isPartial: true },
  { name: "exec file", args: { action: "exec_file", path: "example.py" }, details: execDetails },
  { name: "batch", args: { action: "batch", commands: [{ code: "echo ready" }] }, details: [execDetails] },
  { name: "index", args: { action: "index", path: "example.ts" }, details: { chunks: 2, embedded: 2 } },
  { name: "fetch", args: { action: "fetch" }, details: { chunks: 2, embedded: 2, urls: ["https://example.invalid"] } },
  { name: "message", args: { action: "message", to: "example" }, details: { delivery: "delivered" } },
  { name: "message error", args: { action: "message", to: "example" }, details: { delivery: "refused", error: "Not available" } },
  { name: "kill", args: { action: "kill", id: "example" }, details: { requested: "example", killed: [{ runId: "example-run", name: "example", outcome: "killed", via: "handle" }] } },
  { name: "remember", args: { action: "remember" }, details: receipt },
  { name: "recall", args: { action: "recall" }, details: [record] },
  { name: "todo", args: { action: "todo", op: "list" }, details: todoItems },
  { name: "todo remove", args: { action: "todo", op: "remove" }, details: { seq: 1, text: "Task", session: "example" } },
  { name: "todo clear", args: { action: "todo", op: "clear" }, details: { removed: 1, kept: 2 } },
  { name: "search", args: { action: "search" }, details: [{ title: "Example", kind: "memory", snippet: "An example result", source: "example" }] },
  { name: "empty search", args: { action: "search" }, details: [] },
  { name: "skill list", args: { action: "skill", op: "list" }, details: [] },
  { name: "skill distill", args: { action: "skill", op: "distill" }, details: { prompt: "Describe the example" } },
  { name: "skill view", args: { action: "skill", op: "view" }, details: undefined },
  { name: "import", args: { action: "import" }, details: { imported: 1, skipped: 0, staged: 1, committed: 0, perSession: [] } },
  { name: "pending", args: { action: "control", sub: "pending" }, details: [record] },
  { name: "doctor", args: { action: "control", command: "doctor" }, details: { ok: true, lines: ["- Example: ready"] } },
  { name: "stats", args: { action: "control", command: "stats" }, details: stats },
  { name: "models", args: { action: "control", command: "models" }, details: { catalog: [], defaults: {} } },
  { name: "models receipt", args: { action: "control", command: "models" }, details: { ok: true, role: "worker", ref: "provider/model" } },
  { name: "config", args: { action: "control", command: "config" }, details: { config: { "ui.footer": true } } },
  { name: "config receipt", args: { action: "control", command: "config" }, details: { ok: true, key: "ui.footer", value: true } },
  { name: "config value", args: { action: "control", command: "config" }, details: { key: "ui.footer", value: true } },
  { name: "config fallback", args: { action: "control", command: "config" }, details: {} },
  { name: "insights", args: { action: "control", command: "insights" }, details: graph },
  { name: "migrate", args: { action: "control", command: "migrate" }, details: { dryRun: true, applied: false, moved: {}, ambiguous: [] } },
  { name: "bind", args: { action: "control", command: "bind" }, details: { ok: true, path: "/fixture/example" } },
  { name: "unbind", args: { action: "control", command: "unbind" }, details: { ok: true, message: "Session unbound" } },
  { name: "memory status", args: { action: "control", command: "memory", sub: "status" }, details: { entries: [record], usage: 22 } },
  { name: "memory forget", args: { action: "control", command: "memory", sub: "forget" }, details: { ok: true, removed: { status: "archived" }, uuid: "entry-1", scope: "repo" } },
  { name: "memory approve", args: { action: "control", command: "memory", sub: "approve" }, details: receipt },
  { name: "memory reject", args: { action: "control", command: "memory", sub: "reject" }, details: { uuid: "entry-1" } },
  { name: "skill curate", args: { action: "control", command: "skill", sub: "curate" }, details: { toStale: [], toArchived: [], skipped: [] } },
  { name: "control fallback", args: { action: "control", command: "unknown" }, details: {} },
  { name: "error", args: { action: "search" }, details: { error: "Not available" } },
  { name: "thrown error", args: { action: "unknown" }, details: {}, isError: true },
  { name: "text fallback", args: { action: "unknown" }, details: {} },
];

const result = (details: unknown) => ({ content: [{ type: "text", text: "Example output\nSecond line" }], details });
function makeResult(fixture: ResultCase, theme: unknown, expanded = false): ui.Component {
  return renderSpiderResult(result(fixture.details), { expanded, isPartial: fixture.isPartial }, theme, { args: fixture.args, isError: fixture.isError });
}
function countingTheme() {
  let color = "\x1b[31m";
  let calls = 0;
  return {
    theme: {
      fg: (_token: string, text: string) => { calls++; return `${color}${text}\x1b[39m`; },
      bg: (_token: string, text: string) => { calls++; return `${color}${text}\x1b[49m`; },
      bold: (text: string) => text,
      italic: (text: string) => text,
    },
    calls: () => calls,
    change: () => { color = "\x1b[32m"; },
  };
}
afterEach(() => vi.restoreAllMocks());

describe.each([false, true])("chat result caching expanded=%s", expanded => {
  it.each(resultCases)("$name reuses rows and recomputes on resize and invalidation", fixture => {
    const palette = countingTheme();
    const component = makeResult(fixture, palette.theme, expanded);
    const first = component.render(90);
    const calls = palette.calls();
    expect(component.render(90)).toBe(first);
    expect(palette.calls()).toBe(calls);
    const narrow = component.render(35);
    expect(narrow).not.toBe(first);
    expect(component.render(35)).toBe(narrow);
    component.invalidate?.();
    const refreshed = component.render(35);
    expect(refreshed).not.toBe(narrow);
    expect(refreshed).toEqual(narrow);
    expect(component.render(35)).toBe(refreshed);
  });
});

const messageCases = [
  { name: "subagent done", make: (theme: unknown) => renderSubagentDone({ details: { ...run, output: "Ready" } }, {}, theme) },
  { name: "command", make: (theme: unknown) => renderCommandOutput({ details: { args: { action: "todo" }, result: { details: todoItems } } }, {}, theme) },
  { name: "escalation", make: (theme: unknown) => renderEscalationMessage({ details: { runId: "example-run", severity: "warning", summary: "Example needs attention", agent: "worker", name: "example" } }, {}, theme) },
  { name: "organism", make: (theme: unknown) => renderOrganismEntry({ data: report }, {}, theme) },
  ...["run", "exec", "exec_file", "batch", "control"].map(action => ({ name: `call ${action}`, make: (theme: unknown) => renderSpiderCall({ action, code: "echo ready", path: "example.py", commands: [{ code: "echo ready" }], command: "stats" }, theme, {}) })),
];
describe("chat message and call caching", () => {
  it.each(messageCases)("$name reuses rows until width or theme invalidation", ({ make }) => {
    const palette = countingTheme();
    const component = make(palette.theme);
    const first = component.render(90);
    const calls = palette.calls();
    expect(component.render(90)).toBe(first);
    expect(palette.calls()).toBe(calls);
    const narrow = component.render(45);
    expect(narrow).not.toBe(first);
    expect(component.render(45)).toBe(narrow);
    palette.change();
    component.invalidate?.();
    const updated = component.render(45);
    expect(updated).not.toBe(narrow);
    expect(updated.join("\n")).toContain("\x1b[32m");
    expect(updated.join("\n")).not.toContain("\x1b[31m");
    expect(component.render(45)).toBe(updated);
  });

  it.each(resultCases.filter(fixture => ["todo", "models receipt", "config receipt", "run", "exec", "doctor", "memory forget"].includes(fixture.name)))("$name refreshes theme colors on invalidation", fixture => {
    const palette = countingTheme();
    const component = makeResult(fixture, palette.theme);
    expect(component.render(90).join("\n")).toContain("\x1b[31m");
    palette.change();
    component.invalidate?.();
    const updated = component.render(90).join("\n");
    expect(updated).toContain("\x1b[32m");
    expect(updated).not.toContain("\x1b[31m");
  });

  it("forwards invalidation to a composed result body", () => {
    let renders = 0;
    let invalidations = 0;
    vi.spyOn(memory, "renderRecallResult").mockImplementation(() => ({
      render: width => { renders++; return [`body ${width}`]; },
      invalidate: () => { invalidations++; },
    }));
    const component = makeResult(resultCases.find(fixture => fixture.name === "recall")!, {});
    const first = component.render(80);
    expect(component.render(80)).toBe(first);
    expect(renders).toBe(1);
    component.invalidate?.();
    expect(invalidations).toBe(1);
    expect(component.render(80)).toEqual(["body 80"]);
    expect(renders).toBe(2);
  });

  it("refreshes live run costs when calibration changes without invalidation", () => {
    let factor = 1;
    const palette = countingTheme();
    const formatRunCost = makeRunCostFormatter(() => ({ calibration: { status: "calibrated", factor } }));
    const component = renderSpiderResult(result({ run: { ...run, token_count: 100, usageCosts: [{ provider: "github-copilot", cost: 0.02 }] } }), {}, palette.theme, { args: { action: "run" }, formatRunCost });
    const first = component.render(90);
    expect(first.join("\n")).toContain("2.0 credits");
    const calls = palette.calls();
    expect(component.render(90)).toBe(first);
    expect(palette.calls()).toBe(calls);
    factor = 2;
    const updated = component.render(90);
    expect(updated).not.toBe(first);
    expect(updated.join("\n")).toContain("4.0 credits");
    expect(component.render(90)).toBe(updated);
  });

  it("computes 2000 mixed historical bodies only once across 50 frames", () => {
    const spies = (["renderTodoChecklist", "renderExecResult", "renderIndexResult", "renderMessageResult", "renderKillResult"] as const)
      .map(name => vi.spyOn(ui, name));
    const fixtures = ["todo", "exec", "index", "message", "kill"].map(name => resultCases.find(fixture => fixture.name === name)!);
    const components = Array.from({ length: 2000 }, (_, i) => makeResult(fixtures[i % fixtures.length], {}));
    for (let frame = 0; frame < 50; frame++) for (const component of components) component.render(80);
    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(2000);
  }, 2000);
});
