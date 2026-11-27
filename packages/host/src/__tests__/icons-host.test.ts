import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSpiderCall, renderSpiderResult, renderSubagentDone, renderOrganismEntry, renderEscalationMessage } from "../render-result.js";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text };
const style = (iconStyle: "text" | "nerd") => ({ iconStyle });

function equalWidths(text: string[], nerd: string[]): void {
  expect(nerd.map(visibleWidth)).toEqual(text.map(visibleWidth));
}

describe("host icon rendering", () => {
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
    expect(text[0]).toContain("\u{1F578}\uFE0F spider");
    expect(nerd[0]).toContain("\u{F0BCA}  spider");
    equalWidths(text, nerd);
  });

  it("uses configured failure and task markers in a run result", () => {
    const result = { details: { run: { name: "scribe", agent: "worker", status: "failed", task: "read", result: "done" } } };
    const render = (iconStyle: "text" | "nerd") => renderSpiderResult(result, {}, theme, { args: { action: "run" }, iconStyle }).render(100);
    const text = render("text"), nerd = render("nerd");
    expect(text.join("\n")).toContain("❌ failed · scribe");
    expect(nerd.join("\n")).toContain("\u{F0156}  failed · scribe");
    expect(text.join("\n")).toContain("↳ read");
    expect(nerd.join("\n")).toContain("\u{F060D} read");
    expect(text).toContain("   done");
    expect(nerd).toContain("   done");
    equalWidths(text, nerd);
  });

  it("uses the message search icon and preserves the snippet", () => {
    const result = { details: [{ kind: "message", title: "hello", snippet: "Some snippet" }] };
    const render = (iconStyle: "text" | "nerd") => renderSpiderResult(result, {}, theme, { args: { action: "search" }, iconStyle }).render(100);
    const text = render("text"), nerd = render("nerd");
    expect(text.join("\n")).toContain("✉ hello");
    expect(nerd.join("\n")).toContain("\u{F01F0} hello");
    expect(nerd.join("\n")).toContain("\u{F060D} Some snippet");
    equalWidths(text, nerd);
  });

  it("uses failure and gutter markers in doctor and configuration results", () => {
    const render = (action: string, details: unknown, iconStyle: "text" | "nerd") =>
      renderSpiderResult({ details }, {}, theme, { args: { action: "control", command: action }, iconStyle }).render(100);
    const text = render("doctor", { ok: false, lines: ["- storage: unavailable"] }, "text");
    const nerd = render("doctor", { ok: false, lines: ["- storage: unavailable"] }, "nerd");
    expect(text.join("\n")).toContain("❌ issues found");
    expect(nerd.join("\n")).toContain("\u{F0156}  issues found");
    expect(nerd.join("\n")).toContain("\u{F060D} storage");
    equalWidths(text, nerd);
    for (const command of ["config", "models"]) {
      const a = render(command, { ok: false, error: "not available" }, "text");
      const b = render(command, { ok: false, error: "not available" }, "nerd");
      expect(a.join("\n")).toContain("❌ not available");
      expect(b.join("\n")).toContain("\u{F0156}  not available");
      equalWidths(a, b);
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
        expect(call).toContain(iconStyle === "text" ? "🕸️" : "\u{F0BCA}");
        expect(result).not.toMatch(/[🕸\u{F0BCA}\u{F167A}]/u);
      }
    }
  });

  it("uses configured markers in completion and warning notices", () => {
    const done = { details: { status: "cancelled", name: "scribe", output: "result" } };
    const text = renderSubagentDone(done, {}, theme, "text").render(100);
    const nerd = renderSubagentDone(done, {}, theme, "nerd").render(100);
    expect(text.join("\n")).toContain("⚠\uFE0F cancelled");
    expect(nerd.join("\n")).toContain("\u{F002A}  cancelled");
    expect(nerd.join("\n")).toContain("\u{F0BCA}  spider");
    equalWidths(text, nerd);
    const report = { data: { status: "failed", errors: [], memoryStaged: 0, skillsStaged: 0, todosAdded: 0 } };
    const a = renderOrganismEntry(report, {}, theme, "text").render(100);
    const b = renderOrganismEntry(report, {}, theme, "nerd").render(100);
    expect(a.join("\n")).toContain("❌ failed");
    expect(b.join("\n")).toContain("\u{F0156}  failed");
    equalWidths(a, b);
    const escalation = { details: { runId: "run-one", severity: "warning", summary: "attention" } };
    expect(renderEscalationMessage(escalation, {}, theme, "nerd").render(100).join("\n")).toContain("\u{F002A}");
  });
});
