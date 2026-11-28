import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderEscalation, type EscalationDetails } from "../escalation";
import type { RenderCtx } from "../types";

const run = { runId: "beb58fc6-193f-4247-bb38-c59612f6985d", agent: "worker", name: "tia-3" };
const theme: RenderCtx["theme"] = { fg: (_token, text) => text, bg: (_token, text) => text, bold: text => text, glyph: "🕸️" };

function render(severity: EscalationDetails["severity"], summary: string, width: number, expanded = false) {
  return renderEscalation({ ...run, severity, summary }, { theme, width, expanded });
}

describe("escalation status rows", () => {
  it.each([
    ["blocked", "× blocked"], ["question", "? question"], ["warning", "▲ warning"],
  ] as const)("shows a %s marker and starts the summary on the status row", (severity, status) => {
    expect(render(severity, "Check the release manifest.", 80)).toEqual([` ${status} · Check the release manifest.`]);
  });

  it("uses a non-error Nerd question icon and aligns wrapped text", () => {
    const styles: string[] = [];
    const styled = { ...theme, iconStyle: "nerd" as const, fg: (token: string, text: string) => { styles.push(token); return text; } };
    const rows = renderEscalation({ severity: "question", summary: "Question details that need a longer explanation" }, { theme: styled, width: 22, expanded: false });
    expect(rows[0]).toContain("\u{F02D6}  question");
    expect(rows.slice(1).every(row => row.startsWith("    "))).toBe(true);
    expect(styles).toContain("warning");
    expect(styles).not.toContain("error");
  });

  it("prints only the status for an empty summary", () => {
    expect(render("warning", "", 80)).toEqual([" ▲ warning"]);
  });

  it.each([20, 30, 80])("wraps the entire summary at width %i in both modes", width => {
    const summary = "The release manifest is missing some entries.\n\nCheck these paths before packaging: " + "界🙂".repeat(80);
    const rows = render("warning", summary, width);
    expect(rows).toEqual(render("warning", summary, width, true));
    expect(rows[0]).toMatch(/^ ▲ warning · /u);
    expect(rows.slice(1).every(row => row.startsWith("   "))).toBe(true);
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
    const body = rows.join("\n").replace(/^ ▲ warning · /u, "");
    expect(body.replace(/\s+/gu, "")).toBe(summary.replace(/\s+/gu, ""));
    expect(rows.join("\n")).not.toContain(run.runId.slice(0, 8));
  });
});
