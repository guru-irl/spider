import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSpiderCall, renderSpiderResult, renderSubagentDone, renderOrganismEntry, renderEscalationMessage } from "../render-result.js";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text };
const style = (iconStyle: "text" | "nerd") => ({ iconStyle });

function expectFits(text: string[], nerd: string[]): void {
  for (const line of [...text, ...nerd]) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
}

function expectWidthDelta(text: string[], nerd: string[], content: string, delta: number): void {
  const textRow = text.find(line => line.includes(content));
  const nerdRow = nerd.find(line => line.includes(content));
  expect(textRow, `text row containing ${content}`).toBeDefined();
  expect(nerdRow, `nerd row containing ${content}`).toBeDefined();
  expect(visibleWidth(nerdRow!.trimEnd()) - visibleWidth(textRow!.trimEnd()), content).toBe(delta);
}

describe("host icon rendering", () => {
  it("italicizes only agent roles in model default confirmations", () => {
    const marked = { ...theme, italic: (value: string) => `<i>${value}</i>` };
    for (const [role, label] of [["worker", "<i>worker</i>"], ["watcher", "<i>watcher</i>"], ["digest", "digest"], ["self_name", "self_name"], ["upstream_watch", "upstream_watch"]] as const) {
      const output = renderSpiderResult({ details: { ok: true, role, ref: "p/m" } }, {}, marked, { args: { action: "control", command: "models", op: "set" } }).render(100).join("\n");
      expect(output).toContain(`set ${label} → p/m`);
    }
  });
  it("keeps the skill list and curator headings, and their fallback glyphs, off the card", () => {
    const rows = [{ name: "brainstorming", source: "bundled", state: "active", status: "ok", useCount: 2, tier: "global" }];
    const curate = { toStale: [], toArchived: [], skipped: [] };
    for (const iconStyle of ["text", "nerd"] as const) {
      const list = renderSpiderResult({ details: rows }, {}, theme, { args: { action: "skill", op: "list" }, iconStyle }).render(100).join("\n");
      const curator = renderSpiderResult({ details: curate }, {}, theme, { args: { action: "control", command: "skill", sub: "curate" }, iconStyle }).render(100).join("\n");
      expect(list).toContain("- brainstorming (bundled, active, ok, use=2)");
      expect(curator).toContain("- stale: 0");
      for (const card of [list, curator]) {
        expect(card).not.toContain("🕸");
        expect(card).not.toContain("🧹");
        expect(card).not.toContain("## ");
      }
    }
  });

  it("uses the spider icon in the tool call", () => {
    const args = { action: "run" };
    const text = renderSpiderCall(args, theme, style("text")).render(100);
    const nerd = renderSpiderCall(args, theme, style("nerd")).render(100);
    expect(text[0]).toContain("◆ run");
    expect(nerd[0]).toContain("\u{F0BCA}  run");
    expectWidthDelta(text, nerd, "run", 1);
    expectFits(text, nerd);
  });

  it("uses configured failure, task and result markers in a run result", () => {
    const result = { details: { run: { name: "scribe", agent: "worker", status: "failed", task: "read", result: "done" } } };
    const render = (iconStyle: "text" | "nerd") => renderSpiderResult(result, {}, theme, { args: { action: "run" }, iconStyle }).render(100);
    const text = render("text"), nerd = render("nerd");
    expect(text.join("\n")).toContain("× failed · scribe");
    expect(nerd.join("\n")).toContain("\u{F0156}  failed · scribe");
    expect(text.join("\n")).toContain("→ read");
    expect(nerd.join("\n")).toContain("\u{F060D}  read");
    expect(text).toContain("   ↑ done");
    expect(nerd).toContain("   \u{F005C}  done");
    expectWidthDelta(text, nerd, "failed · scribe", 1);
    expectWidthDelta(text, nerd, "read", 1);
    expectWidthDelta(text, nerd, "done", 1);
    expectFits(text, nerd);
  });

  it("uses the message search icon and preserves the snippet", () => {
    const result = { details: [{ kind: "message", title: "hello", snippet: "Some snippet" }] };
    const render = (iconStyle: "text" | "nerd") => renderSpiderResult(result, {}, theme, { args: { action: "search" }, iconStyle }).render(100);
    const text = render("text"), nerd = render("nerd");
    expect(text.join("\n")).toContain("→ hello");
    expect(nerd.join("\n")).toContain("\u{F01F0}  hello");
    expect(nerd.join("\n")).toContain("    Some snippet");
    expectWidthDelta(text, nerd, "hello", 1);
    expectWidthDelta(text, nerd, "Some snippet", 1);
    expectFits(text, nerd);
  });

  it("uses failure markers and aligned detail rows in doctor and configuration results", () => {
    const render = (action: string, details: unknown, iconStyle: "text" | "nerd") =>
      renderSpiderResult({ details }, {}, theme, { args: { action: "control", command: action }, iconStyle }).render(100);
    const text = render("doctor", { ok: false, lines: ["- storage: unavailable"] }, "text");
    const nerd = render("doctor", { ok: false, lines: ["- storage: unavailable"] }, "nerd");
    expect(text.join("\n")).toContain("× issues found");
    expect(nerd.join("\n")).toContain("\u{F0156}  issues found");
    expect(nerd.join("\n")).toContain("    storage");
    expectWidthDelta(text, nerd, "issues found", 1);
    expectWidthDelta(text, nerd, "storage", 1);
    expectFits(text, nerd);
    for (const command of ["config", "models"]) {
      const a = render(command, { ok: false, error: "not available" }, "text");
      const b = render(command, { ok: false, error: "not available" }, "nerd");
      expect(a.join("\n")).toContain("× not available");
      expect(b.join("\n")).toContain("\u{F0156}  not available");
      expectWidthDelta(a, b, "not available", 1);
      expectFits(a, b);
    }
  });

  it("keeps the spider marker only in the import and pending-memory titles", () => {
    for (const [args, details] of [
      [{ action: "import" }, { imported: 0, skipped: 0, staged: 0, committed: 0 }],
      [{ action: "control", command: "memory", sub: "pending" }, []],
    ] as const) {
      for (const iconStyle of ["text", "nerd"] as const) {
        const call = renderSpiderCall(args, theme, { iconStyle }).render(100).join("\n");
        const result = renderSpiderResult({ details }, {}, theme, { args, iconStyle }).render(100).join("\n");
        expect(call).toContain(iconStyle === "text" ? "◆" : "\u{F0BCA}");
        expect(result).not.toMatch(/[◆\u{F0BCA}\u{F167A}]/u);
      }
    }
  });

  it("uses configured markers in completion and warning notices", () => {
    const done = { details: { status: "cancelled", name: "scribe", output: "result" } };
    const text = renderSubagentDone(done, {}, theme, "text").render(100);
    const nerd = renderSubagentDone(done, {}, theme, "nerd").render(100);
    expect(text.join("\n")).toContain("▲ cancelled");
    expect(nerd.join("\n")).toContain("\u{F002A}  cancelled");
    expect(nerd.join("\n")).toContain("\u{F0BCA}  run");
    expectWidthDelta(text, nerd, "cancelled", 1);
    expectWidthDelta(text, nerd, "run", 1);
    expectFits(text, nerd);
    const report = { data: { status: "failed", errors: [], memoryStaged: 0, skillsStaged: 0, todosAdded: 0 } };
    const a = renderOrganismEntry(report, {}, theme, "text").render(100);
    const b = renderOrganismEntry(report, {}, theme, "nerd").render(100);
    expect(a.join("\n")).toContain("× failed");
    expect(b.join("\n")).toContain("\u{F0156}  failed");
    expectWidthDelta(a, b, "failed", 1);
    expectFits(a, b);
    const escalation = { details: { runId: "run-one", severity: "warning", summary: "attention" } };
    expect(renderEscalationMessage(escalation, {}, theme, "nerd").render(100).join("\n")).toContain("\u{F002A}");
  });
});
