import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSpiderResult, renderCommandOutput, renderSubagentDone, renderEscalationMessage, renderOrganismEntry } from "../render-result";

const payload = "z".repeat(500);
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (s: string) => s, italic: (s: string) => s };
const check = (rows: string[], width: number) => {
  expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  expect((rows.join("").match(/z{2,}/g) ?? []).join("").length).toBe(500);
};

describe("expanded result path coverage", () => {
  it.each([
    ["exec_file", { stdout: payload, exitCode: 0 }, { path: "file" }],
    ["batch", [{ stdout: payload, exitCode: 0 }], { commands: [{ code: "print" }] }],
    ["fetch", { sources: [payload], count: 1 }, {}],
    ["kill", { requested: "all", killed: [{ runId: "id", name: payload, outcome: "killed", via: "pid" }] }, {}],
    ["remember", { status: "active", content: payload }, {}],
    ["import", { perSession: [{ sessionId: payload, status: "ok", candidates: 1, chunks: 1 }] }, {}],
    ["skill", [{ name: payload }], { op: "list" }],
    ["control", [{ category: "note", content: payload, uuid: "id" }], { sub: "pending" }],
    ["control", { dryRun: true, backupDir: payload }, { command: "migrate" }],
    ["control", { ok: true, path: payload }, { command: "bind" }],
    ["control", { ok: true, path: payload }, { command: "unbind" }],
    ["control", { nodes: [{ id: "a", label: payload, kind: "skill" }], edges: [], stats: { nodes: 1, edges: 0, linkedPct: 0 } }, { command: "insights" }],
    ["control", { catalog: [], defaults: { worker: payload }, sources: { worker: "global" }, global: { worker: payload } }, { command: "models" }],
    ["control", { tokenSavings: { indexedChunks: 0, estTokensSaved: 0 }, rowCounts: { [payload]: 1 }, models: [] }, { command: "stats" }],
    ["control", { ok: true, removed: { status: "archived" }, uuid: payload }, { command: "memory", sub: "forget" }],
    ["control", { uuid: payload }, { command: "memory", sub: "reject" }],
  ] as const)("%s expanded path retains its payload (%#)", (action, details, args) => {
    const rows = renderSpiderResult({ details }, { expanded: true }, theme, { args: { action, ...args } }).render(80);
    // Models defaults deliberately show the same ref twice: once in the default and once in the shadow reference.
    if (action === "fetch" || action === "control" && "catalog" in (details as object)) {
      expect((rows.join("").match(/z{2,}/g) ?? []).join("")).toBe(action === "fetch" ? payload + payload : payload);
      expect(rows.every((row) => visibleWidth(row) <= 80)).toBe(true);
    } else check(rows, 80);
  });

  it("boxed command and subagent notifications use the 78-column inner width", () => {
    const command = renderCommandOutput({ details: { args: { action: "message", to: "peer", message: payload }, result: { details: { delivered: true } } } }, { expanded: true }, theme);
    check(command.render(80), 80);
    const done = renderSubagentDone({ details: { status: "done", output: payload } }, { expanded: true }, theme);
    check(done.render(80), 80);
  });

  it("expanded escalation keeps the full run identifier", () => {
    const runId = "run-identifier-123456789";
    const lines = renderEscalationMessage({ details: { runId, severity: "warning", summary: "note" } }, { expanded: true }, theme).render(80);
    expect(lines.join("\n")).toContain(runId);
  });

  it("escalation and organism messages wrap long text in their boxes", () => {
    const escalation = renderEscalationMessage({ details: { runId: "id", severity: "warning", name: "agent", summary: payload } }, { expanded: true }, theme);
    check(escalation.render(80), 80);
    const report = { status: "partial", memoryStaged: 0, skillsStaged: 0, todosAdded: 0, errors: [{ phase: "store", message: payload }], modelCalls: 0, reason: "done", startedAt: 0, finishedAt: 1 };
    check(renderOrganismEntry({ data: report }, { expanded: true }, theme).render(80), 80);
  });
});
